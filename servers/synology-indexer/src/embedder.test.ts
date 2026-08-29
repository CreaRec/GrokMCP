import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EMBEDDING_DIM, embedText } from "./embedder.js";

function jsonEmbeddingResponse(embedding: number[], status = 200): Response {
  return new Response(JSON.stringify({ embedding }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

describe("embedText", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("includes HTTP status and truncated response body on failure", async () => {
    const longBody = "x".repeat(600);
    // Two 500s: embedText retries once on 5xx, then throws with the final body.
    vi.mocked(fetch)
      .mockResolvedValueOnce(errorResponse(500, "first"))
      .mockResolvedValueOnce(errorResponse(500, longBody));

    await expect(embedText("hello", "http://ollama:11434")).rejects.toThrow(
      /Embedding model request failed: HTTP 500: x{500}…/,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries once on 5xx then succeeds", async () => {
    const embedding = Array(EMBEDDING_DIM).fill(0.1);
    vi.mocked(fetch)
      .mockResolvedValueOnce(errorResponse(500, "model busy"))
      .mockResolvedValueOnce(jsonEmbeddingResponse(embedding));

    const result = await embedText("hello", "http://ollama:11434", "mxbai-embed-large");
    expect(result.embedding).toHaveLength(EMBEDDING_DIM);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries once on 5xx then throws if still failing", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(errorResponse(500, "first"))
      .mockResolvedValueOnce(errorResponse(500, "second boom"));

    await expect(embedText("hello", "http://ollama:11434")).rejects.toThrow(
      /HTTP 500: second boom/,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errorResponse(400, "bad request"));

    await expect(embedText("hello", "http://ollama:11434")).rejects.toThrow(
      /HTTP 400: bad request/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
