#!/usr/bin/env node
import { basename } from "node:path";
import { getConfig, isRunPodGpuConfigured, parseIndexTime, type Config } from "./config.js";
import { getPrisma, disconnectPrisma, formatVectorForPg } from "./db.js";
import { walkDirectory } from "./walker.js";
import { hashFile } from "./hasher.js";
import {
  shouldMarkDirty,
  getDirectParentFolderPath,
  shouldAbortSoftDelete,
  isDos83ShortBasename,
  fileNeedsVision,
  type ExistingFileRow,
} from "./dirty.js";
import { describeWithVision, checkOllamaAvailable } from "./vision.js";
import { embedText } from "./embedder.js";
import { embedTextCpu } from "./cpu-embedder.js";
import {
  markFoldersDirtyByPaths,
  countDirtyFolders,
  rebuildDirtyFolders,
} from "./folder-rebuild.js";
import { withGpuPod, type RunPodDeployConfig } from "./runpod.js";
import { planIndexWork } from "./index-plan.js";
import { createIndexDaemon, type IndexRunReason } from "./daemon.js";
import {
  startTelemetry,
  shutdownTelemetry,
  logInfo,
  logWarn,
  logError,
  logErrorWithCause,
} from "./telemetry.js";

export interface IndexStats {
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

export async function runIndex(
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

  const folderPathsToDirty = new Set<string>();
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
          folderPathsToDirty.add(folder.synoPath);
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
      const fileBasename = basename(file.synoPath);

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
        const decision = shouldMarkDirty(existing, hash, fileBasename);

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
          const parentPath = getDirectParentFolderPath(file.synoPath);
          if (parentPath) folderPathsToDirty.add(parentPath);
        } else if (decision.dirty) {
          const parentPath = getDirectParentFolderPath(file.synoPath);
          if (parentPath) folderPathsToDirty.add(parentPath);
        }

        if (decision.dirty) {
          stats.dirty++;
        }
      } else {
        const parentPath = getDirectParentFolderPath(file.synoPath);
        const folder = parentPath
          ? await db.folder.findFirst({ where: { synoPath: parentPath } })
          : null;

        const decision = shouldMarkDirty(null, hash, fileBasename);
        await db.file.create({
          data: {
            synoPath: file.synoPath,
            kind: file.kind,
            bytes: file.bytes,
            mtime: file.mtime,
            label: fileBasename,
            contentHash: hash,
            lastSeenAt: now,
            dirty: decision.dirty,
            folderId: folder?.id,
          },
        });

        if (parentPath) {
          folderPathsToDirty.add(parentPath);
        }
        if (decision.dirty) {
          stats.dirty++;
        }
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

  const filesToSoftDelete = await db.file.findMany({
    where: { deletedAt: null, lastSeenAt: { lt: now } },
    select: { synoPath: true },
  });

  for (const file of filesToSoftDelete) {
    const parentPath = getDirectParentFolderPath(file.synoPath);
    if (parentPath) {
      folderPathsToDirty.add(parentPath);
    }
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

  await markFoldersDirtyByPaths(db, folderPathsToDirty);

  const allFolders = await db.folder.findMany({
    where: { deletedAt: null },
    select: { id: true, synoPath: true },
  });

  const foldersToSoftDeleteLater: string[] = [];

  for (const folder of allFolders) {
    const liveChildCount = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM files
      WHERE folder_id = ${folder.id}::uuid AND deleted_at IS NULL
    `.then((rows) => Number(rows[0]?.count ?? 0));

    if (liveChildCount === 0) {
      await db.folder.update({
        where: { id: folder.id },
        data: { dirty: true },
      });
      if (!seenFolderPaths.has(folder.synoPath)) {
        foldersToSoftDeleteLater.push(folder.synoPath);
      }
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

  const dirtyFiles = await db.file.findMany({
    where: { dirty: true, deletedAt: null },
    select: { id: true, synoPath: true },
  });

  for (const file of dirtyFiles) {
    const fileBasename = basename(file.synoPath);
    if (isDos83ShortBasename(fileBasename)) {
      logInfo("clearing 8.3 short name without vision", { syno_path: file.synoPath });
      await db.file.update({
        where: { id: file.id },
        data: { dirty: false },
      });
    }
  }

  const remainingDirtyFiles = await db.file.findMany({
    where: { dirty: true, deletedAt: null },
    select: { id: true, synoPath: true },
  });

  const visionQueue = remainingDirtyFiles.filter((file) =>
    fileNeedsVision(true, basename(file.synoPath)),
  );

  const dirtyFolderCount = await countDirtyFolders(db);

  const workKind = planIndexWork(visionQueue.length, dirtyFolderCount);

  if (workKind === "none") {
    logInfo("nothing dirty; skipping embed/vision phase");
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logInfo("index run complete", { elapsed_seconds: elapsed, reason, ...stats });
    return stats;
  }

  const processVisionPhase = async (ollamaUrl: string): Promise<void> => {
    logInfo("vision phase started", { dirty_files: visionQueue.length });

    for (const file of visionQueue) {
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
      } catch (err) {
        logErrorWithCause("vision/embedding failed", err, { syno_path: file.synoPath });
        stats.errors++;
      }
    }

    const folderCount = await countDirtyFolders(db);
    if (folderCount > 0) {
      logInfo("rebuilding dirty folders on GPU Ollama session", { count: folderCount });
      try {
        stats.foldersRebuilt += await rebuildDirtyFolders(
          db,
          (text) => embedText(text, ollamaUrl, config.embedModel),
          now,
        );
      } catch (err) {
        logErrorWithCause("folder rebuild failed", err);
        stats.errors++;
      }
    }
  };

  const processCpuFolderRebuild = async (): Promise<void> => {
    const folderCount = await countDirtyFolders(db);
    if (folderCount === 0) return;

    logInfo("rebuilding dirty folders on CPU embedder", { count: folderCount });
    try {
      stats.foldersRebuilt += await rebuildDirtyFolders(
        db,
        (text) => embedTextCpu(text),
        now,
      );
    } catch (err) {
      logErrorWithCause("CPU folder rebuild failed", err);
      stats.errors++;
    }
  };

  const hasRunPod = isRunPodGpuConfigured(config);

  if (workKind === "gpu_vision") {
    if (hasRunPod) {
      if (config.runpodPodId) {
        logWarn("RUNPOD_POD_ID is deprecated and ignored; creating ephemeral pods per session");
      }
      logInfo("using RunPod ephemeral GPU pod");
      const runpodConfig: RunPodDeployConfig = {
        apiKey: config.runpodApiKey!,
        ollamaPort: config.runpodOllamaPort,
        templateId: config.runpodTemplateId,
        imageName: config.runpodImage,
        cloudType: config.runpodCloudType,
        gpuTypeId: config.runpodGpuTypeId,
        containerDiskInGb: config.runpodContainerDiskGb,
        dataCenterId: config.runpodDataCenterId,
        podName: "synology-indexer-ollama",
        ollamaHealthyTimeoutMs: config.runpodOllamaHealthyTimeoutMs,
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
      logWarn("no RunPod or Ollama configured; skipping vision phase for dirty files");
    }
  } else if (workKind === "cpu_folders") {
    await processCpuFolderRebuild();
  }

  for (const folderPath of foldersToSoftDeleteLater) {
    try {
      const folder = await db.folder.findFirst({
        where: { synoPath: folderPath, deletedAt: null },
        select: { id: true },
      });
      if (!folder) continue;

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
        logInfo("soft-deleted folder with no live children", { syno_path: folderPath });
      }
    } catch (err) {
      logErrorWithCause("folder soft-delete failed", err, { syno_path: folderPath });
      stats.errors++;
    }
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
    runpod_configured: isRunPodGpuConfigured(config),
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
