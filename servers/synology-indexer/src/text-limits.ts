import { logInfo, logWarn } from "./telemetry.js";

/** Bytes read from plain-text files for qwen gist (default 64 KiB). */
export const DEFAULT_TEXT_HEAD_BYTES = 65_536;

/** Max document excerpt characters sent to qwen (default 32k). */
export const DEFAULT_QWEN_DOCUMENT_CHARS = 32_768;

/** Max DESCRIPTION length stored and sent to mxbai (label capped separately at 100). */
export const DEFAULT_MAX_DESCRIPTION_CHARS = 500;

/**
 * Max characters per embed request for mxbai-embed-large (512-token context).
 * Conservative char budget (~3 chars/token) so folder summaries and long OCR
 * text are chunked before Ollama can 500 with "input length exceeds context".
 */
export const DEFAULT_MAX_EMBED_CHARS = 1_500;

/** Overlap between consecutive embed chunks (chars). */
export const DEFAULT_EMBED_CHUNK_OVERLAP = 100;

export interface TextLimits {
  textHeadBytes: number;
  qwenDocumentChars: number;
  maxDescriptionChars: number;
  maxEmbedChars: number;
  embedChunkOverlap: number;
}

/** Shared options for GPU and CPU embed paths. */
export interface EmbedOptions {
  maxEmbedChars?: number;
  chunkOverlap?: number;
  /** Optional path for structured logs (folder/file syno path). */
  path?: string;
  source?: string;
}

export function truncateForQwen(
  text: string,
  maxChars: number,
  context: { fileName: string; source: "docling" | "qwen-text" },
): string {
  if (text.length <= maxChars) {
    return text;
  }
  logInfo("document text truncated for qwen", {
    file_name: context.fileName,
    source: context.source,
    original_chars: text.length,
    max_chars: maxChars,
  });
  return text.slice(0, maxChars);
}

export function capDescription(description: string, maxChars: number): string {
  if (description.length <= maxChars) {
    return description;
  }
  return description.slice(0, maxChars - 3) + "...";
}

/**
 * Split long text into overlapping chunks under maxChars.
 * Prefers breaking on newlines, then spaces, when near the limit.
 */
export function chunkTextForEmbed(
  text: string,
  maxChars: number = DEFAULT_MAX_EMBED_CHARS,
  overlap: number = DEFAULT_EMBED_CHUNK_OVERLAP,
): string[] {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_EMBED_CHARS;
  const ov = Math.max(
    0,
    Math.min(
      Number.isFinite(overlap) && overlap >= 0 ? Math.floor(overlap) : DEFAULT_EMBED_CHUNK_OVERLAP,
      limit - 1,
    ),
  );

  if (text.length === 0) {
    return [""];
  }
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + limit, text.length);

    if (end < text.length) {
      const window = text.slice(start, end);
      const nl = window.lastIndexOf("\n");
      const sp = window.lastIndexOf(" ");
      const breakAt = Math.max(nl, sp);
      if (breakAt > limit * 0.5) {
        end = start + breakAt;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk.length > limit ? chunk.slice(0, limit) : chunk);
    }

    if (end >= text.length) {
      break;
    }

    const nextStart = Math.max(0, end - ov);
    if (nextStart <= start) {
      start = end;
    } else {
      start = nextStart;
    }
  }

  return chunks.length > 0 ? chunks : [text.slice(0, limit)];
}

/** Truncate a single chunk that somehow still exceeds the limit; logs structured reason. */
export function preflightEmbedChunk(
  chunk: string,
  maxChars: number,
  context?: { path?: string; source?: string; chunkIndex?: number },
): string {
  if (chunk.length <= maxChars) {
    return chunk;
  }
  logWarn("embed chunk truncated over limit", {
    path: context?.path ?? "",
    source: context?.source ?? "embed",
    chunk_index: context?.chunkIndex ?? 0,
    original_chars: chunk.length,
    max_chars: maxChars,
    reason: "over_max_embed_chars",
  });
  return chunk.slice(0, maxChars);
}

/** Mean-pool embedding vectors and L2-normalize (for multi-chunk embeds). */
export function meanPoolNormalize(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    throw new Error("meanPoolNormalize requires at least one embedding vector");
  }
  const dim = vectors[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new Error(
        `meanPoolNormalize dimension mismatch: expected ${dim}, got ${v.length}`,
      );
    }
    for (let i = 0; i < dim; i++) {
      out[i] += v[i];
    }
  }
  const n = vectors.length;
  for (let i = 0; i < dim; i++) {
    out[i] /= n;
  }
  let normSq = 0;
  for (const x of out) {
    normSq += x * x;
  }
  const norm = Math.sqrt(normSq) || 1;
  for (let i = 0; i < dim; i++) {
    out[i] /= norm;
  }
  return out;
}
