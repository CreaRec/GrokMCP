import type { PrismaClient } from "@prisma/client";
import { formatVectorForPg } from "./db.js";
import { generateFolderSummary, type ChildDescription } from "./folder-summarizer.js";

export interface EmbedFn {
  (text: string): Promise<{ embedding: number[]; model: string }>;
}

export async function markFoldersDirtyByPaths(
  db: PrismaClient,
  folderPaths: Iterable<string>,
): Promise<void> {
  const paths = [...new Set(folderPaths)];
  if (paths.length === 0) return;

  await db.folder.updateMany({
    where: { synoPath: { in: paths }, deletedAt: null },
    data: { dirty: true },
  });
}

export async function countDirtyFolders(db: PrismaClient): Promise<number> {
  return db.folder.count({
    where: { dirty: true, deletedAt: null },
  });
}

export async function rebuildDirtyFolders(
  db: PrismaClient,
  embedFn: EmbedFn,
  now: Date,
): Promise<number> {
  const dirtyFolders = await db.folder.findMany({
    where: { dirty: true, deletedAt: null },
    select: { id: true, synoPath: true },
  });

  if (dirtyFolders.length === 0) {
    return 0;
  }

  const sorted = dirtyFolders.sort(
    (a, b) => b.synoPath.split("/").length - a.synoPath.split("/").length,
  );

  let rebuilt = 0;
  for (const folder of sorted) {
    const children = await db.file.findMany({
      where: { folderId: folder.id, deletedAt: null },
      select: { label: true, description: true, kind: true },
    });

    const summary = generateFolderSummary(
      folder.synoPath,
      children as ChildDescription[],
    );

    const embed = await embedFn(summary.description);

    await db.$executeRaw`
      UPDATE folders
      SET
        label = ${summary.label},
        description = ${summary.description},
        embedding = ${formatVectorForPg(embed.embedding)}::vector,
        embed_model = ${embed.model},
        updated_at = ${now},
        dirty = false
      WHERE id = ${folder.id}::uuid
    `;

    rebuilt++;
  }

  return rebuilt;
}
