#!/usr/bin/env node
import { basename } from "node:path";
import {
  getConfig,
  isRunPodGpuConfigured,
  isDoclingSidecarConfigured,
  doclingSidecarConfigFrom,
  ollamaUrlOverrideForGpuPod,
  parseIndexTime,
  type Config,
} from "./config.js";
import { getPrisma, disconnectPrisma, formatVectorForPg } from "./db.js";
import { walkDirectory } from "./walker.js";
import { hashFile, canReuseContentHash } from "./hasher.js";
import {
  shouldMarkDirty,
  getDirectParentFolderPath,
  shouldAbortSoftDelete,
  isDos83ShortBasename,
  isNotSupportedRoute,
  type ExistingFileRow,
} from "./dirty.js";
import {
  describeWithVisionImage,
  describeFromDocumentText,
  describeLimitsFromConfig,
  checkOllamaAvailable,
} from "./vision.js";
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
import {
  classifyFileRoute,
  routeNeedsQwen,
  routeLogLabel,
  type FileIndexRoute,
} from "./file-route.js";
import { convertFileToMarkdown, doclingGistPageRange } from "./docling-client.js";
import { describeDoclingPdfWithFallback } from "./docling-pdf-describe.js";
import { isPdfPath } from "./pdf-slice.js";
import { readTextFileHead } from "./file-head.js";
import {
  withDoclingSidecar,
} from "./docling-sidecar.js";
import { convertHeicToJpeg, cleanupHeicTemp } from "./heic-convert.js";

export interface IndexStats {
  seen: number;
  hashed: number;
  dirty: number;
  skipped: number;
  /** Files classified as always-skip and persisted as notSupported this run. */
  notSupported: number;
  processed: number;
  foldersRebuilt: number;
  errors: number;
  softDeleted: number;
  undeleted: number;
  hardDeleted: number;
  aborted: boolean;
}

function absolutePathForFile(config: Config, synoPath: string): string {
  return `${config.mountRoot}${synoPath.slice(synoPath.indexOf("/", 1))}`;
}

interface RoutedDirtyFile {
  id: string;
  synoPath: string;
  route: FileIndexRoute;
}

async function describeRoutedFile(
  file: RoutedDirtyFile,
  absolutePath: string,
  config: Config,
  ollamaUrl: string,
): Promise<{ label: string; description: string; redacted: boolean }> {
  const fileName = basename(file.synoPath);
  const describeOpts = {
    ...describeLimitsFromConfig(config),
    source: file.route === "qwen-text" ? ("qwen-text" as const) : ("docling" as const),
  };

  switch (file.route) {
    case "docling": {
      if (!config.doclingServeUrl) {
        throw new Error("Docling is not configured (DOCLING_SERVE_URL)");
      }
      if (isPdfPath(absolutePath)) {
        return describeDoclingPdfWithFallback(
          absolutePath,
          fileName,
          config,
          ollamaUrl,
          describeOpts,
        );
      }
      const markdown = await convertFileToMarkdown(absolutePath, config.doclingServeUrl, {
        pageRange: doclingGistPageRange(config.doclingPageRangeEnd),
        convertTimeoutMs: config.doclingConvertTimeoutMs,
        documentTimeoutSec: config.doclingDocumentTimeoutSec,
      });
      return describeFromDocumentText(
        markdown,
        fileName,
        ollamaUrl,
        config.visionModel,
        describeOpts,
      );
    }
    case "qwen-image":
      return describeWithVisionImage(absolutePath, ollamaUrl, config.visionModel);
    case "qwen-text": {
      const { text } = await readTextFileHead(absolutePath, config.textHeadBytes);
      return describeFromDocumentText(
        text,
        fileName,
        ollamaUrl,
        config.visionModel,
        describeOpts,
      );
    }
    case "heic": {
      const converted = await convertHeicToJpeg(absolutePath);
      try {
        return await describeWithVisionImage(converted.jpegPath, ollamaUrl, config.visionModel);
      } finally {
        await cleanupHeicTemp(converted.tempDir);
      }
    }
    default:
      throw new Error(`Unexpected qwen route: ${file.route}`);
  }
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
    notSupported: 0,
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

  let hashSkipped = 0;
  for (const file of walkResult.files) {
    seenFilePaths.add(file.synoPath);
    try {
      const fileBasename = basename(file.synoPath);
      const alwaysSkip = isNotSupportedRoute(fileBasename);

      const existingRows = await db.$queryRaw<
        Array<{
          id: string;
          content_hash: string | null;
          bytes: bigint | null;
          mtime: Date | null;
          has_embedding: boolean;
          description: string | null;
          deleted_at: Date | null;
          not_supported: boolean;
        }>
      >`
        SELECT id, content_hash, bytes, mtime, (embedding IS NOT NULL) as has_embedding,
               description, deleted_at, not_supported
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
            notSupported: existingRow.not_supported,
            deletedAt: existingRow.deleted_at,
          }
        : null;

      // Always-skip: mark notSupported once, never hash/dirty/GPU/folder-dirty for them.
      if (alwaysSkip) {
        if (existing) {
          const wasDeleted = existing.deletedAt !== null;
          await db.file.update({
            where: { id: existing.id },
            data: {
              lastSeenAt: now,
              bytes: file.bytes,
              mtime: file.mtime,
              dirty: false,
              notSupported: true,
              deletedAt: null,
            },
          });
          if (wasDeleted) {
            stats.undeleted++;
            logInfo("undeleted file", { syno_path: file.synoPath, not_supported: true });
          } else if (!existing.notSupported) {
            logInfo("marked file notSupported", {
              syno_path: file.synoPath,
              route: routeLogLabel("skip"),
            });
          }
        } else {
          const parentPath = getDirectParentFolderPath(file.synoPath);
          const folder = parentPath
            ? await db.folder.findFirst({ where: { synoPath: parentPath } })
            : null;
          await db.file.create({
            data: {
              synoPath: file.synoPath,
              kind: file.kind,
              bytes: file.bytes,
              mtime: file.mtime,
              label: fileBasename,
              lastSeenAt: now,
              dirty: false,
              notSupported: true,
              folderId: folder?.id,
            },
          });
          logInfo("marked file notSupported", {
            syno_path: file.synoPath,
            route: routeLogLabel("skip"),
          });
        }
        stats.notSupported++;
        continue;
      }

      // Skip SHA-256 when stored content_hash + bytes + mtime still match the walk.
      // shouldMarkDirty still runs so incomplete vision stays dirty / GPU-queued.
      let hash: string;
      if (
        canReuseContentHash(
          existingRow
            ? {
                contentHash: existingRow.content_hash,
                bytes: existingRow.bytes,
                mtime: existingRow.mtime,
              }
            : null,
          { bytes: file.bytes, mtime: file.mtime },
        )
      ) {
        hash = existingRow!.content_hash!;
        hashSkipped++;
      } else {
        hash = await hashFile(file.absolutePath);
        stats.hashed++;
      }

      // Route became supported: clear notSupported so incomplete vision can dirty again.
      const clearNotSupported = existing?.notSupported === true;

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
            notSupported: false,
            deletedAt: null,
          },
        });

        if (clearNotSupported) {
          logInfo("cleared notSupported; route now supported", {
            syno_path: file.synoPath,
            dirty: decision.dirty,
            reason: decision.reason,
          });
        }

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
            notSupported: false,
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

  logInfo("hash phase complete", {
    hashed: stats.hashed,
    hash_skipped: hashSkipped,
    dirty: stats.dirty,
    not_supported: stats.notSupported,
  });

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

  const routedFiles: RoutedDirtyFile[] = remainingDirtyFiles.map((file) => ({
    ...file,
    route: classifyFileRoute(basename(file.synoPath)),
  }));

  for (const file of routedFiles) {
    if (file.route !== "skip") {
      continue;
    }
    logInfo("clearing skip-type file without vision", {
      syno_path: file.synoPath,
      route: routeLogLabel(file.route),
    });
    await db.file.update({
      where: { id: file.id },
      data: { dirty: false, notSupported: true },
    });
  }

  const qwenQueue = routedFiles.filter((file) => routeNeedsQwen(file.route));

  const dirtyFolderCount = await countDirtyFolders(db);

  const workKind = planIndexWork(qwenQueue.length, dirtyFolderCount);

  if (workKind === "none") {
    logInfo("nothing dirty; skipping embed/vision phase");
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logInfo("index run complete", { elapsed_seconds: elapsed, reason, ...stats });
    return stats;
  }

  const upsertIndexedFile = async (params: {
    fileId: string;
    label: string;
    description: string;
    embedding: number[];
    embedModel: string;
    redacted: boolean;
    route: FileIndexRoute;
    synoPath: string;
  }): Promise<void> => {
    await db.$executeRaw`
      UPDATE files
      SET
        label = ${params.label},
        description = ${params.description},
        embedding = ${formatVectorForPg(params.embedding)}::vector,
        embed_model = ${params.embedModel},
        indexed_at = ${now},
        redacted = ${params.redacted},
        dirty = false
      WHERE id = ${params.fileId}::uuid
    `;
    stats.processed++;
    logInfo("file indexed", {
      syno_path: params.synoPath,
      route: routeLogLabel(params.route),
    });
  };

  const processQwenFile = async (
    file: RoutedDirtyFile,
    ollamaUrl: string,
    embedFn: (text: string) => Promise<{ embedding: number[]; model: string }>,
  ): Promise<void> => {
    const absolutePath = absolutePathForFile(config, file.synoPath);
    const vision = await describeRoutedFile(file, absolutePath, config, ollamaUrl);
    const embed = await embedFn(vision.description);
    await upsertIndexedFile({
      fileId: file.id,
      label: vision.label,
      description: vision.description,
      embedding: embed.embedding,
      embedModel: embed.model,
      redacted: vision.redacted,
      route: file.route,
      synoPath: file.synoPath,
    });
  };

  const processVisionPhase = async (ollamaUrl: string): Promise<void> => {
    const doclingFiles = qwenQueue.filter((file) => file.route === "docling");
    const nonDoclingFiles = qwenQueue.filter((file) => file.route !== "docling");

    const gpuEmbed = (text: string) => embedText(text, ollamaUrl, config.embedModel);

    const processFiles = async (files: RoutedDirtyFile[]): Promise<void> => {
      if (files.length === 0) {
        return;
      }

      logInfo("qwen phase batch started", { qwen_files: files.length });

      for (const file of files) {
        try {
          await processQwenFile(file, ollamaUrl, gpuEmbed);
        } catch (err) {
          logErrorWithCause("qwen/embedding failed", err, {
            syno_path: file.synoPath,
            route: routeLogLabel(file.route),
          });
          stats.errors++;
        }
      }
    };

    const failDoclingFiles = (err: unknown, message: string): void => {
      for (const file of doclingFiles) {
        logErrorWithCause(message, err, {
          syno_path: file.synoPath,
          route: routeLogLabel(file.route),
        });
        stats.errors++;
      }
    };

    logInfo("qwen phase started", {
      qwen_files: qwenQueue.length,
      docling_files: doclingFiles.length,
    });

    await processFiles(nonDoclingFiles);

    if (doclingFiles.length > 0) {
      if (!isDoclingSidecarConfigured(config)) {
        failDoclingFiles(
          new Error("DOCLING_SERVE_URL and Docker socket access are required for docling routes"),
          "docling sidecar unavailable",
        );
      } else {
        try {
          await withDoclingSidecar(
            doclingSidecarConfigFrom(config),
            () => processFiles(doclingFiles),
            { leaveRunning: config.doclingLeaveRunning },
          );
        } catch (err) {
          failDoclingFiles(err, "docling sidecar lifecycle failed");
        }
      }
    }

    const folderCount = await countDirtyFolders(db);
    if (folderCount > 0) {
      logInfo("rebuilding dirty folders on GPU Ollama session", { count: folderCount });
      try {
        const result = await rebuildDirtyFolders(
          db,
          (text) => embedText(text, ollamaUrl, config.embedModel),
          now,
        );
        stats.foldersRebuilt += result.rebuilt;
        stats.errors += result.failed;
        logInfo("dirty folder rebuild finished", {
          rebuilt: result.rebuilt,
          failed: result.failed,
        });
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
      const result = await rebuildDirtyFolders(
        db,
        (text) => embedTextCpu(text),
        now,
      );
      stats.foldersRebuilt += result.rebuilt;
      stats.errors += result.failed;
      logInfo("CPU dirty folder rebuild finished", {
        rebuilt: result.rebuilt,
        failed: result.failed,
      });
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
      if (config.ollamaBaseUrl) {
        logWarn(
          "OLLAMA_BASE_URL is ignored when RunPod ephemeral GPU is configured; using RunPod HTTP proxy for the created pod",
        );
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

      // Never pass OLLAMA_BASE_URL into ephemeral RunPod — it may point at a terminated sticky pod.
      await withGpuPod(
        runpodConfig,
        ollamaUrlOverrideForGpuPod(config),
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
    docling_sidecar_configured: isDoclingSidecarConfigured(config),
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
