import {
  DEFAULT_EMBED_CHUNK_OVERLAP,
  DEFAULT_MAX_EMBED_CHARS,
  chunkTextForEmbed,
  meanPoolNormalize,
  preflightEmbedChunk,
  type EmbedOptions,
} from "./text-limits.js";
import { logInfo, logWarn } from "./telemetry.js";

export type { EmbedOptions };

export const EMBEDDING_DIM = 1024;

/** Max chars of Ollama error body included in thrown errors. */
export const EMBED_ERROR_BODY_TRUNCATE = 500;

export interface EmbedResult {
  embedding: number[];
  model: string;
}

function truncateBody(body: string, max = EMBED_ERROR_BODY_TRUNCATE): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}…`;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return truncateBody(text.trim());
  } catch {
    return "";
  }
}

function embeddingHttpError(status: number, body: string): Error {
  const suffix = body ? `: ${body}` : "";
  return new Error(`Embedding model request failed: HTTP ${status}${suffix}`);
}

export function isContextLengthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /context length|input length exceeds|exceeds.*context/i.test(err.message);
}

async function embedTextOnce(
  text: string,
  ollamaBaseUrl: string,
  model: string,
): Promise<EmbedResult> {
  const response = await fetch(`${ollamaBaseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: text,
    }),
  });

  if (!response.ok) {
    const body = await readErrorBody(response);
    const err = embeddingHttpError(response.status, body);
    (err as Error & { status?: number }).status = response.status;
    throw err;
  }

  const result = (await response.json()) as { embedding: number[] };
  const embedding = result.embedding;

  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${embedding.length}. ` +
        `Embeddings must use mxbai-embed-large (1024-d) to match MCP query embeddings.`,
    );
  }

  return { embedding, model };
}

function isHttp5xx(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as Error & { status?: number }).status;
  if (typeof status === "number") {
    return status >= 500 && status <= 599;
  }
  return /HTTP 5\d\d/.test(err.message);
}

async function embedTextOnceWithRetry(
  text: string,
  ollamaBaseUrl: string,
  model: string,
): Promise<EmbedResult> {
  try {
    return await embedTextOnce(text, ollamaBaseUrl, model);
  } catch (err) {
    // Context-length failures will not recover on retry with the same payload.
    if (isContextLengthError(err) || !isHttp5xx(err)) {
      throw err;
    }
    // One retry on other 5xx only — no delay; flakiness is usually immediate recovery.
    return embedTextOnce(text, ollamaBaseUrl, model);
  }
}

/**
 * Embed a single chunk. On context-length errors, truncate and retry once;
 * if still failing, return null so the caller can skip the chunk.
 */
async function embedChunkResilient(
  chunk: string,
  ollamaBaseUrl: string,
  model: string,
  maxEmbedChars: number,
  context: { path?: string; source?: string; chunkIndex: number },
): Promise<number[] | null> {
  const safe = preflightEmbedChunk(chunk, maxEmbedChars, context);
  try {
    const result = await embedTextOnceWithRetry(safe, ollamaBaseUrl, model);
    return result.embedding;
  } catch (err) {
    if (!isContextLengthError(err)) {
      throw err;
    }

    const halved = Math.max(1, Math.floor(safe.length / 2));
    logWarn("embed chunk truncated after context-length error", {
      path: context.path ?? "",
      source: context.source ?? "embed",
      chunk_index: context.chunkIndex,
      original_chars: safe.length,
      truncated_chars: halved,
      reason: "context_length_exceeded",
    });

    try {
      const result = await embedTextOnceWithRetry(
        safe.slice(0, halved),
        ollamaBaseUrl,
        model,
      );
      return result.embedding;
    } catch (retryErr) {
      if (isContextLengthError(retryErr)) {
        logWarn("embed chunk skipped after context-length error", {
          path: context.path ?? "",
          source: context.source ?? "embed",
          chunk_index: context.chunkIndex,
          chars: halved,
          reason: "context_length_exceeded",
        });
        return null;
      }
      throw retryErr;
    }
  }
}

/**
 * Embed text via Ollama `/api/embeddings`.
 * Long inputs are split under the model context budget and mean-pooled.
 * On HTTP 5xx (except context-length), retries once per chunk.
 */
export async function embedText(
  text: string,
  ollamaBaseUrl: string,
  model: string = "mxbai-embed-large",
  options: EmbedOptions = {},
): Promise<EmbedResult> {
  const maxEmbedChars = options.maxEmbedChars ?? DEFAULT_MAX_EMBED_CHARS;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_EMBED_CHUNK_OVERLAP;
  const path = options.path;
  const source = options.source ?? "embed";

  const chunks = chunkTextForEmbed(text, maxEmbedChars, chunkOverlap);
  if (chunks.length > 1) {
    logInfo("embed input chunked", {
      path: path ?? "",
      source,
      original_chars: text.length,
      chunk_count: chunks.length,
      max_chars: maxEmbedChars,
      overlap: chunkOverlap,
    });
  }

  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embedChunkResilient(chunks[i], ollamaBaseUrl, model, maxEmbedChars, {
      path,
      source,
      chunkIndex: i,
    });
    if (embedding) {
      vectors.push(embedding);
    }
  }

  if (vectors.length === 0) {
    const err = new Error(
      `Embedding failed: all ${chunks.length} chunk(s) exceeded context length` +
        (path ? ` (path=${path})` : ""),
    );
    (err as Error & { reason?: string }).reason = "all_chunks_context_length";
    throw err;
  }

  const embedding =
    vectors.length === 1 ? vectors[0] : meanPoolNormalize(vectors);

  return { embedding, model };
}
