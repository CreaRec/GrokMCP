import { pipeline, env, type FeatureExtractionPipeline } from "@xenova/transformers";
import {
  DEFAULT_EMBED_CHUNK_OVERLAP,
  DEFAULT_MAX_EMBED_CHARS,
  chunkTextForEmbed,
  meanPoolNormalize,
  preflightEmbedChunk,
  type EmbedOptions,
} from "./text-limits.js";
import { logInfo, logWarn } from "./telemetry.js";

export const EMBEDDING_DIM = 1024;
export const MODEL_ID = "mixedbread-ai/mxbai-embed-large-v1";

env.cacheDir = process.env.TRANSFORMERS_CACHE ?? "/tmp/transformers-cache";
env.localModelPath = env.cacheDir;

let embedder: FeatureExtractionPipeline | null = null;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;

export async function getCpuEmbedder(): Promise<FeatureExtractionPipeline> {
  if (embedder) return embedder;

  if (initPromise) return initPromise;

  initPromise = (async () => {
    const pipe = await pipeline("feature-extraction", MODEL_ID, {
      quantized: true,
    });
    embedder = pipe;
    return pipe;
  })();

  return initPromise;
}

export interface CpuEmbedResult {
  embedding: number[];
  model: string;
}

async function embedChunkCpuOnce(text: string): Promise<number[]> {
  const pipe = await getCpuEmbedder();

  const output = await pipe(text, {
    pooling: "cls",
    normalize: true,
  });

  const embedding = Array.from(output.data as Float32Array);

  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${embedding.length}. ` +
        `CPU folder embeddings must use mxbai-embed-large-v1 (1024-d) to match MCP query embeddings.`,
    );
  }

  return embedding;
}

function isContextLengthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /context length|input length exceeds|exceeds.*context|maximum sequence length|too long/i.test(
    err.message,
  );
}

async function embedChunkCpuResilient(
  chunk: string,
  maxEmbedChars: number,
  context: { path?: string; source?: string; chunkIndex: number },
): Promise<number[] | null> {
  const safe = preflightEmbedChunk(chunk, maxEmbedChars, context);
  try {
    return await embedChunkCpuOnce(safe);
  } catch (err) {
    if (!isContextLengthError(err)) {
      throw err;
    }

    const halved = Math.max(1, Math.floor(safe.length / 2));
    logWarn("CPU embed chunk truncated after context-length error", {
      path: context.path ?? "",
      source: context.source ?? "cpu-embed",
      chunk_index: context.chunkIndex,
      original_chars: safe.length,
      truncated_chars: halved,
      reason: "context_length_exceeded",
    });

    try {
      return await embedChunkCpuOnce(safe.slice(0, halved));
    } catch (retryErr) {
      if (isContextLengthError(retryErr)) {
        logWarn("CPU embed chunk skipped after context-length error", {
          path: context.path ?? "",
          source: context.source ?? "cpu-embed",
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
 * Embed text via CPU transformers.
 * Long inputs are split under the model context budget and mean-pooled.
 */
export async function embedTextCpu(
  text: string,
  options: EmbedOptions = {},
): Promise<CpuEmbedResult> {
  const maxEmbedChars = options.maxEmbedChars ?? DEFAULT_MAX_EMBED_CHARS;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_EMBED_CHUNK_OVERLAP;
  const path = options.path;
  const source = options.source ?? "cpu-embed";

  const chunks = chunkTextForEmbed(text, maxEmbedChars, chunkOverlap);
  if (chunks.length > 1) {
    logInfo("CPU embed input chunked", {
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
    const embedding = await embedChunkCpuResilient(chunks[i], maxEmbedChars, {
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
      `CPU embedding failed: all ${chunks.length} chunk(s) exceeded context length` +
        (path ? ` (path=${path})` : ""),
    );
    (err as Error & { reason?: string }).reason = "all_chunks_context_length";
    throw err;
  }

  const embedding =
    vectors.length === 1 ? vectors[0] : meanPoolNormalize(vectors);

  return { embedding, model: MODEL_ID };
}

/** Reset singleton state (for tests). */
export function resetCpuEmbedderForTests(): void {
  embedder = null;
  initPromise = null;
}
