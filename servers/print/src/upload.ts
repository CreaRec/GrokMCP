import { timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import type { Request, Response } from "express";
import type { PrintConfig } from "./config.js";
import { getConfig } from "./config.js";
import { preparePrintReadyFile } from "./convert.js";
import {
  printFile,
  type DuplexMode,
  type PrintFileOptions,
  type PrintResult,
} from "./cups.js";
import {
  cleanupResolvedPrintFile,
  createUploadSpoolTarget,
  type ResolvedPrintFile,
} from "./spool.js";

const DUPLEX_VALUES = new Set<DuplexMode>([
  "one-sided",
  "two-sided-long-edge",
  "two-sided-short-edge",
]);

export const PRINT_UPLOAD_PATH = "/print/upload";

export interface UploadPrintOptions {
  printer?: string;
  copies?: number;
  sides?: DuplexMode;
  filename?: string;
}

export interface UploadHandlerDeps {
  getConfig?: () => PrintConfig;
  prepare?: typeof preparePrintReadyFile;
  print?: typeof printFile;
}

export class UploadHttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "UploadHttpError";
  }
}

function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Extract bearer / X-Print-Token from the request (if present). */
export function extractUploadToken(req: IncomingMessage): string | undefined {
  const xToken = headerValue(req.headers["x-print-token"])?.trim();
  if (xToken) return xToken;

  const auth = headerValue(req.headers.authorization)?.trim();
  if (!auth) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match?.[1]?.trim() || undefined;
}

function tokensEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) {
    // Constant-time-ish dead compare to avoid leaking expected length via early return alone.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * When `PRINT_UPLOAD_TOKEN` is set, require a matching Bearer or X-Print-Token.
 * When unset, uploads are allowed (same trust model as `/mcp` today).
 */
export function assertUploadAuthorized(
  req: IncomingMessage,
  expectedToken: string | undefined,
): void {
  if (!expectedToken) return;
  const provided = extractUploadToken(req);
  if (!provided || !tokensEqual(expectedToken, provided)) {
    throw new UploadHttpError("Unauthorized: missing or invalid upload token", 401);
  }
}

export function parseCopiesField(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new UploadHttpError("copies must be an integer between 1 and 100", 400);
  }
  return value;
}

export function parseDuplexField(raw: string | undefined): DuplexMode | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim() as DuplexMode;
  if (!DUPLEX_VALUES.has(value)) {
    throw new UploadHttpError(
      `Invalid sides/duplex value (allowed: ${[...DUPLEX_VALUES].join(", ")})`,
      400,
    );
  }
  return value;
}

/** Merge query + form fields (form wins for overlapping keys). */
export function parseUploadPrintOptions(
  query: Record<string, unknown>,
  fields: Record<string, string> = {},
): UploadPrintOptions {
  const pick = (key: string): string | undefined => {
    if (fields[key] !== undefined && fields[key] !== "") return fields[key];
    const q = query[key];
    if (typeof q === "string") return q;
    if (Array.isArray(q) && typeof q[0] === "string") return q[0];
    return undefined;
  };

  const printer = pick("printer")?.trim() || undefined;
  const copies = parseCopiesField(pick("copies"));
  const sides = parseDuplexField(pick("sides") ?? pick("duplex"));
  const filename = pick("filename")?.trim() || undefined;
  return { printer, copies, sides, filename };
}

function contentTypeOf(req: IncomingMessage): string {
  return (headerValue(req.headers["content-type"]) || "").toLowerCase();
}

function isMultipart(req: IncomingMessage): boolean {
  return contentTypeOf(req).includes("multipart/form-data");
}

function filenameFromContentDisposition(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const utf8 = /filename\*=(?:UTF-8''|utf-8'')([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"+|"+$/g, ""));
    } catch {
      return utf8[1].trim().replace(/^"+|"+$/g, "");
    }
  }
  const plain = /filename="([^"]+)"|filename=([^;]+)/i.exec(header);
  return plain?.[1] || plain?.[2]?.trim();
}

function resolveRawFilename(
  req: IncomingMessage,
  options: UploadPrintOptions,
): string {
  const fromHeader =
    headerValue(req.headers["x-filename"]) ||
    filenameFromContentDisposition(headerValue(req.headers["content-disposition"]));
  const name = options.filename || fromHeader;
  if (!name?.trim()) {
    throw new UploadHttpError(
      "filename is required for raw uploads (query filename=, X-Filename, or Content-Disposition)",
      400,
    );
  }
  return name.trim();
}

class LimitExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Upload exceeds PRINT_MAX_UPLOAD_BYTES (${maxBytes})`);
    this.name = "LimitExceededError";
  }
}

async function pipeWithLimit(
  source: NodeJS.ReadableStream,
  destPath: string,
  maxBytes: number,
): Promise<number> {
  let written = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length;
      if (written > maxBytes) {
        cb(new LimitExceededError(maxBytes));
        return;
      }
      cb(null, chunk);
    },
  });

  await pipeline(source as NodeJS.ReadableStream, counter, createWriteStream(destPath));
  return written;
}

/**
 * Stream a raw request body (PUT / POST octet-stream) into an upload-* spool file.
 */
export async function receiveRawUpload(
  req: IncomingMessage,
  config: PrintConfig,
  options: UploadPrintOptions,
): Promise<{ resolved: ResolvedPrintFile; options: UploadPrintOptions }> {
  const lengthHeader = headerValue(req.headers["content-length"]);
  if (lengthHeader) {
    const length = Number.parseInt(lengthHeader, 10);
    if (Number.isFinite(length) && length > config.maxUploadBytes) {
      throw new UploadHttpError(
        `Upload exceeds PRINT_MAX_UPLOAD_BYTES (${config.maxUploadBytes})`,
        413,
      );
    }
  }

  const filename = resolveRawFilename(req, options);
  const target = await createUploadSpoolTarget(config.printSpoolDir, filename);

  try {
    const written = await pipeWithLimit(req, target.filePath, config.maxUploadBytes);
    if (written <= 0) {
      throw new UploadHttpError("Upload body was empty", 400);
    }
    return { resolved: target, options };
  } catch (err) {
    await rm(target.cleanupDir, { recursive: true, force: true }).catch(() => undefined);
    if (err instanceof LimitExceededError) {
      throw new UploadHttpError(err.message, 413);
    }
    throw err;
  }
}

/**
 * Parse multipart/form-data, stream the file part to spool, collect print options.
 */
export async function receiveMultipartUpload(
  req: IncomingMessage,
  config: PrintConfig,
  queryOptions: UploadPrintOptions,
): Promise<{ resolved: ResolvedPrintFile; options: UploadPrintOptions }> {
  const lengthHeader = headerValue(req.headers["content-length"]);
  if (lengthHeader) {
    const length = Number.parseInt(lengthHeader, 10);
    if (Number.isFinite(length) && length > config.maxUploadBytes) {
      throw new UploadHttpError(
        `Upload exceeds PRINT_MAX_UPLOAD_BYTES (${config.maxUploadBytes})`,
        413,
      );
    }
  }

  const contentType = headerValue(req.headers["content-type"]);
  if (!contentType) {
    throw new UploadHttpError("Missing Content-Type for multipart upload", 400);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let filePromise: Promise<ResolvedPrintFile> | undefined;
    let sawFile = false;
    const fields: Record<string, string> = {};
    let totalWritten = 0;

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const succeed = (value: { resolved: ResolvedPrintFile; options: UploadPrintOptions }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let busboy: ReturnType<typeof Busboy>;
    try {
      busboy = Busboy({
        headers: { "content-type": contentType },
        limits: {
          files: 1,
          fileSize: config.maxUploadBytes,
        },
      });
    } catch (err) {
      fail(
        new UploadHttpError(
          err instanceof Error ? err.message : "Invalid multipart Content-Type",
          400,
        ),
      );
      return;
    }

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (_name, fileStream, info) => {
      if (sawFile) {
        fileStream.resume();
        fail(new UploadHttpError("Only one file part is allowed", 400));
        return;
      }
      sawFile = true;

      // Prefer explicit filename query/form; fall back to multipart filename.
      const filename =
        queryOptions.filename ||
        fields.filename ||
        info.filename ||
        "upload.pdf";

      filePromise = (async () => {
        let target: (ResolvedPrintFile & { cleanupDir: string }) | undefined;
        try {
          target = await createUploadSpoolTarget(config.printSpoolDir, filename);
          const written = await pipeWithLimit(
            fileStream,
            target.filePath,
            config.maxUploadBytes,
          );
          totalWritten = written;
          if (written <= 0) {
            throw new UploadHttpError("Upload file part was empty", 400);
          }
          return target;
        } catch (err) {
          fileStream.resume();
          if (target?.cleanupDir) {
            await rm(target.cleanupDir, { recursive: true, force: true }).catch(
              () => undefined,
            );
          }
          if (err instanceof LimitExceededError) {
            throw new UploadHttpError(err.message, 413);
          }
          throw err;
        }
      })();

      fileStream.on("limit", () => {
        fail(
          new UploadHttpError(
            `Upload exceeds PRINT_MAX_UPLOAD_BYTES (${config.maxUploadBytes})`,
            413,
          ),
        );
      });
    });

    busboy.on("error", (err: Error) => {
      fail(err instanceof UploadHttpError ? err : new UploadHttpError(String(err), 400));
    });

    busboy.on("finish", async () => {
      try {
        if (!sawFile || !filePromise) {
          fail(new UploadHttpError('Missing file part (expected form field "file")', 400));
          return;
        }
        const resolved = await filePromise;
        if (totalWritten <= 0) {
          await cleanupResolvedPrintFile(config.printSpoolDir, resolved).catch(
            () => undefined,
          );
          fail(new UploadHttpError("Upload file part was empty", 400));
          return;
        }
        // Form fields override query params.
        const fromForm = parseUploadPrintOptions({}, fields);
        const merged: UploadPrintOptions = {
          printer: fromForm.printer ?? queryOptions.printer,
          copies: fromForm.copies ?? queryOptions.copies,
          sides: fromForm.sides ?? queryOptions.sides,
          filename: fromForm.filename ?? queryOptions.filename,
        };
        succeed({ resolved, options: merged });
      } catch (err) {
        fail(err);
      }
    });

    req.pipe(busboy);
  });
}

/**
 * Convert (if needed) and submit to CUPS; always cleans upload temps.
 */
export async function submitUploadedPrintJob(
  config: PrintConfig,
  resolved: ResolvedPrintFile,
  options: UploadPrintOptions,
  deps: UploadHandlerDeps = {},
): Promise<PrintResult> {
  const prepare = deps.prepare ?? preparePrintReadyFile;
  const print = deps.print ?? printFile;
  let ready = resolved;
  try {
    ready = await prepare(config, resolved);
  } catch (err) {
    await cleanupResolvedPrintFile(config.printSpoolDir, resolved).catch(() => undefined);
    if (ready !== resolved) {
      await cleanupResolvedPrintFile(config.printSpoolDir, ready).catch(() => undefined);
    }
    throw err;
  }

  try {
    const printOptions: PrintFileOptions = {
      filePath: ready.filePath,
      copies: options.copies,
      sides: options.sides,
      printer: options.printer,
    };
    return await print(config, printOptions);
  } finally {
    await cleanupResolvedPrintFile(config.printSpoolDir, ready).catch(() => undefined);
  }
}

function queryRecord(req: Request): Record<string, unknown> {
  return (req.query ?? {}) as Record<string, unknown>;
}

/**
 * Express handler for POST/PUT `/print/upload`.
 * Returns JSON `{ ok, jobId, printer }` or `{ ok: false, error }`.
 */
export async function handlePrintUpload(
  req: Request,
  res: Response,
  deps: UploadHandlerDeps = {},
): Promise<void> {
  const getConfigFn = deps.getConfig ?? getConfig;
  let config: PrintConfig;
  try {
    config = getConfigFn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
    return;
  }

  let resolved: ResolvedPrintFile | undefined;
  try {
    assertUploadAuthorized(req, config.uploadToken);

    const method = (req.method || "POST").toUpperCase();
    if (method !== "POST" && method !== "PUT") {
      throw new UploadHttpError("Method Not Allowed (use POST multipart or PUT raw)", 405);
    }

    const queryOptions = parseUploadPrintOptions(queryRecord(req));
    const received = isMultipart(req)
      ? await receiveMultipartUpload(req, config, queryOptions)
      : await receiveRawUpload(req, config, queryOptions);

    resolved = received.resolved;
    const result = await submitUploadedPrintJob(
      config,
      received.resolved,
      received.options,
      deps,
    );
    resolved = undefined; // cleanup already done inside submit

    if (!result.ok) {
      res.status(502).json(result);
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    if (resolved) {
      await cleanupResolvedPrintFile(config.printSpoolDir, resolved).catch(() => undefined);
    }
    if (err instanceof UploadHttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const status =
      /Unsupported file type|Invalid filename|truncated|empty/i.test(message)
        ? 400
        : 500;
    res.status(status).json({ ok: false, error: message });
  }
}

export function buildUploadInfoPayload(baseUrl: string, tokenConfigured: boolean) {
  const url = `${baseUrl.replace(/\/$/, "")}${PRINT_UPLOAD_PATH}`;
  return {
    ok: true as const,
    url,
    methods: ["POST", "PUT"] as const,
    auth: tokenConfigured
      ? "Required: Authorization: Bearer <PRINT_UPLOAD_TOKEN> or X-Print-Token"
      : "Optional: set PRINT_UPLOAD_TOKEN to require Authorization Bearer / X-Print-Token",
    preferOver: "contentBase64 (use HTTP upload or url for large files)",
    curlMultipart: tokenConfigured
      ? `curl -sS -X POST -H "Authorization: Bearer $PRINT_UPLOAD_TOKEN" -F "file=@./document.docx" -F "copies=1" "${url}"`
      : `curl -sS -X POST -F "file=@./document.docx" -F "copies=1" "${url}"`,
    curlPut: tokenConfigured
      ? `curl -sS -X PUT -H "Authorization: Bearer $PRINT_UPLOAD_TOKEN" -H "Content-Type: application/octet-stream" --data-binary @./document.docx "${url}?filename=document.docx"`
      : `curl -sS -X PUT -H "Content-Type: application/octet-stream" --data-binary @./document.docx "${url}?filename=document.docx"`,
  };
}
