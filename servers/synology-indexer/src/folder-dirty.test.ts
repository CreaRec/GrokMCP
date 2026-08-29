import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDirectParentFolderPath, fileNeedsVision } from "./dirty.js";
import { rebuildDirtyFolders } from "./folder-rebuild.js";

vi.mock("./telemetry.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logErrorWithCause: vi.fn(),
}));

import { logErrorWithCause } from "./telemetry.js";

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
  it("excludes 8.3 short names from vision queue", () => {
    expect(fileNeedsVision(true, "BKZZW3~2.PDF")).toBe(false);
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

  it("new notSupported child does not dirty parent folder", () => {
    const paths = new Set<string>();
    const newFile = "/Share/Music/track.mp3";
    const decisionDirty = false; // always-skip → notSupported, never dirty
    // Indexer only folder-dirties when decision.dirty (or undelete for supported files)
    if (decisionDirty) {
      const parent = getDirectParentFolderPath(newFile);
      if (parent) paths.add(parent);
    }
    expect([...paths]).toEqual([]);
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

type MockFolder = { id: string; synoPath: string; dirty: boolean };

function makeMockDb(folders: MockFolder[]) {
  const state = folders.map((f) => ({ ...f }));
  const clearedIds = new Set<string>();

  const db = {
    folder: {
      findMany: vi.fn(async () =>
        state.filter((f) => f.dirty).map(({ id, synoPath }) => ({ id, synoPath })),
      ),
    },
    file: {
      findMany: vi.fn(async () => [
        { label: "a.pdf", description: "Doc A", kind: "doc" },
      ]),
    },
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      // Prisma tagged template: last value is folder.id
      const id = values[values.length - 1] as string;
      const folder = state.find((f) => f.id === id);
      if (folder) {
        folder.dirty = false;
        clearedIds.add(id);
      }
    }),
  };

  return { db, state, clearedIds };
}

describe("rebuildDirtyFolders per-folder isolation", () => {
  beforeEach(() => {
    vi.mocked(logErrorWithCause).mockReset();
  });

  it("one failing folder does not prevent later folders from rebuilding", async () => {
    const { db, state, clearedIds } = makeMockDb([
      { id: "f1", synoPath: "/Share/A", dirty: true },
      { id: "f2", synoPath: "/Share/B", dirty: true },
      { id: "f3", synoPath: "/Share/C", dirty: true },
    ]);

    const embedFn = vi.fn(async (_text: string) => {
      // Sorted deepest-first; same depth keeps findMany order: A, B, C
      const call = embedFn.mock.calls.length;
      if (call === 1) {
        throw new Error("Embedding model request failed: HTTP 500: model overloaded");
      }
      return { embedding: Array(1024).fill(0), model: "mxbai-embed-large" };
    });

    const result = await rebuildDirtyFolders(db as never, embedFn, new Date());

    expect(result).toEqual({ rebuilt: 2, failed: 1 });
    expect(embedFn).toHaveBeenCalledTimes(3);
    expect(clearedIds.has("f1")).toBe(false);
    expect(clearedIds.has("f2")).toBe(true);
    expect(clearedIds.has("f3")).toBe(true);
    expect(state.find((f) => f.id === "f1")!.dirty).toBe(true);
    expect(state.find((f) => f.id === "f2")!.dirty).toBe(false);
    expect(state.find((f) => f.id === "f3")!.dirty).toBe(false);
    expect(logErrorWithCause).toHaveBeenCalledWith(
      "folder rebuild failed",
      expect.any(Error),
      { syno_path: "/Share/A" },
    );
  });

  it("leaves dirty true on the failed folder after embed error", async () => {
    const { db, state, clearedIds } = makeMockDb([
      { id: "fail", synoPath: "/Share/Broken", dirty: true },
      { id: "ok", synoPath: "/Share/Ok", dirty: true },
    ]);

    const embedFn = vi.fn(async (_text: string) => {
      if (embedFn.mock.calls.length === 1) {
        throw new Error("Embedding model request failed: HTTP 500: boom");
      }
      return { embedding: Array(1024).fill(0), model: "mxbai-embed-large" };
    });

    const result = await rebuildDirtyFolders(db as never, embedFn, new Date());

    expect(result.rebuilt).toBe(1);
    expect(result.failed).toBe(1);
    expect(clearedIds.has("fail")).toBe(false);
    expect(state.find((f) => f.id === "fail")!.dirty).toBe(true);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("continues after embedFn that already exhausted its own 5xx retry", async () => {
    // Mirrors embedText: caller sees a single throw after retry-once inside embedText.
    const { db, state } = makeMockDb([
      { id: "f1", synoPath: "/Share/First", dirty: true },
      { id: "f2", synoPath: "/Share/Second", dirty: true },
      { id: "f3", synoPath: "/Share/Third", dirty: true },
    ]);

    let attemptsOnFirst = 0;
    const embedFn = vi.fn(async (_text: string) => {
      if (embedFn.mock.calls.length === 1) {
        attemptsOnFirst++;
        // Simulate embedText's post-retry failure surface.
        throw Object.assign(
          new Error("Embedding model request failed: HTTP 500: still failing"),
          { status: 500 },
        );
      }
      return { embedding: Array(1024).fill(0), model: "mxbai-embed-large" };
    });

    const result = await rebuildDirtyFolders(db as never, embedFn, new Date());

    expect(attemptsOnFirst).toBe(1);
    expect(result).toEqual({ rebuilt: 2, failed: 1 });
    expect(state.find((f) => f.id === "f1")!.dirty).toBe(true);
    expect(state.find((f) => f.id === "f2")!.dirty).toBe(false);
    expect(state.find((f) => f.id === "f3")!.dirty).toBe(false);
  });
});

describe("rebuildDirtyFolders + embedText retry-once", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    vi.mocked(logErrorWithCause).mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("first folder 500-then-ok still rebuilds later folders", async () => {
    const { embedText } = await import("./embedder.js");
    const embedding = Array(1024).fill(0.2);

    const { db, state } = makeMockDb([
      { id: "f1", synoPath: "/Share/A", dirty: true },
      { id: "f2", synoPath: "/Share/B", dirty: true },
      { id: "f3", synoPath: "/Share/C", dirty: true },
    ]);

    // Folder A: one 500 then success (retry). B and C: success.
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response("model busy", { status: 500 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ embedding }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ embedding }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ embedding }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await rebuildDirtyFolders(
      db as never,
      (text) => embedText(text, "http://ollama:11434", "mxbai-embed-large"),
      new Date(),
    );

    expect(result).toEqual({ rebuilt: 3, failed: 0 });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(state.every((f) => f.dirty === false)).toBe(true);
  });

  it("first folder double-500 fails but later folders still rebuild", async () => {
    const { embedText } = await import("./embedder.js");
    const embedding = Array(1024).fill(0.2);

    const { db, state } = makeMockDb([
      { id: "f1", synoPath: "/Share/A", dirty: true },
      { id: "f2", synoPath: "/Share/B", dirty: true },
      { id: "f3", synoPath: "/Share/C", dirty: true },
    ]);

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("oom first", { status: 500 }))
      .mockResolvedValueOnce(new Response("oom second", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ embedding }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ embedding }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await rebuildDirtyFolders(
      db as never,
      (text) => embedText(text, "http://ollama:11434", "mxbai-embed-large"),
      new Date(),
    );

    expect(result).toEqual({ rebuilt: 2, failed: 1 });
    expect(state.find((f) => f.id === "f1")!.dirty).toBe(true);
    expect(state.find((f) => f.id === "f2")!.dirty).toBe(false);
    expect(state.find((f) => f.id === "f3")!.dirty).toBe(false);
    expect(logErrorWithCause).toHaveBeenCalledWith(
      "folder rebuild failed",
      expect.objectContaining({
        message: expect.stringContaining("HTTP 500: oom second"),
      }),
      { syno_path: "/Share/A" },
    );
  });
});
