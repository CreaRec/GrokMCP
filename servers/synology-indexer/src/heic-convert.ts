import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HeicConversionResult {
  jpegPath: string;
  tempDir: string;
}

/** Convert HEIC to JPEG in a temp dir (original on RO share is untouched). */
export async function convertHeicToJpeg(heicPath: string): Promise<HeicConversionResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "synology-heic-"));
  const stem = basename(heicPath).replace(/\.heic$/i, "");
  const jpegPath = join(tempDir, `${stem}.jpg`);

  try {
    await execFileAsync("heif-convert", [heicPath, jpegPath]);
  } catch {
    await execFileAsync("magick", [heicPath, jpegPath]);
  }

  return { jpegPath, tempDir };
}

export async function cleanupHeicTemp(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}
