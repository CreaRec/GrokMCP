import { describe, it, expect, vi } from "vitest";
import {
  truncateForQwen,
  capDescription,
  chunkTextForEmbed,
  meanPoolNormalize,
  preflightEmbedChunk,
} from "./text-limits.js";

vi.mock("./telemetry.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { logInfo, logWarn } from "./telemetry.js";

describe("truncateForQwen", () => {
  it("passes through text under the limit", () => {
    expect(truncateForQwen("hello", 10, { fileName: "a.txt", source: "qwen-text" })).toBe(
      "hello",
    );
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("truncates and logs character counts without content", () => {
    const long = "x".repeat(100);
    const result = truncateForQwen(long, 50, { fileName: "big.md", source: "docling" });

    expect(result).toHaveLength(50);
    expect(logInfo).toHaveBeenCalledWith("document text truncated for qwen", {
      file_name: "big.md",
      source: "docling",
      original_chars: 100,
      max_chars: 50,
    });
    const logPayload = JSON.stringify(vi.mocked(logInfo).mock.calls[0]);
    expect(logPayload).not.toContain("xxxx");
  });
});

describe("capDescription", () => {
  it("caps description length with ellipsis", () => {
    const long = "a".repeat(600);
    expect(capDescription(long, 500)).toHaveLength(500);
    expect(capDescription(long, 500).endsWith("...")).toBe(true);
  });
});

describe("chunkTextForEmbed", () => {
  it("returns single chunk when under limit", () => {
    expect(chunkTextForEmbed("short", 100, 10)).toEqual(["short"]);
  });

  it("splits long input into multiple overlapping chunks", () => {
    const parts = Array.from({ length: 10 }, (_, i) => `receipt-${i} ${"x".repeat(80)}`);
    const text = parts.join("\n");
    expect(text.length).toBeGreaterThan(200);

    const chunks = chunkTextForEmbed(text, 200, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
    // Overlap: consecutive chunks should share some content near the boundary.
    expect(chunks[0].length + chunks[1].length).toBeGreaterThan(200);
  });

  it("covers the full FSA-Receipts-sized folder summary without dropping the tail", () => {
    // Mimic folder-summarizer: up to 20 children × ~500-char descriptions.
    const children = Array.from({ length: 20 }, (_, i) => {
      const desc = `FSA receipt ${i}: pharmacy visit, amount $12.${String(i).padStart(2, "0")}, ${"detail ".repeat(60)}`;
      return `- receipt-${i}.pdf: ${desc.slice(0, 500)}`;
    });
    const text = `Folder containing 20 documents:\n` + children.join("\n");
    expect(text.length).toBeGreaterThan(8_000);

    const chunks = chunkTextForEmbed(text, 1_500, 100);
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1_500);
    }
    const joined = chunks.join("");
    expect(joined).toContain("receipt-0.pdf");
    expect(joined).toContain("receipt-19.pdf");
  });
});

describe("preflightEmbedChunk", () => {
  it("truncates and logs structured reason when somehow over limit", () => {
    vi.mocked(logWarn).mockClear();
    const result = preflightEmbedChunk("y".repeat(100), 50, {
      path: "/Documents/USA/Taxes/2026/FSA Receipts",
      source: "folder-rebuild",
      chunkIndex: 2,
    });
    expect(result).toHaveLength(50);
    expect(logWarn).toHaveBeenCalledWith(
      "embed chunk truncated over limit",
      expect.objectContaining({
        path: "/Documents/USA/Taxes/2026/FSA Receipts",
        reason: "over_max_embed_chars",
        chunk_index: 2,
      }),
    );
  });
});

describe("meanPoolNormalize", () => {
  it("averages and L2-normalizes vectors", () => {
    const a = [1, 0, 0, 0];
    const b = [0, 1, 0, 0];
    const pooled = meanPoolNormalize([a, b]);
    expect(pooled).toHaveLength(4);
    const norm = Math.sqrt(pooled.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(pooled[0]).toBeCloseTo(pooled[1], 5);
  });
});
