import { openAsBlob } from "node:fs";
import { basename } from "node:path";

export interface DoclingConvertResponse {
  document?: {
    md_content?: string;
  };
  status?: string;
  errors?: unknown[];
}

export interface DoclingConvertOptions {
  /** Inclusive 1-based page range (default first 5 pages). Always sent to Docling. */
  pageRange?: [number, number];
  /** Client-side fetch timeout in milliseconds. */
  convertTimeoutMs?: number;
  /** Docling document_timeout form field in seconds. */
  documentTimeoutSec?: number;
}

/** Default last page (inclusive) for gist conversion — first ~5 pages only. */
export const DEFAULT_DOCLING_GIST_PAGE_END = 5;

/** 1-based inclusive page_range for Docling gist (always pages 1..end). */
export function doclingGistPageRange(
  endPage: number = DEFAULT_DOCLING_GIST_PAGE_END,
): [number, number] {
  const end = endPage > 0 ? endPage : DEFAULT_DOCLING_GIST_PAGE_END;
  return [1, end];
}

function appendPageRange(form: FormData, pageRange: [number, number]): void {
  // Docling expects two separate page_range fields (start, end), not "1,5".
  form.append("page_range", String(pageRange[0]));
  form.append("page_range", String(pageRange[1]));
}

/** Convert a document on the RO mount to markdown via docling-serve (streams file; no persistent copy). */
export async function convertFileToMarkdown(
  filePath: string,
  doclingBaseUrl: string,
  options: DoclingConvertOptions = {},
): Promise<string> {
  const blob = await openAsBlob(filePath);
  const form = new FormData();
  form.append("files", blob, basename(filePath));
  form.append("to_formats", "md");

  appendPageRange(form, options.pageRange ?? doclingGistPageRange());

  if (options.documentTimeoutSec !== undefined && options.documentTimeoutSec > 0) {
    form.append("document_timeout", String(options.documentTimeoutSec));
  }

  const base = doclingBaseUrl.replace(/\/$/, "");
  const timeoutMs = options.convertTimeoutMs;
  const signal =
    timeoutMs !== undefined && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;

  let response: Response;
  try {
    response = await fetch(`${base}/v1/convert/file`, {
      method: "POST",
      body: form,
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Docling conversion timed out after ${timeoutMs}ms`);
    }
    throw err;
  }

  if (!response.ok) {
    throw new Error(`Docling conversion failed: HTTP ${response.status}`);
  }

  const result = (await response.json()) as DoclingConvertResponse;
  const markdown = result.document?.md_content;
  if (typeof markdown !== "string" || markdown.trim() === "") {
    throw new Error("Docling conversion returned no markdown content");
  }

  return markdown;
}
