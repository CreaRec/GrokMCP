import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EMBEDDING_DIM, embedText, isContextLengthError } from "./embedder.js";

vi.mock("./telemetry.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logErrorWithCause: vi.fn(),
}));

import { logInfo, logWarn } from "./telemetry.js";

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
    vi.mocked(logInfo).mockClear();
    vi.mocked(logWarn).mockClear();
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

  it("chunks long input and mean-pools embeddings", async () => {
    const embA = Array(EMBEDDING_DIM)
      .fill(0)
      .map((_, i) => (i === 0 ? 1 : 0));
    const embB = Array(EMBEDDING_DIM)
      .fill(0)
      .map((_, i) => (i === 1 ? 1 : 0));

    let call = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      call++;
      return jsonEmbeddingResponse(call === 1 ? embA : embB);
    });

    const long = "word ".repeat(800); // well over 1500 chars
    const result = await embedText(long, "http://ollama:11434", "mxbai-embed-large", {
      maxEmbedChars: 200,
      chunkOverlap: 20,
      path: "/Documents/USA/Taxes/2026/FSA Receipts",
      source: "folder-rebuild",
    });

    expect(call).toBeGreaterThan(1);
    expect(result.embedding).toHaveLength(EMBEDDING_DIM);
    const norm = Math.sqrt(result.embedding.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(logInfo).toHaveBeenCalledWith(
      "embed input chunked",
      expect.objectContaining({
        path: "/Documents/USA/Taxes/2026/FSA Receipts",
        chunk_count: expect.any(Number),
      }),
    );

    const prompts = vi.mocked(fetch).mock.calls.map((c) => {
      const body = JSON.parse((c[1] as RequestInit).body as string) as { prompt: string };
      return body.prompt;
    });
    for (const prompt of prompts) {
      expect(prompt.length).toBeLessThanOrEqual(200);
    }
  });

  it("does not retry identical payload on context-length 500; truncates then recovers", async () => {
    const embedding = Array(EMBEDDING_DIM).fill(0.2);
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        errorResponse(500, "the input length exceeds the context length"),
      )
      .mockResolvedValueOnce(jsonEmbeddingResponse(embedding));

    const result = await embedText("hello world text", "http://ollama:11434", "mxbai", {
      maxEmbedChars: 100,
      path: "/Documents/USA/Taxes/2026/FSA Receipts",
    });

    expect(result.embedding).toHaveLength(EMBEDDING_DIM);
    expect(fetch).toHaveBeenCalledTimes(2);
    // Second call must be a truncated prompt, not a blind retry of the same body.
    const firstBody = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    ) as { prompt: string };
    const secondBody = JSON.parse(
      (vi.mocked(fetch).mock.calls[1][1] as RequestInit).body as string,
    ) as { prompt: string };
    expect(secondBody.prompt.length).toBeLessThan(firstBody.prompt.length);
    expect(logWarn).toHaveBeenCalledWith(
      "embed chunk truncated after context-length error",
      expect.objectContaining({
        path: "/Documents/USA/Taxes/2026/FSA Receipts",
        reason: "context_length_exceeded",
      }),
    );
  });

  it("skips chunk that still exceeds context after truncate without aborting other chunks", async () => {
    const embOk = Array(EMBEDDING_DIM).fill(0.3);
    let call = 0;
    // Chunk 0: context error → truncate → still context error → skip
    // Later chunks: success
    vi.mocked(fetch).mockImplementation(async () => {
      call++;
      if (call <= 2) {
        return errorResponse(500, "the input length exceeds the context length");
      }
      return jsonEmbeddingResponse(embOk);
    });

    const long = `${"a".repeat(180)}\n${"b".repeat(180)}`;
    const result = await embedText(long, "http://ollama:11434", "mxbai", {
      maxEmbedChars: 100,
      chunkOverlap: 0,
      path: "/Share/FSA Receipts",
    });

    expect(result.embedding).toHaveLength(EMBEDDING_DIM);
    expect(call).toBeGreaterThan(2);
    expect(logWarn).toHaveBeenCalledWith(
      "embed chunk skipped after context-length error",
      expect.objectContaining({
        path: "/Share/FSA Receipts",
        reason: "context_length_exceeded",
      }),
    );
    // Remained resilient: at least one later chunk succeeded so we still return an embedding.
    expect(result.embedding.some((x) => x !== 0)).toBe(true);
  });
});

describe("isContextLengthError", () => {
  it("detects Ollama context-length bodies", () => {
    expect(
      isContextLengthError(
        new Error("Embedding model request failed: HTTP 500: the input length exceeds the context length"),
      ),
    ).toBe(true);
    expect(isContextLengthError(new Error("HTTP 500: model busy"))).toBe(false);
  });
});
