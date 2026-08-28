import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Long-side cap for page-1 JPEG sent to qwen (avoid huge raster scans). */
export const PDF_PAGE_JPEG_SCALE_TO = 1600;

export interface PdfPageJpegResult {
  jpegPath: string;
  tempDir: string;
  jpegBytes: number;
}

/**
 * Rasterize PDF page 1 to JPEG in a temp dir (original on RO share is untouched).
 * Prefers poppler pdftoppm; falls back to ImageMagick when pdftoppm is unavailable.
 */
export async function rasterizePdfFirstPageToJpeg(
  pdfPath: string,
  scaleTo: number = PDF_PAGE_JPEG_SCALE_TO,
): Promise<PdfPageJpegResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "synology-pdf-page-jpeg-"));
  const stem = basename(pdfPath).replace(/\.pdf$/i, "") || "document";
  const outputPrefix = join(tempDir, stem);
  const jpegPath = `${outputPrefix}.jpg`;

  try {
    await execFileAsync("pdftoppm", [
      "-jpeg",
      "-singlefile",
      "-f",
      "1",
      "-l",
      "1",
      "-scale-to",
      String(scaleTo),
      pdfPath,
      outputPrefix,
    ]);
  } catch {
    await execFileAsync("magick", [
      "-density",
      "150",
      `${pdfPath}[0]`,
      "-resize",
      `${scaleTo}x${scaleTo}>`,
      jpegPath,
    ]);
  }

  const { size } = await stat(jpegPath);
  return { jpegPath, tempDir, jpegBytes: size };
}

export async function cleanupPdfPageJpegTemp(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}
