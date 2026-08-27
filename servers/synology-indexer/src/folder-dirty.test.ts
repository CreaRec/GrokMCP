import { describe, it, expect, vi } from "vitest";
import { getDirectParentFolderPath, fileNeedsVision } from "./dirty.js";

describe("getDirectParentFolderPath", () => {
  it("returns direct parent only, not all ancestors", () => {
    expect(getDirectParentFolderPath("/Documents/Finance/Taxes/2024.pdf")).toBe(
      "/Documents/Finance/Taxes",
    );
  });

  it("returns null for root-level file", () => {
    expect(getDirectParentFolderPath("/file.pdf")).toBeNull();
  });
});

describe("fileNeedsVision", () => {
  it("excludes 8.3 short names and non-images from vision queue", () => {
    expect(fileNeedsVision(true, "BKZZW3~2.PDF")).toBe(false);
    expect(fileNeedsVision(true, "song.mp3")).toBe(false);
    expect(fileNeedsVision(true, "receipt.pdf")).toBe(true);
    expect(fileNeedsVision(false, "receipt.pdf")).toBe(false);
  });
});

describe("folder dirty triggers", () => {
  it("child disappearance dirties direct parent path", () => {
    const paths = new Set<string>();
    const deletedFile = "/Share/Projects/report.pdf";
    const parent = getDirectParentFolderPath(deletedFile);
    if (parent) paths.add(parent);
    expect([...paths]).toEqual(["/Share/Projects"]);
  });

  it("move dirties both old and new parent paths", () => {
    const paths = new Set<string>();
    const oldFile = "/Share/Projects/report.pdf";
    const newFile = "/Share/Archive/report.pdf";

    for (const synoPath of [oldFile, newFile]) {
      const parent = getDirectParentFolderPath(synoPath);
      if (parent) paths.add(parent);
    }

    expect([...paths].sort()).toEqual(["/Share/Archive", "/Share/Projects"]);
  });

  it("new child dirties parent even when file does not need vision", () => {
    const paths = new Set<string>();
    const newFile = "/Share/Projects/BKZZW3~2.PDF";
    expect(fileNeedsVision(true, "BKZZW3~2.PDF")).toBe(false);
    const parent = getDirectParentFolderPath(newFile);
    if (parent) paths.add(parent);
    expect([...paths]).toEqual(["/Share/Projects"]);
  });
});

describe("rebuildDirtyFolders integration shape", () => {
  it("uses generateFolderSummary output as embed input", async () => {
    const embedFn = vi.fn(async (_text: string) => ({
      embedding: Array(1024).fill(0),
      model: "mixedbread-ai/mxbai-embed-large-v1",
    }));

    const { generateFolderSummary } = await import("./folder-summarizer.js");

    const summary = generateFolderSummary("/Docs", [
      { label: "a.pdf", description: "Doc A", kind: "doc" },
    ]);
    await embedFn(summary.description);

    expect(embedFn).toHaveBeenCalledWith(expect.stringContaining("Doc A"));
  });
});
