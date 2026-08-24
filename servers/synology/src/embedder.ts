import { pipeline, env, type FeatureExtractionPipeline } from "@xenova/transformers";

export const EMBEDDING_DIM = 1024;
export const MODEL_ID = "mixedbread-ai/mxbai-embed-large-v1";

env.cacheDir = process.env.TRANSFORMERS_CACHE ?? "/tmp/transformers-cache";
env.localModelPath = env.cacheDir;

let embedder: FeatureExtractionPipeline | null = null;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;

export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (embedder) return embedder;

  if (initPromise) return initPromise;

  initPromise = (async () => {
    console.error(`[embedder] Loading ${MODEL_ID} (CPU)...`);
    const startMs = performance.now();
    const pipe = await pipeline("feature-extraction", MODEL_ID, {
      quantized: true,
    });
    const elapsedMs = Math.round(performance.now() - startMs);
    console.error(`[embedder] Model loaded in ${elapsedMs}ms`);
    embedder = pipe;
    return pipe;
  })();

  return initPromise;
}

export async function embedQuery(text: string): Promise<number[]> {
  const pipe = await getEmbedder();

  const output = await pipe(text, {
    pooling: "cls",
    normalize: true,
  });

  const embedding = Array.from(output.data as Float32Array);

  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${embedding.length}. ` +
        `Query embeddings must use the same model (mxbai-embed-large, 1024-d) as the indexed data.`,
    );
  }

  return embedding;
}

export function formatVectorForPg(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
