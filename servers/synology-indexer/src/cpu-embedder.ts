import { pipeline, env, type FeatureExtractionPipeline } from "@xenova/transformers";

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

export async function embedTextCpu(text: string): Promise<CpuEmbedResult> {
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

  return { embedding, model: MODEL_ID };
}

/** Reset singleton state (for tests). */
export function resetCpuEmbedderForTests(): void {
  embedder = null;
  initPromise = null;
}
