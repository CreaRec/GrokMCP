#!/usr/bin/env node
import { basename } from "node:path";
import { getConfig, parseIndexTime, type Config } from "./config.js";
import { getPrisma, disconnectPrisma, formatVectorForPg } from "./db.js";
import { walkDirectory } from "./walker.js";
import { hashFile } from "./hasher.js";
import { shouldMarkDirty, getParentFolderPaths, shouldAbortSoftDelete, type ExistingFileRow } from "./dirty.js";
import { describeWithVision, checkOllamaAvailable } from "./vision.js";
import { embedText } from "./embedder.js";
import { generateFolderSummary, type ChildDescription } from "./folder-summarizer.js";
import { withGpuPod, type RunPodConfig } from "./runpod.js";

interface IndexStats {
  seen: number;
  hashed: number;
  dirty: number;
  skipped: number;
  processed: number;
  foldersRebuilt: number;
  errors: number;
  softDeleted: number;
  undeleted: number;
  hardDeleted: number;
  aborted: boolean;
}

async function runIndex(config: Config): Promise<IndexStats> {
  const stats: IndexStats = {
    seen: 0,
    hashed: 0,
    dirty: 0,
    skipped: 0,
    processed: 0,
    foldersRebuilt: 0,
    errors: 0,
    softDeleted: 0,
    undeleted: 0,
    hardDeleted: 0,
    aborted: false,
  };

  console.log(`[indexer] Starting index of ${config.mountRoot}`);
  const startTime = Date.now();

  const walkResult = await walkDirectory(config.mountRoot);
  stats.seen = walkResult.files.length + walkResult.folders.length;
  stats.skipped = walkResult.skipped;

  console.log(
    `[indexer] Walk complete: ${walkResult.files.length} files, ` +
      `${walkResult.folders.length} folders, ${walkResult.skipped} skipped`,
  );

  const db = getPrisma();
  const now = new Date();

  const dirtyFileIds = new Set<string>();
  const processedFolderPaths = new Set<string>();
  const seenFilePaths = new Set<string>();
  const seenFolderPaths = new Set<string>();

  for (const folder of walkResult.folders) {
    seenFolderPaths.add(folder.synoPath);
    try {
      const existingFolder = await db.folder.findFirst({
        where: { synoPath: folder.synoPath },
        select: { id: true, deletedAt: true },
      });

      if (existingFolder) {
        const wasDeleted = existingFolder.deletedAt !== null;
        await db.folder.update({
          where: { id: existingFolder.id },
          data: {
            lastSeenAt: now,
            deletedAt: null,
          },
        });
        if (wasDeleted) {
          stats.undeleted++;
          console.log(`[indexer] Undeleted folder: ${folder.synoPath}`);
        }
      } else {
        await db.folder.create({
          data: {
            synoPath: folder.synoPath,
            label: basename(folder.synoPath) || folder.synoPath,
            lastSeenAt: now,
            dirty: false,
          },
        });
      }
    } catch (err) {
      console.error(`[indexer] Error upserting folder ${folder.synoPath}:`, err);
      stats.errors++;
    }
  }

  for (const file of walkResult.files) {
    seenFilePaths.add(file.synoPath);
    try {
      const hash = await hashFile(file.absolutePath);
      stats.hashed++;

      const existingRows = await db.$queryRaw<
        Array<{
          id: string;
          content_hash: string | null;
          has_embedding: boolean;
          description: string | null;
          deleted_at: Date | null;
        }>
      >`
        SELECT id, content_hash, (embedding IS NOT NULL) as has_embedding, description, deleted_at
        FROM files
        WHERE syno_path = ${file.synoPath}
        LIMIT 1
      `;
      const existingRow = existingRows[0] ?? null;
      const existing: (ExistingFileRow & { deletedAt: Date | null }) | null = existingRow
        ? {
            id: existingRow.id,
            contentHash: existingRow.content_hash,
            hasEmbedding: existingRow.has_embedding,
            description: existingRow.description,
            deletedAt: existingRow.deleted_at,
          }
        : null;

      if (existing) {
        const wasDeleted = existing.deletedAt !== null;
        const decision = wasDeleted
          ? shouldMarkDirty(
              { ...existing, contentHash: existing.contentHash, hasEmbedding: existing.hasEmbedding },
              hash,
            )
          : shouldMarkDirty(existing, hash);

        await db.file.update({
          where: { id: existing.id },
          data: {
            lastSeenAt: now,
            contentHash: hash,
            bytes: file.bytes,
            mtime: file.mtime,
            dirty: decision.dirty,
            deletedAt: null,
          },
        });

        if (wasDeleted) {
          stats.undeleted++;
          console.log(`[indexer] Undeleted file: ${file.synoPath}`);
        }
        if (decision.dirty) {
          dirtyFileIds.add(existing.id);
          stats.dirty++;
        }
      } else {
        const parentPath = getParentFolderPaths(file.synoPath).pop();
        const folder = parentPath
          ? await db.folder.findFirst({ where: { synoPath: parentPath } })
          : null;

        const newFile = await db.file.create({
          data: {
            synoPath: file.synoPath,
            kind: file.kind,
            bytes: file.bytes,
            mtime: file.mtime,
            label: basename(file.synoPath),
            contentHash: hash,
            lastSeenAt: now,
            dirty: true,
            folderId: folder?.id,
          },
        });
        dirtyFileIds.add(newFile.id);
        stats.dirty++;
      }
    } catch (err) {
      console.error(`[indexer] Error processing file ${file.synoPath}:`, err);
      stats.errors++;
    }
  }

  console.log(
    `[indexer] Hashed ${stats.hashed} files, ${stats.dirty} marked dirty`,
  );

  const previousNonDeletedCount = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count FROM files WHERE deleted_at IS NULL
  `.then((rows) => Number(rows[0]?.count ?? 0));

  const seenFileCount = walkResult.files.length;
  const abortCheck = shouldAbortSoftDelete(seenFileCount, previousNonDeletedCount);

  if (abortCheck.shouldAbort) {
    const reason = abortCheck.reason === "zero_seen"
      ? "zero"
      : `less than half of previous non-deleted count (${previousNonDeletedCount})`;
    console.error(
      `[indexer] ABORT: Seen file count (${seenFileCount}) is ${reason}. ` +
        `This may indicate a mount issue. Skipping soft-delete to prevent data loss.`,
    );
    stats.aborted = true;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[indexer] Index aborted in ${elapsed}s`);
    return stats;
  }

  const softDeleteResult = await db.$executeRaw`
    UPDATE files
    SET deleted_at = ${now}
    WHERE deleted_at IS NULL
      AND last_seen_at < ${now}
  `;
  stats.softDeleted += Number(softDeleteResult);
  if (softDeleteResult > 0) {
    console.log(`[indexer] Soft-deleted ${softDeleteResult} files not seen this scan`);
  }

  const allFolders = await db.folder.findMany({
    where: { deletedAt: null },
    select: { id: true, synoPath: true },
  });

  for (const folder of allFolders) {
    if (seenFolderPaths.has(folder.synoPath)) {
      continue;
    }

    const liveChildCount = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM files
      WHERE folder_id = ${folder.id}::uuid AND deleted_at IS NULL
    `.then((rows) => Number(rows[0]?.count ?? 0));

    if (liveChildCount === 0) {
      await db.folder.update({
        where: { id: folder.id },
        data: { deletedAt: now },
      });
      stats.softDeleted++;
      console.log(`[indexer] Soft-deleted folder (no live children): ${folder.synoPath}`);
    }
  }

  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const hardDeleteFilesResult = await db.$executeRaw`
    DELETE FROM files
    WHERE deleted_at IS NOT NULL AND deleted_at < ${thirtyDaysAgo}
  `;
  stats.hardDeleted += Number(hardDeleteFilesResult);
  if (hardDeleteFilesResult > 0) {
    console.log(`[indexer] Hard-deleted ${hardDeleteFilesResult} files (older than 30 days)`);
  }

  const hardDeleteFoldersResult = await db.$executeRaw`
    DELETE FROM folders
    WHERE deleted_at IS NOT NULL AND deleted_at < ${thirtyDaysAgo}
  `;
  stats.hardDeleted += Number(hardDeleteFoldersResult);
  if (hardDeleteFoldersResult > 0) {
    console.log(`[indexer] Hard-deleted ${hardDeleteFoldersResult} folders (older than 30 days)`);
  }

  if (stats.dirty === 0) {
    console.log("[indexer] No dirty files, skipping vision/embedding phase");
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[indexer] Index complete in ${elapsed}s`);
    return stats;
  }

  const processVisionPhase = async (ollamaUrl: string): Promise<void> => {
    console.log(`[indexer] Processing ${stats.dirty} dirty files with vision model`);

    const dirtyFiles = await db.file.findMany({
      where: { dirty: true, deletedAt: null },
      select: { id: true, synoPath: true },
    });

    for (const file of dirtyFiles) {
      try {
        const absolutePath = `${config.mountRoot}${file.synoPath.slice(file.synoPath.indexOf("/", 1))}`;

        const vision = await describeWithVision(
          absolutePath,
          ollamaUrl,
          config.visionModel,
        );

        const embed = await embedText(
          vision.description,
          ollamaUrl,
          config.embedModel,
        );

        await db.$executeRaw`
          UPDATE files
          SET 
            label = ${vision.label},
            description = ${vision.description},
            embedding = ${formatVectorForPg(embed.embedding)}::vector,
            embed_model = ${embed.model},
            indexed_at = ${now},
            redacted = ${vision.redacted},
            dirty = false
          WHERE id = ${file.id}::uuid
        `;

        stats.processed++;

        const parentPaths = getParentFolderPaths(file.synoPath);
        for (const p of parentPaths) {
          processedFolderPaths.add(p);
        }
      } catch (err) {
        console.error(`[indexer] Error describing/embedding ${file.synoPath}:`, err);
        stats.errors++;
      }
    }

    if (processedFolderPaths.size > 0) {
      console.log(`[indexer] Rebuilding ${processedFolderPaths.size} affected folders`);

      const sortedPaths = Array.from(processedFolderPaths).sort(
        (a, b) => b.split("/").length - a.split("/").length,
      );

      for (const folderPath of sortedPaths) {
        try {
          const folder = await db.folder.findFirst({
            where: { synoPath: folderPath, deletedAt: null },
          });
          if (!folder) continue;

          const children = await db.file.findMany({
            where: { folderId: folder.id, deletedAt: null },
            select: { label: true, description: true, kind: true },
          });

          const summary = generateFolderSummary(
            folderPath,
            children as ChildDescription[],
          );

          const embed = await embedText(
            summary.description,
            ollamaUrl,
            config.embedModel,
          );

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

          stats.foldersRebuilt++;
        } catch (err) {
          console.error(`[indexer] Error rebuilding folder ${folderPath}:`, err);
          stats.errors++;
        }
      }
    }
  };

  const hasRunPod = config.runpodApiKey && config.runpodPodId;

  if (hasRunPod) {
    console.log(`[indexer] Using RunPod GPU pod ${config.runpodPodId}`);
    const runpodConfig: RunPodConfig = {
      apiKey: config.runpodApiKey!,
      podId: config.runpodPodId!,
      ollamaPort: config.runpodOllamaPort,
    };

    await withGpuPod(
      runpodConfig,
      config.ollamaBaseUrl,
      config.visionModel,
      config.embedModel,
      processVisionPhase,
      { leaveRunning: config.runpodLeaveRunning },
    );
  } else if (config.ollamaBaseUrl) {
    const ollamaAvailable = await checkOllamaAvailable(config.ollamaBaseUrl);
    if (ollamaAvailable) {
      await processVisionPhase(config.ollamaBaseUrl);
    } else {
      console.log("[indexer] Ollama not available, skipping vision descriptions");
    }
  } else {
    console.log("[indexer] No RunPod or Ollama configured, skipping vision descriptions");
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(
    `[indexer] Index complete in ${elapsed}s: ` +
      `${stats.seen} seen, ${stats.hashed} hashed, ${stats.dirty} dirty, ` +
      `${stats.processed} processed, ${stats.foldersRebuilt} folders rebuilt, ` +
      `${stats.softDeleted} soft-deleted, ${stats.undeleted} undeleted, ` +
      `${stats.hardDeleted} hard-deleted, ${stats.errors} errors`,
  );

  return stats;
}

function msUntilNextRun(hour: number, minute: number, timezone: string): number {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const currentHour = parseInt(
    parts.find((p) => p.type === "hour")?.value ?? "0",
    10,
  );
  const currentMinute = parseInt(
    parts.find((p) => p.type === "minute")?.value ?? "0",
    10,
  );

  let targetDate = new Date(now);
  targetDate.setHours(hour, minute, 0, 0);

  const tzOffset =
    (currentHour - now.getUTCHours()) * 60 + (currentMinute - now.getUTCMinutes());
  targetDate = new Date(targetDate.getTime() - tzOffset * 60 * 1000);

  if (targetDate <= now) {
    targetDate = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
  }

  return targetDate.getTime() - now.getTime();
}

async function main(): Promise<void> {
  const config = getConfig();

  console.log("[indexer] Synology Indexer starting");
  console.log(`[indexer] Mount root: ${config.mountRoot}`);
  console.log(`[indexer] Timezone: ${config.timezone}`);
  console.log(`[indexer] Daily index at: ${config.indexDailyAt}`);
  console.log(`[indexer] Run once: ${config.runOnce}`);
  console.log(`[indexer] Ollama URL: ${config.ollamaBaseUrl ?? "not configured"}`);
  console.log(`[indexer] RunPod: ${config.runpodPodId ? `pod ${config.runpodPodId}` : "not configured"}`);

  if (config.runOnce) {
    console.log("[indexer] RUN_ONCE mode, running immediately");
    await runIndex(config);
    await disconnectPrisma();
    console.log("[indexer] Done");
    return;
  }

  const { hour, minute } = parseIndexTime(config.indexDailyAt);

  const runLoop = async (): Promise<void> => {
    while (true) {
      const msToWait = msUntilNextRun(hour, minute, config.timezone);
      const hoursToWait = Math.round(msToWait / 1000 / 60 / 60 * 10) / 10;
      console.log(
        `[indexer] Next run in ${hoursToWait}h at ${config.indexDailyAt} ${config.timezone}`,
      );

      await new Promise((resolve) => setTimeout(resolve, msToWait));

      try {
        await runIndex(config);
      } catch (err) {
        console.error("[indexer] Index run failed:", err);
      }
    }
  };

  process.on("SIGINT", async () => {
    console.log("[indexer] Shutting down...");
    await disconnectPrisma();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("[indexer] Shutting down...");
    await disconnectPrisma();
    process.exit(0);
  });

  await runLoop();
}

main().catch((err) => {
  console.error("[indexer] Fatal error:", err);
  process.exit(1);
});
