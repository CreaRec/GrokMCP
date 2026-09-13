import { access, mkdir, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PrintConfig } from "./config.js";
import { defaultRunCommand, type RunCommand } from "./cups.js";
import {
  ensureSpoolDir,
  needsPdfConversion,
  type ResolvedPrintFile,
} from "./spool.js";

const CONVERT_TIMEOUT_MS = 120_000;
/** How long to wait for the PDF to appear after soffice exits 0. */
const DEFAULT_PDF_APPEAR_TIMEOUT_MS = 5_000;
const DEFAULT_PDF_POLL_INTERVAL_MS = 50;
/** Consecutive identical non-zero sizes before treating the PDF as fully written. */
const PDF_STABLE_CHECKS = 2;
const OUTPUT_TRUNCATE = 500;
const LO_PROFILE_DIRNAME = "lo-profile";

/** OOXML/ODF containers are ZIP files; tiny or non-PK payloads are usually truncated uploads. */
const ZIP_OFFICE_EXTENSIONS = new Set([".docx", ".odt"]);
const MIN_ZIP_OFFICE_BYTES = 64;

function pdfAppearTimeoutMs(): number {
  const raw = process.env.PRINT_CONVERT_PDF_WAIT_MS;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return DEFAULT_PDF_APPEAR_TIMEOUT_MS;
}

function pdfPollIntervalMs(): number {
  const raw = process.env.PRINT_CONVERT_PDF_POLL_MS;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return DEFAULT_PDF_POLL_INTERVAL_MS;
}

/**
 * Ensure the resolved file is print-ready for CUPS/lp.
 * PDF/PNG/JPG pass through unchanged. Office/text inputs are converted to PDF
 * with LibreOffice headless (`soffice --convert-to pdf`).
 *
 * Cleanup:
 * - upload-/download- sources: PDF is written into the same temp dir
 * - path= sources: PDF lands in a new convert-* dir (original left intact)
 */
export async function preparePrintReadyFile(
  config: PrintConfig,
  resolved: ResolvedPrintFile,
  run: RunCommand = defaultRunCommand,
): Promise<ResolvedPrintFile> {
  if (!needsPdfConversion(resolved.filePath)) {
    return resolved;
  }

  const root = await ensureSpoolDir(config.printSpoolDir);
  let outDir: string;
  let cleanup: boolean;
  let cleanupDir: string | undefined;
  let createdConvertDir = false;

  if (resolved.cleanup && resolved.cleanupDir) {
    outDir = resolved.cleanupDir;
    cleanup = true;
    cleanupDir = resolved.cleanupDir;
  } else {
    outDir = await mkdtemp(path.join(root, "convert-"));
    cleanup = true;
    cleanupDir = outDir;
    createdConvertDir = true;
  }

  try {
    const pdfPath = await convertWithLibreOffice(resolved.filePath, outDir, run);
    return { filePath: pdfPath, cleanup, cleanupDir };
  } catch (err) {
    if (createdConvertDir && cleanupDir) {
      await rm(cleanupDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }
}


/**
 * Cheap pre-flight for convertible inputs before spawning soffice.
 * docx/odt must look like a ZIP (PK…); empty/tiny buffers fail fast with a
 * clear truncated-payload error (common when contentBase64 was cut off).
 */
async function assertConvertiblePayload(sourcePath: string): Promise<void> {
  const basename = path.basename(sourcePath);
  const ext = path.extname(sourcePath).toLowerCase();
  const { size } = await stat(sourcePath);

  if (size <= 0) {
    throw new Error(
      `contentBase64 looks truncated or invalid for "${basename}" (empty file)`,
    );
  }

  if (!ZIP_OFFICE_EXTENSIONS.has(ext)) {
    return;
  }

  if (size < MIN_ZIP_OFFICE_BYTES) {
    throw new Error(
      `contentBase64 looks truncated or invalid for "${basename}" ` +
        `(expected ZIP/Office document; got ${size} bytes)`,
    );
  }

  const handle = await open(sourcePath, "r");
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await handle.read(header, 0, 2, 0);
    if (bytesRead < 2 || header[0] !== 0x50 || header[1] !== 0x4b) {
      throw new Error(
        `contentBase64 looks truncated or invalid for "${basename}" ` +
          `(expected ZIP/PK header for ${ext}; got ${size} bytes)`,
      );
    }
  } finally {
    await handle.close();
  }
}

async function convertWithLibreOffice(
  sourcePath: string,
  outDir: string,
  run: RunCommand,
): Promise<string> {
  await access(sourcePath);
  await assertConvertiblePayload(sourcePath);

  const basename = path.basename(sourcePath);
  const profileDir = path.join(outDir, LO_PROFILE_DIRNAME);
  await mkdir(profileDir, { recursive: true });
  const userInstallation = pathToFileURL(profileDir).href;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || "/tmp",
    // Headless VCL; avoids needing a display in the container.
    SAL_USE_VCLPLUGIN: process.env.SAL_USE_VCLPLUGIN || "svp",
  };

  // -env:UserInstallation must come before other soffice options so each job
  // gets an isolated profile (avoids lock races on the default HOME profile).
  const args = [
    `-env:UserInstallation=${userInstallation}`,
    "--headless",
    "--nologo",
    "--nofirststartwizard",
    "--norestore",
    "--convert-to",
    "pdf",
    "--outdir",
    outDir,
    sourcePath,
  ];

  console.error(
    `[print:convert] start soffice → pdf for "${basename}" ` +
      `(outdir=${outDir}; UserInstallation=${userInstallation})`,
  );

  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await runWithTimeout("soffice", args, env, CONVERT_TIMEOUT_MS, run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[print:convert] failure for "${basename}": ${message}`);
    if (/ENOENT|not found/i.test(message)) {
      throw new Error(
        "LibreOffice (soffice) is not installed; cannot convert office/text files to PDF. " +
          "Rebuild the print image with libreoffice-writer-nogui (see servers/print/Dockerfile).",
      );
    }
    throw new Error(`LibreOffice conversion failed: ${message}`);
  }

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim();
    console.error(
      `[print:convert] soffice exit ${result.code} for "${basename}": ${truncateOutput(detail)}`,
    );
    throw new Error(
      `LibreOffice failed to convert "${basename}" to PDF: ${detail}`,
    );
  }

  console.error(
    `[print:convert] soffice exit 0 for "${basename}"; waiting for PDF in ${outDir}`,
  );

  const expectedPdf = path.join(
    outDir,
    `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`,
  );

  const pdfPath = await waitForConvertedPdf(outDir, expectedPdf);
  if (!pdfPath) {
    const stdout = truncateOutput(result.stdout);
    const stderr = truncateOutput(result.stderr);
    const detail =
      stdout || stderr
        ? ` (stdout: ${stdout || "(empty)"}; stderr: ${stderr || "(empty)"})`
        : " (stdout/stderr empty)";
    console.error(
      `[print:convert] no PDF after exit 0 for "${basename}"${detail}`,
    );
    throw new Error(
      `LibreOffice reported success but no PDF was produced for "${basename}"${detail}`,
    );
  }

  console.error(`[print:convert] success "${basename}" → ${pdfPath}`);
  return pdfPath;
}

/**
 * soffice can exit 0 before the PDF is fully flushed. Poll briefly for the
 * expected name (or any .pdf in outDir), waiting for a non-zero stable size.
 */
async function waitForConvertedPdf(
  outDir: string,
  expectedPdf: string,
): Promise<string | undefined> {
  const deadline = Date.now() + pdfAppearTimeoutMs();
  const pollMs = pdfPollIntervalMs();
  let lastPath: string | undefined;
  let lastSize = -1;
  let stableCount = 0;

  for (;;) {
    const candidate = await findConvertedPdf(outDir, expectedPdf);
    if (candidate) {
      try {
        const { size } = await stat(candidate);
        if (size > 0) {
          if (candidate === lastPath && size === lastSize) {
            stableCount += 1;
            if (stableCount >= PDF_STABLE_CHECKS) {
              return candidate;
            }
          } else {
            lastPath = candidate;
            lastSize = size;
            stableCount = 1;
          }
        }
      } catch {
        // File disappeared between readdir and stat; keep polling.
        lastPath = undefined;
        lastSize = -1;
        stableCount = 0;
      }
    }

    if (Date.now() >= deadline) {
      break;
    }
    await sleep(pollMs);
  }

  // Accept a non-empty PDF even if size never fully stabilized within the window.
  if (lastPath && lastSize > 0) {
    try {
      const { size } = await stat(lastPath);
      if (size > 0) return lastPath;
    } catch {
      // fall through
    }
  }
  return findConvertedPdf(outDir, expectedPdf);
}

async function findConvertedPdf(
  outDir: string,
  expectedPdf: string,
): Promise<string | undefined> {
  try {
    await access(expectedPdf);
    return expectedPdf;
  } catch {
    // LibreOffice sometimes normalizes the output name; pick a produced PDF.
  }

  const entries = await readdir(outDir);
  const pdfs = entries.filter((name) => name.toLowerCase().endsWith(".pdf"));
  if (pdfs.length === 0) return undefined;
  pdfs.sort();
  return path.join(outDir, pdfs[pdfs.length - 1]!);
}

function truncateOutput(text: string, max = OUTPUT_TRUNCATE): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithTimeout(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  run: RunCommand,
): Promise<{ stdout: string; stderr: string; code: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(command, args, env),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`LibreOffice conversion timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
