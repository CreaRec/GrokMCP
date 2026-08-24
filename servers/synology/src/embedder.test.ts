import { describe, it, expect } from "vitest";
import { EMBEDDING_DIM, MODEL_ID, formatVectorForPg } from "./embedder.js";

describe("Embedder configuration", () => {
  it("should use 1024-dimensional embeddings", () => {
    expect(EMBEDDING_DIM).toBe(1024);
  });

  it("should use mxbai-embed-large model", () => {
    expect(MODEL_ID).toBe("mixedbread-ai/mxbai-embed-large-v1");
  });

  it("model must match indexed data dimension (1024)", () => {
    expect(EMBEDDING_DIM).toBe(1024);
  });
});

describe("formatVectorForPg", () => {
  it("should format a vector as pgvector string", () => {
    const embedding = [0.1, 0.2, 0.3];
    const result = formatVectorForPg(embedding);
    expect(result).toBe("[0.1,0.2,0.3]");
  });

  it("should handle empty vector", () => {
    const embedding: number[] = [];
    const result = formatVectorForPg(embedding);
    expect(result).toBe("[]");
  });

  it("should handle 1024-dimensional vector", () => {
    const embedding = Array(1024).fill(0.5);
    const result = formatVectorForPg(embedding);
    expect(result.startsWith("[")).toBe(true);
    expect(result.endsWith("]")).toBe(true);
    expect(result.split(",")).toHaveLength(1024);
  });
});
