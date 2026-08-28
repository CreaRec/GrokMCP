import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { describeFromDocumentText, describeWithVisionImage } from "./vision.js";

describe("describeFromDocumentText", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Docling markdown as prompt text without images[]", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: "LABEL: Quarterly Report\nDESCRIPTION: Revenue summary for Q1.",
      }),
    });

    const result = await describeFromDocumentText(
      "# Quarterly Report\n\nRevenue was up 10%.",
      "report.pdf",
      "http://ollama:11434",
      "qwen2.5vl:7b",
    );

    expect(result.label).toBe("Quarterly Report");
    expect(result.description).toBe("Revenue summary for Q1.");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      prompt: string;
      images?: string[];
    };

    expect(body.prompt).toContain("# Quarterly Report");
    expect(body.prompt).toContain("Revenue was up 10%.");
    expect(body.images).toBeUndefined();
  });

  it("does not include Ollama URL in error text", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 });

    await expect(
      describeFromDocumentText("content", "doc.pdf", "http://secret-ollama:11434", "qwen"),
    ).rejects.toThrow("Vision model request failed: HTTP 400");

    await expect(
      describeFromDocumentText("content", "doc.pdf", "http://secret-ollama:11434", "qwen"),
    ).rejects.not.toThrow(/secret-ollama/);
  });
});

describe("describeWithVisionImage", () => {
  it("is exported for image routes", () => {
    expect(typeof describeWithVisionImage).toBe("function");
  });
});
