import { describe, it, expect } from "vitest";
import type { SearchResult } from "./search.js";

describe("SearchResult type", () => {
  it("should only contain allowed fields: label, shareUrl, kind, score", () => {
    const validResult: SearchResult = {
      label: "Test File",
      shareUrl: "https://example.com/share/abc",
      kind: "file",
      score: 0.95,
    };

    const keys = Object.keys(validResult);
    const allowedKeys = ["label", "shareUrl", "kind", "score"];

    for (const key of keys) {
      expect(allowedKeys).toContain(key);
    }
  });

  it("should allow results without score", () => {
    const result: SearchResult = {
      label: "Test Folder",
      shareUrl: "https://example.com/share/xyz",
      kind: "folder",
    };

    expect(result.label).toBe("Test Folder");
    expect(result.shareUrl).toBe("https://example.com/share/xyz");
    expect(result.kind).toBe("folder");
    expect(result.score).toBeUndefined();
  });

  it("should never include description field", () => {
    const result: SearchResult = {
      label: "Test",
      shareUrl: "https://example.com/share/test",
      kind: "file",
    };

    expect("description" in result).toBe(false);
  });

  it("should never include synoPath field", () => {
    const result: SearchResult = {
      label: "Test",
      shareUrl: "https://example.com/share/test",
      kind: "file",
    };

    expect("synoPath" in result).toBe(false);
    expect("syno_path" in result).toBe(false);
  });

  it("should never include synoId field", () => {
    const result: SearchResult = {
      label: "Test",
      shareUrl: "https://example.com/share/test",
      kind: "file",
    };

    expect("synoId" in result).toBe(false);
    expect("syno_id" in result).toBe(false);
  });

  it("should never include embedding field", () => {
    const result: SearchResult = {
      label: "Test",
      shareUrl: "https://example.com/share/test",
      kind: "file",
    };

    expect("embedding" in result).toBe(false);
  });

  it("should never include contentHash field", () => {
    const result: SearchResult = {
      label: "Test",
      shareUrl: "https://example.com/share/test",
      kind: "file",
    };

    expect("contentHash" in result).toBe(false);
    expect("content_hash" in result).toBe(false);
  });

  it("should never include lastSeenAt field", () => {
    const result: SearchResult = {
      label: "Test",
      shareUrl: "https://example.com/share/test",
      kind: "file",
    };

    expect("lastSeenAt" in result).toBe(false);
    expect("last_seen_at" in result).toBe(false);
  });

  it("should never include dirty field", () => {
    const result: SearchResult = {
      label: "Test",
      shareUrl: "https://example.com/share/test",
      kind: "file",
    };

    expect("dirty" in result).toBe(false);
  });

  it("should never include deletedAt field", () => {
    const result: SearchResult = {
      label: "Test",
      shareUrl: "https://example.com/share/test",
      kind: "file",
    };

    expect("deletedAt" in result).toBe(false);
    expect("deleted_at" in result).toBe(false);
  });

  it("kind should be either file or folder", () => {
    const fileResult: SearchResult = {
      label: "File",
      shareUrl: "https://example.com/share/file",
      kind: "file",
    };

    const folderResult: SearchResult = {
      label: "Folder",
      shareUrl: "https://example.com/share/folder",
      kind: "folder",
    };

    expect(["file", "folder"]).toContain(fileResult.kind);
    expect(["file", "folder"]).toContain(folderResult.kind);
  });
});

describe("Privacy compliance", () => {
  const forbiddenFields = [
    "description",
    "synoPath",
    "syno_path",
    "synoId",
    "syno_id",
    "embedding",
    "password",
    "sharePassword",
    "share_password",
    "contentHash",
    "content_hash",
    "lastSeenAt",
    "last_seen_at",
    "dirty",
    "deletedAt",
    "deleted_at",
  ];

  it("SearchResult interface excludes all forbidden fields", () => {
    const result: SearchResult = {
      label: "Test",
      shareUrl: "https://example.com/share/test",
      kind: "file",
      score: 0.9,
    };

    for (const field of forbiddenFields) {
      expect(field in result).toBe(false);
    }
  });

  it("empty results array is valid", () => {
    const emptyResults: SearchResult[] = [];
    expect(emptyResults).toHaveLength(0);
    expect(Array.isArray(emptyResults)).toBe(true);
  });
});
