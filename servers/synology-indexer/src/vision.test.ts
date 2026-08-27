import { describe, it, expect, vi } from "vitest";
import { classifyMedia, isContentIndexable } from "./media.js";
import {
  hasUsablePdfText,
  labelFromPdfText,
  descriptionFromPdfText,
  PDF_VISION_MAX_PAGES,
} from "./pdf.js";
import {
  describeFileContent,
  describeWithVision,
  prepareVisionImageBase64,
} from "./vision.js";
import { shouldMarkDirty, fileNeedsVision } from "./dirty.js";
import { planIndexWork } from "./index-plan.js";

describe("classifyMedia", () => {
  it("classifies rasters", () => {
    expect(classifyMedia("photo.JPG")).toBe("raster");
    expect(classifyMedia("a.png")).toBe("raster");
    expect(classifyMedia("x.webp")).toBe("raster");
    expect(classifyMedia("y.gif")).toBe("raster");
  });

  it("classifies pdf", () => {
    expect(classifyMedia("receipt.pdf")).toBe("pdf");
    expect(classifyMedia("/Documents/Taxes/FSA Receipts/receipt.PDF")).toBe("pdf");
  });

  it("skips non-images", () => {
    for (const name of [
      "song.mp3",
      "notes.txt",
      "deck.pptx",
      "doc.docx",
      "clip.wav",
      "video.mp4",
      "raw.CR2",
      "photo.heic",
    ]) {
      expect(classifyMedia(name)).toBe("skip");
      expect(isContentIndexable(name)).toBe(false);
    }
  });
});

describe("dirty skip for non-images", () => {
  it("does not mark mp3/txt/docx/pptx dirty", () => {
    for (const name of ["song.mp3", "notes.txt", "deck.pptx", "report.docx"]) {
      const result = shouldMarkDirty(null, "hash", name);
      expect(result.dirty).toBe(false);
      expect(result.reason).toBe("skipped_media");
      expect(fileNeedsVision(true, name)).toBe(false);
    }
  });

  it("still queues receipt.pdf and rasters", () => {
    expect(shouldMarkDirty(null, "hash", "receipt.pdf").dirty).toBe(true);
    expect(shouldMarkDirty(null, "hash", "photo.jpg").dirty).toBe(true);
    expect(fileNeedsVision(true, "receipt.pdf")).toBe(true);
    expect(fileNeedsVision(true, "photo.jpg")).toBe(true);
  });

  it("does not re-dirty skipped media when incomplete", () => {
    const existing = {
      id: "1",
      contentHash: "h",
      hasEmbedding: false,
      description: null,
    };
    expect(shouldMarkDirty(existing, "h", "song.mp3").reason).toBe("skipped_media");
  });
});

describe("pdf text heuristics", () => {
  it("rejects empty or tiny extract as scan", () => {
    expect(hasUsablePdfText("")).toBe(false);
    expect(hasUsablePdfText("   \n\n  ")).toBe(false);
    expect(hasUsablePdfText("short")).toBe(false);
  });

  it("accepts real digital text", () => {
    const text = "Form 1099-NEC\nPayer: Acme Corp\nRecipient compensation: $1,200.00 for consulting.";
    expect(hasUsablePdfText(text)).toBe(true);
    expect(labelFromPdfText(text, "fallback.pdf")).toBe("Form 1099-NEC");
    expect(descriptionFromPdfText(text)).toContain("Acme Corp");
  });
});

describe("planIndexWork with text PDFs", () => {
  it("uses cpu_folders when only text PDFs are pending", () => {
    expect(planIndexWork(0, 0, 3)).toBe("cpu_folders");
  });

  it("uses gpu_vision when any scan/raster needs VLM", () => {
    expect(planIndexWork(1, 0, 5)).toBe("gpu_vision");
  });
});

describe("describeFileContent pipeline", () => {
  it("skips non-images without calling vision or encode", async () => {
    const encodeImage = vi.fn();
    const describeImages = vi.fn();
    const result = await describeFileContent(
      "/mnt/x/song.mp3",
      "http://ollama.example",
      "qwen2.5vl:7b",
      { encodeImage, describeImages },
    );
    expect(result).toEqual({ mode: "skip", reason: "unsupported_media" });
    expect(encodeImage).not.toHaveBeenCalled();
    expect(describeImages).not.toHaveBeenCalled();
  });

  it("text PDF uses extracted text and never calls vision", async () => {
    const digital =
      "Quarterly Report\nRevenue grew 12% year over year with strong retention across enterprise accounts.";
    const encodeImage = vi.fn();
    const describeImages = vi.fn();
    const rasterizePdfPages = vi.fn();

    const result = await describeFileContent(
      "/mnt/x/report.pdf",
      "http://ollama.example",
      "qwen2.5vl:7b",
      {
        extractPdfText: async () => digital,
        rasterizePdfPages,
        encodeImage,
        describeImages,
      },
    );

    expect(result.mode).toBe("text");
    if (result.mode === "text") {
      expect(result.label).toBe("Quarterly Report");
      expect(result.description).toContain("Revenue grew");
    }
    expect(describeImages).not.toHaveBeenCalled();
    expect(rasterizePdfPages).not.toHaveBeenCalled();
    expect(encodeImage).not.toHaveBeenCalled();
  });

  it("scan PDF falls back to page images (not raw PDF bytes)", async () => {
    const pageJpeg = Buffer.from("fake-jpeg-page");
    const encodeImage = vi.fn(async (input: string | Buffer) => {
      expect(Buffer.isBuffer(input)).toBe(true);
      expect(input).toBe(pageJpeg);
      return "BASE64_PAGE";
    });
    const describeImages = vi.fn(async (images: string[]) => {
      expect(images).toEqual(["BASE64_PAGE"]);
      return { label: "Receipt", description: "Scanned FSA receipt", redacted: false };
    });
    const rasterizePdfPages = vi.fn(async () => [pageJpeg]);

    const result = await describeFileContent(
      "/Documents/USA/Taxes/2026/FSA Receipts/receipt.pdf",
      "http://ollama.example",
      "qwen2.5vl:7b",
      {
        extractPdfText: async () => "   ",
        rasterizePdfPages,
        encodeImage,
        describeImages,
      },
    );

    expect(rasterizePdfPages).toHaveBeenCalledWith(
      "/Documents/USA/Taxes/2026/FSA Receipts/receipt.pdf",
      PDF_VISION_MAX_PAGES,
    );
    expect(encodeImage).toHaveBeenCalledTimes(1);
    expect(describeImages).toHaveBeenCalledWith(
      ["BASE64_PAGE"],
      "http://ollama.example",
      "qwen2.5vl:7b",
      "receipt.pdf",
    );
    expect(result.mode).toBe("vision");
  });

  it("prepareVisionImageBase64 rejects PDF paths (never raw-PDF-as-image)", async () => {
    await expect(prepareVisionImageBase64("/tmp/receipt.pdf")).rejects.toThrow(/raster/i);
  });

  it("describeWithVision posts only provided image base64 arrays", async () => {
    const posted: { images?: string[] }[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      posted.push(JSON.parse(String(init?.body ?? "{}")) as { images?: string[] });
      return {
        ok: true,
        json: async () => ({
          response: "LABEL: Cat\nDESCRIPTION: A cat on a mat.",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await describeWithVision(
      ["abc123"],
      "http://ollama.example:11434",
      "qwen2.5vl:7b",
      "cat.jpg",
    );

    expect(result.label).toBe("Cat");
    expect(fetchMock).toHaveBeenCalled();
    expect(posted[0]?.images).toEqual(["abc123"]);
    expect(posted[0]?.images?.[0]).not.toContain("%PDF");

    vi.unstubAllGlobals();
  });
});
