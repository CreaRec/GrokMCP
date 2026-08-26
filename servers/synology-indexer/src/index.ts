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
import { createIndexDaemon, type IndexRunReason } from "./daemon.js";
import {
  startTelemetry,
  shutdownTelemetry,
  logInfo,
  logWarn,
  logError,
  logErrorWithCause,
} from "./telemetry.js";

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

async function runIndex(
  config: Config,
  reason: IndexRunReason = "scheduled",
): Promise<IndexStats> {
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

  logInfo("index run started", { mount_root: config.mountRoot, reason });
  const startTime = Date.now();

  const walkResult = await walkDirectory(config.mountRoot);
  stats.seen = walkResult.files.length + walkResult.folders.length;
  stats.skipped = walkResult.skipped;

  logInfo("walk complete", {
    files: walkResult.files.length,
    folders: walkResult.folders.length,
    skipped: walkResult.skipped,
  });

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
          logInfo("undeleted folder", { syno_path: folder.synoPath });
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
      logErrorWithCause("folder upsert failed", err, { syno_path: folder.synoPath });
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
          logInfo("undeleted file", { syno_path: file.synoPath });
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
      logErrorWithCause("file processing failed", err, { syno_path: file.synoPath });
      stats.errors++;
    }
  }

  logInfo("hash phase complete", { hashed: stats.hashed, dirty: stats.dirty });

  const previousNonDeletedCount = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count FROM files WHERE deleted_at IS NULL
  `.then((rows) => Number(rows[0]?.count ?? 0));

  const seenFileCount = walkResult.files.length;
  const abortCheck = shouldAbortSoftDelete(seenFileCount, previousNonDeletedCount);

  if (abortCheck.shouldAbort) {
    logError("soft-delete aborted: mount blip guard", {
      seen: seenFileCount,
      previous_non_deleted: previousNonDeletedCount,
      reason: abortCheck.reason,
    });
    stats.aborted = true;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logWarn("index run aborted", { elapsed_seconds: elapsed, reason, ...stats });
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
    logInfo("soft-deleted files not seen this scan", { count: Number(softDeleteResult) });
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
      logInfo("soft-deleted folder with no live children", { syno_path: folder.synoPath });
    }
  }

  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const hardDeleteFilesResult = await db.$executeRaw`
    DELETE FROM files
    WHERE deleted_at IS NOT NULL AND deleted_at < ${thirtyDaysAgo}
  `;
  stats.hardDeleted += Number(hardDeleteFilesResult);
  if (hardDeleteFilesResult > 0) {
    logInfo("hard-deleted files older than retention", { count: Number(hardDeleteFilesResult) });
  }

  const hardDeleteFoldersResult = await db.$executeRaw`
    DELETE FROM folders
    WHERE deleted_at IS NOT NULL AND deleted_at < ${thirtyDaysAgo}
  `;
  stats.hardDeleted += Number(hardDeleteFoldersResult);
  if (hardDeleteFoldersResult > 0) {
    logInfo("hard-deleted folders older than retention", { count: Number(hardDeleteFoldersResult) });
  }

  if (stats.dirty === 0) {
    logInfo("no dirty files; skipping vision phase");
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logInfo("index run complete", { elapsed_seconds: elapsed, reason, ...stats });
    return stats;
  }

  const processVisionPhase = async (ollamaUrl: string): Promise<void> => {
    logInfo("vision phase started", { dirty: stats.dirty });

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
        logErrorWithCause("vision/embedding failed", err, { syno_path: file.synoPath });
        stats.errors++;
      }
    }

    if (processedFolderPaths.size > 0) {
      logInfo("rebuilding affected folders", { count: processedFolderPaths.size });

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
          logErrorWithCause("folder rebuild failed", err, { syno_path: folderPath });
          stats.errors++;
        }
      }
    }
  };

  const hasRunPod = config.runpodApiKey && config.runpodPodId;

  if (hasRunPod) {
    logInfo("using RunPod GPU pod", { pod_id: config.runpodPodId! });
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
      logWarn("ollama unavailable; skipping vision phase");
    }
  } else {
    logInfo("no RunPod or Ollama configured; skipping vision phase");
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  logInfo("index run complete", { elapsed_seconds: elapsed, reason, ...stats });

  return stats;
}

async function main(): Promise<void> {
  startTelemetry();
  const config = getConfig();

  logInfo("synology indexer starting", {
    timezone: config.timezone,
    index_daily_at: config.indexDailyAt,
    run_once: config.runOnce,
    ollama_configured: Boolean(config.ollamaBaseUrl),
    runpod_configured: Boolean(config.runpodPodId),
  });

  if (config.runOnce) {
    logInfo("run_once mode; running immediately");
    await runIndex(config, "scheduled");
    await disconnectPrisma();
    await shutdownTelemetry();
    logInfo("run_once complete");
    return;
  }

  const { hour, minute } = parseIndexTime(config.indexDailyAt);

  const daemon = createIndexDaemon({
    hour,
    minute,
    timezone: config.timezone,
    indexDailyAt: config.indexDailyAt,
    runIndex: async (reason) => {
      await runIndex(config, reason);
    },
    logInfo,
    logWarn,
    logErrorWithCause,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logInfo("shutting down", { signal });
    daemon.stop();
    await disconnectPrisma();
    await shutdownTelemetry();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  // On-demand full index without restarting the container or shifting INDEX_DAILY_AT.
  // SIGUSR2 (not SIGUSR1 — Node reserves USR1 for the inspector).
  // From the host: docker kill -s USR2 grok-mcp-synology-indexer
  process.on("SIGUSR2", () => {
    daemon.requestManualRun();
  });

  await daemon.run();
}

main().catch(async (err) => {
  logErrorWithCause("fatal error", err);
  await shutdownTelemetry();
  process.exit(1);
});
