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

/**
 * Embed text via Ollama `/api/embeddings`.
 * On HTTP 5xx, retries once (Ollama can be flaky after vision on the same pod),
 * then throws including status and a truncated response body.
 */
export async function embedText(
  text: string,
  ollamaBaseUrl: string,
  model: string = "mxbai-embed-large",
): Promise<EmbedResult> {
  try {
    return await embedTextOnce(text, ollamaBaseUrl, model);
  } catch (err) {
    if (!isHttp5xx(err)) {
      throw err;
    }
    // One retry on 5xx only — no delay; flakiness is usually immediate recovery.
    return embedTextOnce(text, ollamaBaseUrl, model);
  }
}
