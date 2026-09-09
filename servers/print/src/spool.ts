import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { PrintConfig } from "./config.js";

export const ALLOWED_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg"]);

export interface ResolvePrintSourceInput {
  path?: string;
  url?: string;
  contentBase64?: string;
  filename?: string;
}

export interface ResolvedPrintFile {
  filePath: string;
  cleanup: boolean;
}

function extensionOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function assertAllowedExtension(filePath: string): void {
  const ext = extensionOf(filePath);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file type "${ext || "(none)"}"; allowed: pdf, png, jpg, jpeg`,
    );
  }
}

/**
 * Ensure `candidate` resolves to a real path under `spoolRoot` (path jail).
 * Rejects traversal (`..`), relative paths, and files outside the spool.
 */
export function resolveSpoolPath(spoolRoot: string, candidate: string): string {
  if (!candidate || !candidate.trim()) {
    throw new Error("path is required");
  }
  const trimmed = candidate.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error("path must be an absolute path under the print spool directory");
  }

  const rootResolved = path.resolve(spoolRoot);
  const fileResolved = path.resolve(trimmed);
  const relative = path.relative(rootResolved, fileResolved);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative === ""
  ) {
    throw new Error(
      `path must be under PRINT_SPOOL_DIR (${rootResolved}); got ${fileResolved}`,
    );
  }
  return fileResolved;
}

export async function ensureSpoolDir(spoolRoot: string): Promise<string> {
  const root = path.resolve(spoolRoot);
  await mkdir(root, { recursive: true });
  return root;
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-]+/g, "_");
  if (!base || base === "." || base === "..") {
    throw new Error("Invalid filename");
  }
  assertAllowedExtension(base);
  return base;
}

function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const base = path.basename(pathname);
    if (base && ALLOWED_EXTENSIONS.has(extensionOf(base))) {
      return sanitizeFilename(base);
    }
  } catch {
    // fall through
  }
  return "download.pdf";
}

export async function materializeBase64(
  spoolRoot: string,
  contentBase64: string,
  filename?: string,
): Promise<ResolvedPrintFile> {
  const root = await ensureSpoolDir(spoolRoot);
  const safeName = sanitizeFilename(filename ?? "upload.pdf");
  const dir = await mkdtemp(path.join(root, "upload-"));
  const filePath = path.join(dir, safeName);
  const buffer = Buffer.from(contentBase64, "base64");
  if (buffer.length === 0) {
    throw new Error("contentBase64 decoded to empty content");
  }
  await writeFile(filePath, buffer);
  return { filePath, cleanup: true };
}

export async function downloadToSpool(
  config: PrintConfig,
  url: string,
  filename?: string,
): Promise<ResolvedPrintFile> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must be http or https");
  }

  const root = await ensureSpoolDir(config.printSpoolDir);
  const safeName = sanitizeFilename(filename ?? filenameFromUrl(url));
  const dir = await mkdtemp(path.join(root, "download-"));
  const filePath = path.join(dir, safeName);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.downloadTimeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Failed to download url: HTTP ${response.status}`);
    }
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader) {
      const length = Number.parseInt(lengthHeader, 10);
      if (Number.isFinite(length) && length > config.maxDownloadBytes) {
        throw new Error(
          `Remote file exceeds PRINT_MAX_DOWNLOAD_BYTES (${config.maxDownloadBytes})`,
        );
      }
    }
    if (!response.body) {
      throw new Error("Download response had no body");
    }

    const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    let written = 0;
    nodeStream.on("data", (chunk: Buffer | string) => {
      written += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (written > config.maxDownloadBytes) {
        controller.abort();
        nodeStream.destroy(
          new Error(
            `Remote file exceeds PRINT_MAX_DOWNLOAD_BYTES (${config.maxDownloadBytes})`,
          ),
        );
      }
    });

    await pipeline(nodeStream, createWriteStream(filePath));
    return { filePath, cleanup: true };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolvePrintSource(
  config: PrintConfig,
  input: ResolvePrintSourceInput,
): Promise<ResolvedPrintFile> {
  const provided = [input.path, input.url, input.contentBase64].filter(
    (v) => v !== undefined && v !== "",
  );
  if (provided.length !== 1) {
    throw new Error("Provide exactly one of: path, url, contentBase64");
  }

  if (input.path) {
    const filePath = resolveSpoolPath(config.printSpoolDir, input.path);
    assertAllowedExtension(filePath);
    await access(filePath);
    return { filePath, cleanup: false };
  }

  if (input.url) {
    return downloadToSpool(config, input.url, input.filename);
  }

  return materializeBase64(
    config.printSpoolDir,
    input.contentBase64!,
    input.filename,
  );
}
