export interface ExistingFileRow {
  id: string;
  contentHash: string | null;
  hasEmbedding: boolean;
  description: string | null;
}

export interface DirtyDecision {
  dirty: boolean;
  reason: "new" | "hash_missing" | "hash_changed" | "incomplete" | "clean";
}

/** Vision result is complete only when both embedding and description exist. */
export function hasCompleteVisionResult(row: ExistingFileRow): boolean {
  return Boolean(row.hasEmbedding && row.description);
}

export function shouldMarkDirty(
  existingRow: ExistingFileRow | null,
  newHash: string,
): DirtyDecision {
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
