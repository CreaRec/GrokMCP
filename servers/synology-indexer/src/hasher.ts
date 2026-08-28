import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("data", (chunk) => {
      hash.update(chunk);
    });

    stream.on("end", () => {
      resolve(hash.digest("hex").toLowerCase());
    });

    stream.on("error", (err) => {
      reject(err);
    });
  });
}

/** Stored identity fields used to skip SHA-256 when mtime+bytes still match. */
export interface StoredContentIdentity {
  contentHash: string | null;
  bytes: bigint | number | string | null;
  mtime: Date | string | null;
}

/** Walked file identity from fs.stat (always present on FileEntry). */
export interface WalkedContentIdentity {
  bytes: bigint;
  mtime: Date;
}

/**
 * True when we can reuse the stored content_hash and skip hashFile.
 * Requires a non-null hash plus matching bytes and mtime (1-second resolution
 * for CIFS/NAS File Station). Missing/null stored fields never skip.
 */
export function canReuseContentHash(
  stored: StoredContentIdentity | null,
  walked: WalkedContentIdentity,
): boolean {
  if (!stored) return false;
  if (!stored.contentHash) return false;
  if (stored.bytes == null || stored.mtime == null) return false;

  let storedBytes: bigint;
  try {
    storedBytes =
      typeof stored.bytes === "bigint" ? stored.bytes : BigInt(stored.bytes);
  } catch {
    return false;
  }
  if (storedBytes !== walked.bytes) return false;

  const storedMtime =
    stored.mtime instanceof Date ? stored.mtime : new Date(stored.mtime);
  if (Number.isNaN(storedMtime.getTime())) return false;

  // File Station / CIFS mtime is 1-second resolution.
  const storedSec = Math.floor(storedMtime.getTime() / 1000);
  const walkedSec = Math.floor(walked.mtime.getTime() / 1000);
  return storedSec === walkedSec;
}
