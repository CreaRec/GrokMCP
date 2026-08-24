import { describe, it, expect } from "vitest";
import { shouldMarkDirty, shouldRebuildFolder, getParentFolderPaths } from "./dirty.js";
import { generateFolderSummary } from "./folder-summarizer.js";
import { mountPathToSynoPath } from "./walker.js";
import { parseIndexTime } from "./config.js";

describe("shouldMarkDirty", () => {
  it("marks new files as dirty", () => {
    const result = shouldMarkDirty(null, "abc123");
    expect(result.dirty).toBe(true);
    expect(result.reason).toBe("new");
  });

  it("marks files without hash as dirty if no embedding", () => {
    const existing = {
      id: "test-id",
      contentHash: null,
      embedding: null,
      description: null,
    };
    const result = shouldMarkDirty(existing, "abc123");
    expect(result.dirty).toBe(true);
    expect(result.reason).toBe("hash_missing");
  });

  it("does NOT mark files dirty if hash missing but embedding exists", () => {
    const existing = {
      id: "test-id",
      contentHash: null,
      embedding: [0.1, 0.2],
      description: "Already described",
    };
    const result = shouldMarkDirty(existing, "abc123");
    expect(result.dirty).toBe(false);
    expect(result.reason).toBe("clean");
  });

  it("marks files dirty when hash changes", () => {
    const existing = {
      id: "test-id",
      contentHash: "old-hash",
      embedding: [0.1, 0.2],
      description: "Old description",
    };
    const result = shouldMarkDirty(existing, "new-hash");
    expect(result.dirty).toBe(true);
    expect(result.reason).toBe("hash_changed");
  });

  it("does NOT mark files dirty when hash matches", () => {
    const existing = {
      id: "test-id",
      contentHash: "same-hash",
      embedding: [0.1, 0.2],
      description: "Description",
    };
    const result = shouldMarkDirty(existing, "same-hash");
    expect(result.dirty).toBe(false);
    expect(result.reason).toBe("clean");
  });
});

describe("shouldRebuildFolder", () => {
  it("returns true when any child is dirty", () => {
    const dirtyIds = new Set(["file-2"]);
    const childIds = ["file-1", "file-2", "file-3"];
    expect(shouldRebuildFolder(dirtyIds, childIds)).toBe(true);
  });

  it("returns false when no children are dirty", () => {
    const dirtyIds = new Set(["other-file"]);
    const childIds = ["file-1", "file-2", "file-3"];
    expect(shouldRebuildFolder(dirtyIds, childIds)).toBe(false);
  });

  it("returns false for empty dirty set", () => {
    const dirtyIds = new Set<string>();
    const childIds = ["file-1", "file-2"];
    expect(shouldRebuildFolder(dirtyIds, childIds)).toBe(false);
  });

  it("returns false for empty children", () => {
    const dirtyIds = new Set(["file-1"]);
    const childIds: string[] = [];
    expect(shouldRebuildFolder(dirtyIds, childIds)).toBe(false);
  });
});

describe("getParentFolderPaths", () => {
  it("returns all parent paths", () => {
    const result = getParentFolderPaths("/Documents/Finance/Taxes/2024.pdf");
    expect(result).toEqual(["/Documents", "/Documents/Finance", "/Documents/Finance/Taxes"]);
  });

  it("returns empty for root-level file", () => {
    const result = getParentFolderPaths("/file.pdf");
    expect(result).toEqual([]);
  });

  it("handles single parent", () => {
    const result = getParentFolderPaths("/Documents/file.pdf");
    expect(result).toEqual(["/Documents"]);
  });
});

describe("generateFolderSummary", () => {
  it("generates summary with document counts", () => {
    const children = [
      { label: "Tax Return", description: "2024 tax return", kind: "doc" },
      { label: "W2", description: "W2 form", kind: "doc" },
      { label: "Photo", description: "Receipt photo", kind: "photo" },
    ];
    const result = generateFolderSummary("/Documents/Taxes", children);

    expect(result.label).toContain("Taxes");
    expect(result.label).toContain("2 documents");
    expect(result.label).toContain("1 photo");
    expect(result.description).toContain("Tax Return");
  });

  it("handles empty folder", () => {
    const result = generateFolderSummary("/Empty", []);
    expect(result.label).toContain("Empty");
    expect(result.label).toContain("empty");
  });

  it("limits children in description to 20", () => {
    const children = Array.from({ length: 30 }, (_, i) => ({
      label: `File ${i}`,
      description: `Description ${i}`,
      kind: "doc",
    }));
    const result = generateFolderSummary("/LargeFolder", children);

    const descriptionLines = result.description.split("\n").filter((l) => l.startsWith("-"));
    expect(descriptionLines.length).toBeLessThanOrEqual(20);
  });
});

describe("mountPathToSynoPath", () => {
  it("converts mount path to syno path", () => {
    const result = mountPathToSynoPath(
      "/mnt/synology/Documents/Finance/report.pdf",
      "/mnt/synology/Documents",
    );
    expect(result).toBe("/Documents/Finance/report.pdf");
  });

  it("handles root file", () => {
    const result = mountPathToSynoPath(
      "/mnt/synology/Documents/file.pdf",
      "/mnt/synology/Documents",
    );
    expect(result).toBe("/Documents/file.pdf");
  });

  it("handles nested paths", () => {
    const result = mountPathToSynoPath(
      "/mnt/nas/Share/Folder/Sub/file.txt",
      "/mnt/nas/Share",
    );
    expect(result).toBe("/Share/Folder/Sub/file.txt");
  });
});

describe("parseIndexTime", () => {
  it("parses valid time", () => {
    const result = parseIndexTime("21:00");
    expect(result.hour).toBe(21);
    expect(result.minute).toBe(0);
  });

  it("parses single digit hour", () => {
    const result = parseIndexTime("9:30");
    expect(result.hour).toBe(9);
    expect(result.minute).toBe(30);
  });

  it("throws for invalid format", () => {
    expect(() => parseIndexTime("invalid")).toThrow();
  });

  it("throws for invalid hour", () => {
    expect(() => parseIndexTime("25:00")).toThrow();
  });

  it("throws for invalid minute", () => {
    expect(() => parseIndexTime("12:60")).toThrow();
  });
});

describe("backfill hash behavior", () => {
  it("does not mark existing files with embeddings as dirty during hash backfill", () => {
    const existingWithEmbedding = {
      id: "existing-id",
      contentHash: null,
      embedding: [0.1, 0.2, 0.3],
      description: "Already processed",
    };

    const result = shouldMarkDirty(existingWithEmbedding, "new-hash-from-backfill");

    expect(result.dirty).toBe(false);
    expect(result.reason).toBe("clean");
  });

  it("marks existing files without embeddings as dirty during hash backfill", () => {
    const existingWithoutEmbedding = {
      id: "existing-id",
      contentHash: null,
      embedding: null,
      description: null,
    };

    const result = shouldMarkDirty(existingWithoutEmbedding, "new-hash-from-backfill");

    expect(result.dirty).toBe(true);
    expect(result.reason).toBe("hash_missing");
  });
});
