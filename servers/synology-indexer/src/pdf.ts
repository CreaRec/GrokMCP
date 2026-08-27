import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * PDF page budgets (documented for operators):
 * - Text extract: first PDF_TEXT_MAX_PAGES pages via pdftotext
 * - Vision fallback (scans): first PDF_VISION_MAX_PAGES pages via pdftoppm → jpeg
 * Never base64 the raw PDF file into Ollama `images[]`.
 */
export const PDF_TEXT_MAX_PAGES = 25;
export const PDF_VISION_MAX_PAGES = 4;
/** pdftoppm DPI for scan fallback pages. */
export const PDF_RASTER_DPI = 120;
/** Minimum alphanumeric chars after cleanup to treat PDF as digital text. */
export const PDF_MIN_USABLE_TEXT_CHARS = 40;

export interface PdfTextExtractor {
  (filePath: string, maxPages?: number): Promise<string>;
}

export interface PdfPageRasterizer {
  (filePath: string, maxPages?: number): Promise<Buffer[]>;
}

export async function extractPdfText(
  filePath: string,
  maxPages: number = PDF_TEXT_MAX_PAGES,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "pdftotext",
    ["-layout", "-f", "1", "-l", String(maxPages), filePath, "-"],
    {
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    },
  );
  return stdout;
}

/**
 * True when extracted text looks like real digital content (not empty/scan OCR void).
 * Scanned PDFs typically yield empty or near-empty pdftotext output.
 */
export function hasUsablePdfText(text: string): boolean {
  const cleaned = text.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length < PDF_MIN_USABLE_TEXT_CHARS) {
    return false;
  }
  const alnum = cleaned.replace(/[^0-9A-Za-z]/g, "");
  return alnum.length >= PDF_MIN_USABLE_TEXT_CHARS;
}

export async function rasterizePdfPages(
  filePath: string,
  maxPages: number = PDF_VISION_MAX_PAGES,
): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), "syno-pdf-"));
  try {
    const prefix = join(dir, "page");
    await execFileAsync(
      "pdftoppm",
      [
        "-jpeg",
        "-f",
        "1",
        "-l",
        String(maxPages),
        "-r",
        String(PDF_RASTER_DPI),
        filePath,
        prefix,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );

    const names = (await readdir(dir))
      .filter((n) => n.startsWith("page") && n.endsWith(".jpg"))
      .sort();

    const pages: Buffer[] = [];
    for (const name of names.slice(0, maxPages)) {
      pages.push(await readFile(join(dir, name)));
    }
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function labelFromPdfText(text: string, fallbackName: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? fallbackName;
  if (line.length <= 100) return line;
  return line.slice(0, 97) + "...";
}

export function descriptionFromPdfText(text: string, maxChars: number = 2500): string {
  const cleaned = text.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars - 3) + "...";
}
