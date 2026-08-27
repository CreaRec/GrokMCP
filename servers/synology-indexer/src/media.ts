import { basename, extname } from "node:path";

/**
 * Media routing for the indexer content pipeline.
 *
 * - raster: send resized image bytes to the VLM (qwen2.5vl)
 * - pdf: extract digital text first; rasterize pages only if text is empty/scan
 * - skip: never call vision; clear dirty so nightly GPU does not retry
 */
export type MediaKind = "raster" | "pdf" | "skip";

/** Raster formats Ollama VLMs accept after encode (jpeg/png/webp/gif-like). */
const RASTER_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
]);

export function fileExtension(nameOrPath: string): string {
  const base = basename(nameOrPath);
  return extname(base).toLowerCase();
}

export function classifyMedia(nameOrPath: string): MediaKind {
  const ext = fileExtension(nameOrPath);
  if (ext === ".pdf") return "pdf";
  if (RASTER_EXTENSIONS.has(ext)) return "raster";
  return "skip";
}

/** True when the file may need GPU vision or PDF text→embed work. */
export function isContentIndexable(nameOrPath: string): boolean {
  const kind = classifyMedia(nameOrPath);
  return kind === "raster" || kind === "pdf";
}
