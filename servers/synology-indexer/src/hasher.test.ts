import { describe, it, expect } from "vitest";
import { canReuseContentHash, type StoredContentIdentity } from "./hasher.js";
import { shouldMarkDirty } from "./dirty.js";

const walked = {
  bytes: 13_700_000_000n,
  mtime: new Date("2026-08-20T12:34:56.789Z"),
};

function stored(
  overrides: Partial<StoredContentIdentity> = {},
): StoredContentIdentity {
  return {
    contentHash: "abc123def456",
    bytes: 13_700_000_000n,
    // Same second as walked; sub-second difference must still match.
    mtime: new Date("2026-08-20T12:34:56.000Z"),
    ...overrides,
  };
}

describe("canReuseContentHash", () => {
  it("reuses hash when content_hash, bytes, and mtime (1s) match", () => {
    expect(canReuseContentHash(stored(), walked)).toBe(true);
  });

  it("reuses when bytes arrive as number or decimal string from the DB", () => {
    expect(
      canReuseContentHash(stored({ bytes: 13_700_000_000 }), walked),
    ).toBe(true);
    expect(
      canReuseContentHash(stored({ bytes: "13700000000" }), walked),
    ).toBe(true);
  });

  it("does not reuse when mtime differs by at least one second", () => {
    expect(
      canReuseContentHash(
        stored({ mtime: new Date("2026-08-20T12:34:57.000Z") }),
        walked,
      ),
    ).toBe(false);
  });

  it("does not reuse when bytes differ", () => {
    expect(
      canReuseContentHash(stored({ bytes: 13_700_000_001n }), walked),
    ).toBe(false);
  });

  it("does not reuse when content_hash is missing", () => {
    expect(canReuseContentHash(stored({ contentHash: null }), walked)).toBe(
      false,
    );
    expect(canReuseContentHash(stored({ contentHash: "" }), walked)).toBe(
      false,
    );
  });

  it("does not reuse when stored mtime or bytes are missing", () => {
    expect(canReuseContentHash(stored({ mtime: null }), walked)).toBe(false);
    expect(canReuseContentHash(stored({ bytes: null }), walked)).toBe(false);
  });

  it("does not reuse for a new file (no stored row)", () => {
    expect(canReuseContentHash(null, walked)).toBe(false);
  });

  it("reused hash still leaves incomplete vision dirty for GPU", () => {
    const row = stored();
    expect(canReuseContentHash(row, walked)).toBe(true);
    const decision = shouldMarkDirty(
      {
        id: "file-1",
        contentHash: row.contentHash,
        hasEmbedding: false,
        description: null,
      },
      row.contentHash!,
    );
    expect(decision.dirty).toBe(true);
    expect(decision.reason).toBe("incomplete");
  });
});
