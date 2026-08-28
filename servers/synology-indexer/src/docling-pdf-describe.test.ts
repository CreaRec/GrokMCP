import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "./config.js";

const convertFileToMarkdownMock = vi.fn();
const describeFromDocumentTextMock = vi.fn();
const describeWithVisionImageMock = vi.fn();
const rasterizePdfFirstPageToJpegMock = vi.fn();
const cleanupPdfPageJpegTempMock = vi.fn();
const logInfoMock = vi.fn();

vi.mock("./docling-client.js", async () => {
  const actual = await vi.importActual<typeof import("./docling-client.js")>("./docling-client.js");
  return {
    ...actual,
    convertFileToMarkdown: (...args: unknown[]) => convertFileToMarkdownMock(...args),
  };
});

vi.mock("./vision.js", () => ({
  describeFromDocumentText: (...args: unknown[]) => describeFromDocumentTextMock(...args),
  describeWithVisionImage: (...args: unknown[]) => describeWithVisionImageMock(...args),
}));

vi.mock("./pdf-page-jpeg.js", () => ({
  rasterizePdfFirstPageToJpeg: (...args: unknown[]) => rasterizePdfFirstPageToJpegMock(...args),
  cleanupPdfPageJpegTemp: (...args: unknown[]) => cleanupPdfPageJpegTempMock(...args),
}));

vi.mock("./telemetry.js", () => ({
  logInfo: (...args: unknown[]) => logInfoMock(...args),
}));

import { describeDoclingPdfWithFallback } from "./docling-pdf-describe.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: "postgresql://test",
    mountRoot: "/mnt/test",
    indexDailyAt: "21:00",
    timezone: "America/Chicago",
    runOnce: false,
    ollamaBaseUrl: null,
    visionModel: "vision",
    embedModel: "embed",
    dsmHost: null,
    dsmShareUser: null,
    dsmSharePassword: null,
    runpodApiKey: null,
    runpodPodId: null,
    runpodTemplateId: null,
    runpodImage: "ollama/ollama",
    runpodCloudType: "SECURE",
    runpodGpuTypeId: "NVIDIA GeForce RTX 4090",
    runpodContainerDiskGb: 80,
    runpodDataCenterId: null,
    runpodOllamaPort: 11434,
    runpodOllamaHealthyTimeoutMs: 600_000,
    runpodLeaveRunning: false,
    doclingServeUrl: "http://docling-serve:5001",
    doclingContainerName: "grok-mcp-docling-serve",
    doclingHealthyTimeoutMs: 300_000,
    doclingLeaveRunning: false,
    doclingConvertTimeoutMs: 90_000,
    doclingDocumentTimeoutSec: 90,
    doclingPageRangeEnd: 5,
    textHeadBytes: 65_536,
    qwenDocumentChars: 32_768,
    maxDescriptionChars: 500,
    dockerSocketPath: "/var/run/docker.sock",
    ...overrides,
  };
}

const PDF_PATH = "/mnt/synology/Documents/Full time Offer - Stoke Space.pdf";
const DESCRIBE_OPTS = { source: "docling" as const };

describe("describeDoclingPdfWithFallback", () => {
  beforeEach(() => {
    convertFileToMarkdownMock.mockReset();
    describeFromDocumentTextMock.mockReset();
    describeWithVisionImageMock.mockReset();
    rasterizePdfFirstPageToJpegMock.mockReset();
    cleanupPdfPageJpegTempMock.mockReset();
    logInfoMock.mockReset();
    cleanupPdfPageJpegTempMock.mockResolvedValue(undefined);

    describeFromDocumentTextMock.mockResolvedValue({
      label: "Offer",
      description: "Job offer letter",
      redacted: false,
    });
    describeWithVisionImageMock.mockResolvedValue({
      label: "Offer scan",
      description: "Vision fallback",
      redacted: false,
    });
    rasterizePdfFirstPageToJpegMock.mockResolvedValue({
      jpegPath: "/tmp/synology-pdf-page-jpeg-abc/Offer.jpg",
      tempDir: "/tmp/synology-pdf-page-jpeg-abc",
      jpegBytes: 2048,
    });
  });

  it("returns markdown describe on first 5-page Docling success", async () => {
    convertFileToMarkdownMock.mockResolvedValue("# Offer\n\nBody");

    const result = await describeDoclingPdfWithFallback(
      PDF_PATH,
      "Full time Offer - Stoke Space.pdf",
      makeConfig(),
      "http://ollama:11434",
      DESCRIBE_OPTS,
    );

    expect(result.description).toBe("Job offer letter");
    expect(convertFileToMarkdownMock).toHaveBeenCalledOnce();
    expect(convertFileToMarkdownMock).toHaveBeenCalledWith(
      PDF_PATH,
      "http://docling-serve:5001",
      expect.objectContaining({ pageRange: [1, 5], convertTimeoutMs: 90_000 }),
    );
    expect(describeWithVisionImageMock).not.toHaveBeenCalled();
    expect(logInfoMock).toHaveBeenCalledWith("docling gist attempt", {
      source: "Full time Offer - Stoke Space.pdf",
      from_pages: 1,
      to_pages: 5,
    });
  });

  it("retries with 1-page gist after heavy 5-page failure then succeeds", async () => {
    convertFileToMarkdownMock
      .mockRejectedValueOnce(new Error("Docling conversion timed out after 90000ms"))
      .mockResolvedValueOnce("# Page 1");

    const result = await describeDoclingPdfWithFallback(
      PDF_PATH,
      "Full time Offer - Stoke Space.pdf",
      makeConfig(),
      "http://ollama:11434",
      DESCRIBE_OPTS,
    );

    expect(result.description).toBe("Job offer letter");
    expect(convertFileToMarkdownMock).toHaveBeenCalledTimes(2);
    expect(convertFileToMarkdownMock).toHaveBeenNthCalledWith(
      2,
      PDF_PATH,
      "http://docling-serve:5001",
      expect.objectContaining({ pageRange: [1, 1] }),
    );
    expect(logInfoMock).toHaveBeenCalledWith("docling gist fallback", {
      from_pages: 5,
      to_pages: 1,
      reason: "client_timeout",
    });
    expect(rasterizePdfFirstPageToJpegMock).not.toHaveBeenCalled();
  });

  it("falls back to qwen-image after two heavy Docling failures", async () => {
    convertFileToMarkdownMock
      .mockRejectedValueOnce(new Error("Docling conversion failed: HTTP 504"))
      .mockRejectedValueOnce(new Error("Docling conversion timed out after 90000ms"));

    const result = await describeDoclingPdfWithFallback(
      PDF_PATH,
      "Full time Offer - Stoke Space.pdf",
      makeConfig(),
      "http://ollama:11434",
      DESCRIBE_OPTS,
    );

    expect(result.description).toBe("Vision fallback");
    expect(rasterizePdfFirstPageToJpegMock).toHaveBeenCalledWith(PDF_PATH);
    expect(describeWithVisionImageMock).toHaveBeenCalledWith(
      "/tmp/synology-pdf-page-jpeg-abc/Offer.jpg",
      "http://ollama:11434",
      "vision",
    );
    expect(cleanupPdfPageJpegTempMock).toHaveBeenCalledWith("/tmp/synology-pdf-page-jpeg-abc");
    expect(logInfoMock).toHaveBeenCalledWith("docling gist fallback", {
      from_pages: 1,
      to_pages: "qwen-image",
      reason: "client_timeout",
      jpeg_dest: "/tmp/synology-pdf-page-jpeg-abc/Offer.jpg",
      jpeg_bytes: 2048,
    });
  });

  it("does not fallback on non-heavy Docling errors", async () => {
    convertFileToMarkdownMock.mockRejectedValue(
      new Error("Docling conversion returned no markdown content"),
    );

    await expect(
      describeDoclingPdfWithFallback(
        PDF_PATH,
        "Full time Offer - Stoke Space.pdf",
        makeConfig(),
        "http://ollama:11434",
        DESCRIBE_OPTS,
      ),
    ).rejects.toThrow("no markdown content");

    expect(convertFileToMarkdownMock).toHaveBeenCalledOnce();
    expect(rasterizePdfFirstPageToJpegMock).not.toHaveBeenCalled();
    expect(logInfoMock).not.toHaveBeenCalledWith(
      "docling gist fallback",
      expect.anything(),
    );
  });

  it("rejects non-PDF paths (no jpeg fallback path)", async () => {
    await expect(
      describeDoclingPdfWithFallback(
        "/mnt/synology/Documents/report.docx",
        "report.docx",
        makeConfig(),
        "http://ollama:11434",
        DESCRIBE_OPTS,
      ),
    ).rejects.toThrow("PDF-only");

    expect(convertFileToMarkdownMock).not.toHaveBeenCalled();
    expect(rasterizePdfFirstPageToJpegMock).not.toHaveBeenCalled();
  });

  it("cleans up jpeg temp dir when vision describe throws", async () => {
    convertFileToMarkdownMock
      .mockRejectedValueOnce(new Error("Docling conversion failed: HTTP 524"))
      .mockRejectedValueOnce(new Error("Docling conversion failed: HTTP 524"));
    describeWithVisionImageMock.mockRejectedValue(new Error("qwen down"));

    await expect(
      describeDoclingPdfWithFallback(
        PDF_PATH,
        "Full time Offer - Stoke Space.pdf",
        makeConfig(),
        "http://ollama:11434",
        DESCRIBE_OPTS,
      ),
    ).rejects.toThrow("qwen down");

    expect(cleanupPdfPageJpegTempMock).toHaveBeenCalledWith("/tmp/synology-pdf-page-jpeg-abc");
  });
});
