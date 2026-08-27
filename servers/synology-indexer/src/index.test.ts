import { describe, it, expect } from "vitest";
import {
  shouldMarkDirty,
  shouldRebuildFolder,
  getParentFolderPaths,
  getDirectParentFolderPath,
  fileNeedsVision,
  shouldAbortSoftDelete,
  isEligibleForHardDelete,
  shouldUndelete,
  isDos83ShortBasename,
} from "./dirty.js";
import { generateFolderSummary } from "./folder-summarizer.js";
import { mountPathToSynoPath } from "./walker.js";
import { parseIndexTime } from "./config.js";

describe("isDos83ShortBasename", () => {
  it("detects issue #27 CIFS short names", () => {
    expect(isDos83ShortBasename("BKZZW3~2.PDF")).toBe(true);
    expect(isDos83ShortBasename("BY3IVZ~I.PDF")).toBe(true);
    expect(isDos83ShortBasename("GT50G8~Y.PDF")).toBe(true);
    expect(isDos83ShortBasename("/Documents/Archive/GN invite 2024/BKZZW3~2.PDF")).toBe(true);
  });

  it("does not match normal long names like receipt.pdf", () => {
    expect(isDos83ShortBasename("receipt.pdf")).toBe(false);
    expect(isDos83ShortBasename("Booking.com: Potwierdzenie.pdf")).toBe(false);
    expect(isDos83ShortBasename("Gmail - Fwd: Thank you for shopping at Walgreens..pdf")).toBe(false);
  });
});

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
      hasEmbedding: false,
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
      hasEmbedding: true,
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
      hasEmbedding: true,
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
      hasEmbedding: true,
      description: "Description",
    };
    const result = shouldMarkDirty(existing, "same-hash");
    expect(result.dirty).toBe(false);
    expect(result.reason).toBe("clean");
  });

  it("keeps dirty when hash matches but embedding is missing (incomplete)", () => {
    const existing = {
      id: "receipt-id",
      contentHash: "same-hash",
      hasEmbedding: false,
      description: null,
    };
    const result = shouldMarkDirty(existing, "same-hash", "receipt.pdf");
    expect(result.dirty).toBe(true);
    expect(result.reason).toBe("incomplete");
  });

  it("keeps dirty when hash matches but description is missing", () => {
    const existing = {
      id: "test-id",
      contentHash: "same-hash",
      hasEmbedding: true,
      description: null,
    };
    const result = shouldMarkDirty(existing, "same-hash");
    expect(result.dirty).toBe(true);
    expect(result.reason).toBe("incomplete");
  });

  it("keeps dirty when hash matches but embedding is missing even if description exists", () => {
    const existing = {
      id: "test-id",
      contentHash: "same-hash",
      hasEmbedding: false,
      description: "Partial vision result",
    };
    const result = shouldMarkDirty(existing, "same-hash");
    expect(result.dirty).toBe(true);
    expect(result.reason).toBe("incomplete");
  });

  it("does not mark 8.3 short names dirty when embedding is missing (skipped_83)", () => {
    const existing = {
      id: "short-id",
      contentHash: "same-hash",
      hasEmbedding: false,
      description: null,
    };
    for (const name of ["BKZZW3~2.PDF", "BY3IVZ~I.PDF", "GT50G8~Y.PDF"] as const) {
      const result = shouldMarkDirty(existing, "same-hash", name);
      expect(result.dirty).toBe(false);
      expect(result.reason).toBe("skipped_83");
    }
  });

  it("does not mark non-image media dirty (skipped_media)", () => {
    const existing = {
      id: "audio-id",
      contentHash: "same-hash",
      hasEmbedding: false,
      description: null,
    };
    for (const name of ["song.mp3", "notes.txt", "deck.pptx", "report.docx"] as const) {
      expect(shouldMarkDirty(null, "new", name)).toEqual({
        dirty: false,
        reason: "skipped_media",
      });
      expect(shouldMarkDirty(existing, "same-hash", name)).toEqual({
        dirty: false,
        reason: "skipped_media",
      });
    }
  });

  it("still marks receipt.pdf dirty when hash matches but embedding is missing", () => {
    const existing = {
      id: "receipt-id",
      contentHash: "receipt-hash",
      hasEmbedding: false,
      description: null,
    };
    const result = shouldMarkDirty(existing, "receipt-hash", "receipt.pdf");
    expect(result.dirty).toBe(true);
    expect(result.reason).toBe("incomplete");
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

describe("getDirectParentFolderPath", () => {
  it("returns the immediate parent folder", () => {
    expect(getDirectParentFolderPath("/Documents/Finance/Taxes/2024.pdf")).toBe(
      "/Documents/Finance/Taxes",
    );
  });
});

describe("fileNeedsVision", () => {
  it("requires vision for dirty rasters and PDFs only", () => {
    expect(fileNeedsVision(true, "receipt.pdf")).toBe(true);
    expect(fileNeedsVision(true, "photo.jpg")).toBe(true);
    expect(fileNeedsVision(true, "BKZZW3~2.PDF")).toBe(false);
    expect(fileNeedsVision(true, "song.mp3")).toBe(false);
    expect(fileNeedsVision(true, "notes.txt")).toBe(false);
    expect(fileNeedsVision(false, "receipt.pdf")).toBe(false);
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
      hasEmbedding: true,
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
      hasEmbedding: false,
      description: null,
    };

    const result = shouldMarkDirty(existingWithoutEmbedding, "new-hash-from-backfill");

    expect(result.dirty).toBe(true);
    expect(result.reason).toBe("hash_missing");
  });
});

describe("shouldAbortSoftDelete", () => {
  it("aborts when seen file count is zero", () => {
    const result = shouldAbortSoftDelete(0, 100);
    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe("zero_seen");
  });

  it("aborts when seen count is less than half of previous", () => {
    const result = shouldAbortSoftDelete(10, 100);
    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe("less_than_half");
  });

  it("does not abort when seen count equals half of previous", () => {
    const result = shouldAbortSoftDelete(50, 100);
    expect(result.shouldAbort).toBe(false);
    expect(result.reason).toBe("ok");
  });

  it("does not abort when seen count is greater than half", () => {
    const result = shouldAbortSoftDelete(60, 100);
    expect(result.shouldAbort).toBe(false);
    expect(result.reason).toBe("ok");
  });

  it("does not abort when no previous files exist", () => {
    const result = shouldAbortSoftDelete(0, 0);
    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe("zero_seen");
  });

  it("does not abort with first scan (previousCount=0, seen>0)", () => {
    const result = shouldAbortSoftDelete(50, 0);
    expect(result.shouldAbort).toBe(false);
    expect(result.reason).toBe("ok");
  });

  it("aborts at exactly less than half (49 seen out of 100)", () => {
    const result = shouldAbortSoftDelete(49, 100);
    expect(result.shouldAbort).toBe(true);
    expect(result.reason).toBe("less_than_half");
  });
});

describe("isEligibleForHardDelete", () => {
  it("returns false when deletedAt is null", () => {
    const now = new Date();
    expect(isEligibleForHardDelete(null, now)).toBe(false);
  });

  it("returns false when deleted less than 30 days ago", () => {
    const now = new Date();
    const twentyNineDaysAgo = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    expect(isEligibleForHardDelete(twentyNineDaysAgo, now)).toBe(false);
  });

  it("returns true when deleted exactly 30 days ago", () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(isEligibleForHardDelete(thirtyDaysAgo, now)).toBe(true);
  });

  it("returns true when deleted more than 30 days ago", () => {
    const now = new Date();
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    expect(isEligibleForHardDelete(sixtyDaysAgo, now)).toBe(true);
  });
});

describe("shouldUndelete", () => {
  it("undeletes a previously soft-deleted file when seen again", () => {
    const existing = {
      id: "test-id",
      contentHash: "same-hash",
      hasEmbedding: true,
      description: "Description",
      deletedAt: new Date(),
    };
    const result = shouldUndelete(existing, "same-hash");
    expect(result.undelete).toBe(true);
    expect(result.dirty).toBe(false);
    expect(result.reason).toBe("undeleted_clean");
  });

  it("undeletes and marks dirty when hash changed", () => {
    const existing = {
      id: "test-id",
      contentHash: "old-hash",
      hasEmbedding: true,
      description: "Description",
      deletedAt: new Date(),
    };
    const result = shouldUndelete(existing, "new-hash");
    expect(result.undelete).toBe(true);
    expect(result.dirty).toBe(true);
    expect(result.reason).toBe("undeleted_hash_changed");
  });

  it("does not undelete a file that was not deleted", () => {
    const existing = {
      id: "test-id",
      contentHash: "same-hash",
      hasEmbedding: true,
      description: "Description",
      deletedAt: null,
    };
    const result = shouldUndelete(existing, "same-hash");
    expect(result.undelete).toBe(false);
    expect(result.dirty).toBe(false);
    expect(result.reason).toBe("clean");
  });

  it("does not set dirty when hash matches after undelete", () => {
    const existing = {
      id: "test-id",
      contentHash: "same-hash",
      hasEmbedding: true,
      description: "Description",
      deletedAt: new Date(),
    };
    const result = shouldUndelete(existing, "same-hash");
    expect(result.undelete).toBe(true);
    expect(result.dirty).toBe(false);
  });
});

describe("soft-delete behavior", () => {
  it("dirty flag is false when hash unchanged (skip GPU)", () => {
    const existing = {
      id: "test-id",
      contentHash: "unchanged-hash",
      hasEmbedding: true,
      description: "Already processed",
    };
    const result = shouldMarkDirty(existing, "unchanged-hash");
    expect(result.dirty).toBe(false);
  });
});
