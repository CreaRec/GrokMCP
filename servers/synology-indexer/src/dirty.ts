export interface ExistingFileRow {
  id: string;
  contentHash: string | null;
  hasEmbedding: boolean;
  description: string | null;
}

export interface DirtyDecision {
  dirty: boolean;
  reason: "new" | "hash_missing" | "hash_changed" | "clean";
}

export function shouldMarkDirty(
  existingRow: ExistingFileRow | null,
  newHash: string,
): DirtyDecision {
  if (!existingRow) {
    return { dirty: true, reason: "new" };
  }

  if (!existingRow.contentHash) {
    if (existingRow.hasEmbedding && existingRow.description) {
      return { dirty: false, reason: "clean" };
    }
    return { dirty: true, reason: "hash_missing" };
  }

  if (existingRow.contentHash !== newHash) {
    return { dirty: true, reason: "hash_changed" };
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
