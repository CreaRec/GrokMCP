import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";

/** Default last page (inclusive) when endPage is missing/invalid — keep in sync with docling-client. */
export const DEFAULT_PDF_GIST_PAGE_END = 5;

export interface PdfGistPrepareResult {
  /** Path to upload to Docling (temp gist PDF or original). */
  filePath: string;
  /** Temp dir to delete in finally; null when slice was skipped. */
  tempDir: string | null;
  /** True when a temp gist PDF was written. */
  sliced: boolean;
}

function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** True when path looks like a PDF (case-insensitive). */
export function isPdfPath(filePath: string): boolean {
  return extname(filePath).toLowerCase() === ".pdf";
}

/**
 * Clamp gist end page to a positive integer (default 5).
 * Start is always page 1.
 */
export function clampGistPageEnd(endPage?: number): number {
  if (endPage === undefined || !Number.isFinite(endPage) || endPage <= 0) {
    return DEFAULT_PDF_GIST_PAGE_END;
  }
  return Math.floor(endPage);
}

/** Page count via `qpdf --show-npages` (reads trailer only; does not rewrite). */
export async function getPdfPageCount(srcPath: string): Promise<number> {
  const { stdout } = await execFileAsync("qpdf", ["--show-npages", srcPath]);
  const n = parseInt(String(stdout).trim(), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`qpdf --show-npages returned invalid count: ${JSON.stringify(stdout)}`);
  }
  return n;
}

/**
 * Lossless extract of pages 1..endPage into destPath (never writes to the RO mount).
 * Uses qpdf --pages; if the PDF has fewer pages, qpdf emits what exists.
 */
export async function slicePdfToGist(
  srcPath: string,
  destPath: string,
  endPage: number = DEFAULT_PDF_GIST_PAGE_END,
): Promise<void> {
  const end = clampGistPageEnd(endPage);
  // qpdf: copy pages 1-N from src into a new file (dest must not be on the CIFS mount).
  await execFileAsync("qpdf", [srcPath, "--pages", ".", `1-${end}`, "--", destPath]);
}

/**
 * For PDFs longer than the gist window, write pages 1..N to a temp file.
 * Skips slice when not a PDF or when the file already has ≤ N pages.
 * Caller must cleanupPdfGistTemp(tempDir) in finally when tempDir is set.
 */
export async function preparePdfGistForDocling(
  srcPath: string,
  endPage: number = DEFAULT_PDF_GIST_PAGE_END,
): Promise<PdfGistPrepareResult> {
  if (!isPdfPath(srcPath)) {
    return { filePath: srcPath, tempDir: null, sliced: false };
  }

  const end = clampGistPageEnd(endPage);
  let pageCount: number;
  try {
    pageCount = await getPdfPageCount(srcPath);
  } catch {
    // Metadata failed — still try a bounded slice so Docling never sees the full blob.
    pageCount = end + 1;
  }

  if (pageCount <= end) {
    return { filePath: srcPath, tempDir: null, sliced: false };
  }

  const tempDir = await mkdtemp(join(tmpdir(), "synology-pdf-gist-"));
  const stem = basename(srcPath).replace(/\.pdf$/i, "") || "document";
  const destPath = join(tempDir, `${stem}.gist-1-${end}.pdf`);

  try {
    await slicePdfToGist(srcPath, destPath, end);
  } catch (err) {
    await cleanupPdfGistTemp(tempDir);
    throw err;
  }

  return { filePath: destPath, tempDir, sliced: true };
}

export async function cleanupPdfGistTemp(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}
