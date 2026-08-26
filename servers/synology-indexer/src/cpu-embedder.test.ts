import { describe, it, expect, vi, beforeEach } from "vitest";
import { EMBEDDING_DIM, MODEL_ID, embedTextCpu, resetCpuEmbedderForTests } from "./cpu-embedder.js";

const mockPipeline = vi.fn();

vi.mock("@xenova/transformers", () => ({
  pipeline: (...args: unknown[]) => mockPipeline(...args),
  env: {
    cacheDir: "/tmp/transformers-cache",
    localModelPath: "/tmp/transformers-cache",
  },
}));

describe("CPU embedder configuration", () => {
  it("uses 1024-dimensional mxbai-embed-large-v1", () => {
    expect(EMBEDDING_DIM).toBe(1024);
    expect(MODEL_ID).toBe("mixedbread-ai/mxbai-embed-large-v1");
  });
});

describe("embedTextCpu", () => {
  beforeEach(() => {
    resetCpuEmbedderForTests();
    mockPipeline.mockReset();
  });

  it("returns 1024-d embedding with cls pooling settings", async () => {
    const vector = new Float32Array(1024).fill(0.25);
    mockPipeline.mockResolvedValue(async (text: string, opts: unknown) => {
      expect(text).toBe("folder summary text");
      expect(opts).toEqual({ pooling: "cls", normalize: true });
      return { data: vector };
    });

    const result = await embedTextCpu("folder summary text");

    expect(result.embedding).toHaveLength(1024);
    expect(result.model).toBe(MODEL_ID);
    expect(mockPipeline).toHaveBeenCalledWith(
      "feature-extraction",
      MODEL_ID,
      { quantized: true },
    );
  });

  it("throws when dimension mismatch", async () => {
    mockPipeline.mockResolvedValue(async () => ({
      data: new Float32Array(512).fill(0.1),
    }));

    await expect(embedTextCpu("bad dim")).rejects.toThrow(/1024/);
  });
});
