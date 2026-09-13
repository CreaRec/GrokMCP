import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { PrintConfig } from "./config.js";
import { defaultRunCommand, type RunCommand } from "./cups.js";
import {
  ensureSpoolDir,
  needsPdfConversion,
  type ResolvedPrintFile,
} from "./spool.js";

const CONVERT_TIMEOUT_MS = 120_000;

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

async function convertWithLibreOffice(
  sourcePath: string,
  outDir: string,
  run: RunCommand,
): Promise<string> {
  await access(sourcePath);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || "/tmp",
    // Headless VCL; avoids needing a display in the container.
    SAL_USE_VCLPLUGIN: process.env.SAL_USE_VCLPLUGIN || "svp",
  };

  const args = [
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

  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await runWithTimeout("soffice", args, env, CONVERT_TIMEOUT_MS, run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
    throw new Error(
      `LibreOffice failed to convert "${path.basename(sourcePath)}" to PDF: ${detail}`,
    );
  }

  const expectedPdf = path.join(
    outDir,
    `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`,
  );
  try {
    await access(expectedPdf);
    return expectedPdf;
  } catch {
    // LibreOffice sometimes normalizes the output name; pick a produced PDF.
  }

  const entries = await readdir(outDir);
  const pdfs = entries.filter((name) => name.toLowerCase().endsWith(".pdf"));
  if (pdfs.length === 0) {
    throw new Error(
      `LibreOffice reported success but no PDF was produced for "${path.basename(sourcePath)}"`,
    );
  }
  pdfs.sort();
  return path.join(outDir, pdfs[pdfs.length - 1]!);
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
