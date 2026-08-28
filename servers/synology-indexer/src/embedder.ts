export const EMBEDDING_DIM = 1024;

export interface EmbedResult {
  embedding: number[];
  model: string;
}

export async function embedText(
  text: string,
  ollamaBaseUrl: string,
  model: string = "mxbai-embed-large",
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
    throw new Error(`Embedding model request failed: HTTP ${response.status}`);
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
