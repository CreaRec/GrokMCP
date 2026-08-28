import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { describeFromDocumentText, describeWithVisionImage } from "./vision.js";

vi.mock("./telemetry.js", () => ({
  logInfo: vi.fn(),
}));

import { logInfo } from "./telemetry.js";

describe("describeFromDocumentText", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.mocked(logInfo).mockReset();
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
    expect(body.prompt).toContain("GIST");
    expect(body.prompt).toContain("beginning of the file");
    expect(body.prompt).toContain("not the full document");
    expect(body.images).toBeUndefined();
  });

  it("sends plain file text as prompt body without images[]", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: "LABEL: Config\nDESCRIPTION: Application settings file.",
      }),
    });

    const result = await describeFromDocumentText(
      "PORT=8080\nDEBUG=true",
      "app.properties",
      "http://ollama:11434",
      "qwen2.5vl:7b",
      { source: "qwen-text" },
    );

    expect(result.label).toBe("Config");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { prompt: string; images?: string[] };
    expect(body.prompt).toContain("PORT=8080");
    expect(body.prompt).toContain("DOCUMENT EXCERPT");
    expect(body.images).toBeUndefined();
  });

  it("truncates oversized document text before sending to qwen", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: "LABEL: Long\nDESCRIPTION: Excerpt only.",
      }),
    });

    const longDoc = "Z".repeat(50_000);
    await describeFromDocumentText(longDoc, "dune.epub", "http://ollama:11434", "qwen", {
      qwenDocumentChars: 32_768,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { prompt: string };
    expect(body.prompt.length).toBeLessThan(longDoc.length);
    expect(body.prompt).not.toContain("Z".repeat(40_000));
    expect(logInfo).toHaveBeenCalledWith("document text truncated for qwen", {
      file_name: "dune.epub",
      source: "docling",
      original_chars: 50_000,
      max_chars: 32_768,
    });
  });

  it("caps DESCRIPTION length before returning", async () => {
    const longDesc = "D".repeat(800);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: `LABEL: Test\nDESCRIPTION: ${longDesc}`,
      }),
    });

    const result = await describeFromDocumentText(
      "content",
      "doc.pdf",
      "http://ollama:11434",
      "qwen",
      { maxDescriptionChars: 500 },
    );

    expect(result.description.length).toBeLessThanOrEqual(500);
    expect(result.description.endsWith("...")).toBe(true);
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
