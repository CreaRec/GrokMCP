import { describe, it, expect } from "vitest";
import { classifyFileRoute, getFileExtension, routeNeedsQwen } from "./file-route.js";

describe("classifyFileRoute", () => {
  describe("docling documents (~203 production files)", () => {
    const docling = ["pdf", "xlsx", "docx", "epub", "pptx", "html", "csv"] as const;

    for (const ext of docling) {
      it(`routes .${ext} via docling`, () => {
        expect(classifyFileRoute(`report.${ext}`)).toBe("docling");
        expect(classifyFileRoute(`Report.${ext.toUpperCase()}`)).toBe("docling");
      });
    }
  });

  describe("qwen images (~142 production files)", () => {
    for (const ext of ["jpg", "jpeg", "png"] as const) {
      it(`routes .${ext} via qwen-image`, () => {
        expect(classifyFileRoute(`photo.${ext}`)).toBe("qwen-image");
      });
    }

    it("routes .heic via heic (convert then qwen-image)", () => {
      expect(classifyFileRoute("IMG_1234.heic")).toBe("heic");
      expect(classifyFileRoute("scan.HEIC")).toBe("heic");
    });
  });

  describe("plain text embed (~36 production files)", () => {
    const text = ["txt", "sql", "js", "json", "md", "xml", "conf", "css", "properties", "sh"] as const;

    for (const ext of text) {
      it(`routes .${ext} via text-embed`, () => {
        expect(classifyFileRoute(`notes.${ext}`)).toBe("text-embed");
      });
    }
  });

  describe("skip (~65 production files)", () => {
    const skip = [
      "mp3",
      "wav",
      "svg",
      "ico",
      "psd",
      "otf",
      "pem",
      "crt",
      "key",
      "p12",
      "ovpn",
      "kdb",
      "bson",
      "bak",
      "backup",
      "iml",
      "default",
      "webmanifest",
    ] as const;

    for (const ext of skip) {
      it(`skips .${ext}`, () => {
        expect(classifyFileRoute(`file.${ext}`)).toBe("skip");
      });
    }

    it("skips files with no extension", () => {
      expect(classifyFileRoute("Makefile")).toBe("skip");
      expect(classifyFileRoute("LICENSE")).toBe("skip");
    });

    it("skips unknown binary extensions", () => {
      expect(classifyFileRoute("archive.exe")).toBe("skip");
      expect(classifyFileRoute("data.bin")).toBe("skip");
    });
  });
});

describe("routeNeedsQwen", () => {
  it("is true for docling, qwen-image, and heic", () => {
    expect(routeNeedsQwen("docling")).toBe(true);
    expect(routeNeedsQwen("qwen-image")).toBe(true);
    expect(routeNeedsQwen("heic")).toBe(true);
  });

  it("is false for text-embed and skip", () => {
    expect(routeNeedsQwen("text-embed")).toBe(false);
    expect(routeNeedsQwen("skip")).toBe(false);
  });
});

describe("getFileExtension", () => {
  it("returns lowercase extension", () => {
    expect(getFileExtension("Report.PDF")).toBe("pdf");
  });

  it("returns null for dotfiles treated as no extension", () => {
    expect(getFileExtension(".gitignore")).toBe(null);
  });
});
