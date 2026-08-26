export interface ExistingFileRow {
  id: string;
  contentHash: string | null;
  hasEmbedding: boolean;
  description: string | null;
}

export interface DirtyDecision {
  dirty: boolean;
  reason: "new" | "hash_missing" | "hash_changed" | "incomplete" | "skipped_83" | "clean";
}

/** Vision result is complete only when both embedding and description exist. */
export function hasCompleteVisionResult(row: ExistingFileRow): boolean {
  return Boolean(row.hasEmbedding && row.description);
}

/**
 * Detect Windows 8.3 short basenames (CIFS duplicates of long names).
 * Examples: BKZZW3~2.PDF, BY3IVZ~I.PDF, GT50G8~Y.PDF.
 * Does not match normal long names like receipt.pdf (see #27).
 */
export function isDos83ShortBasename(name: string): boolean {
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  // ≤8-char stem: up to 6 prefix chars + "~" + 1–2 generation chars; ≤3-char extension.
  return /^[^./\\]{1,6}~[0-9A-Za-z]{1,2}\.[^./\\]{1,3}$/.test(base);
}

export function shouldMarkDirty(
  existingRow: ExistingFileRow | null,
  newHash: string,
  fileBasename?: string,
): DirtyDecision {
  // Temporary (#27): never queue 8.3 CIFS duplicates for vision/GPU.
  if (fileBasename !== undefined && isDos83ShortBasename(fileBasename)) {
    return { dirty: false, reason: "skipped_83" };
  }

  if (!existingRow) {
    return { dirty: true, reason: "new" };
  }

  if (!existingRow.contentHash) {
    if (hasCompleteVisionResult(existingRow)) {
      return { dirty: false, reason: "clean" };
    }
    return { dirty: true, reason: "hash_missing" };
  }

  if (existingRow.contentHash !== newHash) {
    return { dirty: true, reason: "hash_changed" };
  }

  // Same bytes as last hash, but vision never finished (e.g. RunPod start failed
  // after dirty was set). Keep dirty so the next run retries embedding.
  if (!hasCompleteVisionResult(existingRow)) {
    return { dirty: true, reason: "incomplete" };
  }

  return { dirty: false, reason: "clean" };
}

export function shouldRebuildFolder(dirtyChildIds: Set<string>, childFileIds: string[]): boolean {
  for (const childId of childFileIds) {
    if (dirtyChildIds.has(childId)) {
      return true;
    }
  }
  return false;
}

export function getParentFolderPaths(synoPath: string): string[] {
  const parts = synoPath.split("/").filter(Boolean);
  const parents: string[] = [];

  for (let i = 1; i < parts.length; i++) {
    parents.push("/" + parts.slice(0, i).join("/"));
  }

  return parents;
}

/** Direct parent folder for a file syno_path (the folder whose child list changes). */
export function getDirectParentFolderPath(synoPath: string): string | null {
  const parents = getParentFolderPaths(synoPath);
  return parents.length > 0 ? parents[parents.length - 1]! : null;
}

/** True when a dirty file should go through vision/GPU (8.3 names are excluded). */
export function fileNeedsVision(fileDirty: boolean, fileBasename: string): boolean {
  return fileDirty && !isDos83ShortBasename(fileBasename);
}

export interface AbortCheckResult {
  shouldAbort: boolean;
  reason: "zero_seen" | "less_than_half" | "ok";
}

export function shouldAbortSoftDelete(
  seenFileCount: number,
  previousNonDeletedCount: number,
): AbortCheckResult {
  if (seenFileCount === 0) {
    return { shouldAbort: true, reason: "zero_seen" };
  }

  if (previousNonDeletedCount > 0) {
    const halfPreviousCount = Math.floor(previousNonDeletedCount / 2);
    if (seenFileCount < halfPreviousCount) {
      return { shouldAbort: true, reason: "less_than_half" };
    }
  }

  return { shouldAbort: false, reason: "ok" };
}

export function isEligibleForHardDelete(deletedAt: Date | null, now: Date): boolean {
  if (!deletedAt) return false;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  return now.getTime() - deletedAt.getTime() >= thirtyDaysMs;
}

export function shouldUndelete(
  existing: ExistingFileRow & { deletedAt: Date | null },
  newHash: string,
): { undelete: boolean; dirty: boolean; reason: string } {
  if (!existing.deletedAt) {
    const decision = shouldMarkDirty(existing, newHash);
    return { undelete: false, dirty: decision.dirty, reason: decision.reason };
  }

  const decision = shouldMarkDirty(existing, newHash);
  return { undelete: true, dirty: decision.dirty, reason: `undeleted_${decision.reason}` };
}
