/**
 * Default Ollama vision model for image/document gists.
 *
 * Official library tag on https://ollama.com/library/qwen2.5vl (verified):
 * `qwen2.5vl:7b` — no hyphen between "2.5" and "vl".
 * Wrong names that 404/fail on pull: `qwen2.5-vl:7b`, `qwen2.5-vl`.
 * Requires Ollama ≥ 0.7.0 (see DEFAULT_RUNPOD_IMAGE).
 */
export const DEFAULT_VISION_MODEL = "qwen2.5vl:7b";

/**
 * Default RunPod container image for ephemeral Ollama pods.
 *
 * Pin a version tag — bare `ollama/ollama` (latest) is unsafe on RunPod Secure
 * Cloud: hosts may serve a stale cached `latest` that pre-dates qwen2.5vl
 * support, and floating latest drifts without a deploy. 0.34.2 is ≥ 0.7.0 and
 * matched Docker Hub `latest` when this pin was chosen (2026-09).
 */
export const DEFAULT_RUNPOD_IMAGE = "ollama/ollama:0.34.2";

/** Minimum Ollama version that can pull/run qwen2.5vl (per ollama.com/library). */
export const MIN_OLLAMA_VERSION_FOR_VISION = "0.7.0";

/**
 * Resolve RUNPOD_IMAGE. Bare `ollama/ollama` / `:latest` are rewritten to
 * {@link DEFAULT_RUNPOD_IMAGE} so a leftover Debian `.env` pin does not keep
 * pulling a stale Secure Cloud cached digest.
 */
export function resolveRunpodImage(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (
    !trimmed ||
    trimmed === "ollama/ollama" ||
    trimmed === "ollama/ollama:latest"
  ) {
    return DEFAULT_RUNPOD_IMAGE;
  }
  return trimmed;
}

export interface Config {
  databaseUrl: string;
  mountRoot: string;
  indexDailyAt: string;
  timezone: string;
  runOnce: boolean;
  /** Bytes read from plain-text files for qwen gist. */
  textHeadBytes: number;
  /** Max document excerpt characters sent to qwen. */
  qwenDocumentChars: number;
  /** Max DESCRIPTION length before mxbai embed. */
  maxDescriptionChars: number;
  /** Max characters per embed chunk (mxbai 512-token context). */
  maxEmbedChars: number;
  /** Overlap between embed chunks (chars). */
  embedChunkOverlap: number;
  ollamaBaseUrl: string | null;
  visionModel: string;
  embedModel: string;
  dsmHost: string | null;
  dsmShareUser: string | null;
  dsmSharePassword: string | null;
  runpodApiKey: string | null;
  /** @deprecated Ignored — pods are created ephemerally per GPU session. */
  runpodPodId: string | null;
  runpodTemplateId: string | null;
  runpodImage: string;
  runpodCloudType: string;
  runpodGpuTypeId: string;
  runpodContainerDiskGb: number;
  runpodDataCenterId: string | null;
  runpodOllamaPort: number;
  runpodOllamaHealthyTimeoutMs: number;
  runpodLeaveRunning: boolean;
  doclingServeUrl: string | null;
  doclingContainerName: string;
  doclingHealthyTimeoutMs: number;
  doclingLeaveRunning: boolean;
  /** Client-side timeout for Docling /v1/convert/file (ms). */
  doclingConvertTimeoutMs: number;
  /** Docling document_timeout form field (seconds). */
  doclingDocumentTimeoutSec: number;
  /** Last page (inclusive, 1-based) for Docling page_range gist on every docling file. */
  doclingPageRangeEnd: number;
  dockerSocketPath: string;
}

export function getConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing required env var: DATABASE_URL");
  }

  const mountRoot = process.env.MOUNT_ROOT;
  if (!mountRoot) {
    throw new Error("Missing required env var: MOUNT_ROOT");
  }

  const runOnceStr = process.env.RUN_ONCE;
  const runOnce = runOnceStr === "1" || runOnceStr === "true";

  const containerDiskRaw = process.env.RUNPOD_CONTAINER_DISK_GB ?? "80";
  const parsedContainerDisk = parseInt(containerDiskRaw, 10);

  const ollamaHealthyRaw = process.env.RUNPOD_OLLAMA_HEALTHY_TIMEOUT_MS ?? "600000";
  const parsedOllamaHealthy = parseInt(ollamaHealthyRaw, 10);

  const doclingHealthyRaw = process.env.DOCLING_HEALTHY_TIMEOUT_MS ?? "300000";
  const parsedDoclingHealthy = parseInt(doclingHealthyRaw, 10);

  const textHeadRaw = process.env.INDEX_TEXT_HEAD_BYTES ?? "65536";
  const parsedTextHead = parseInt(textHeadRaw, 10);

  const qwenDocRaw = process.env.INDEX_QWEN_DOCUMENT_CHARS ?? "32768";
  const parsedQwenDoc = parseInt(qwenDocRaw, 10);

  const maxDescRaw = process.env.INDEX_MAX_DESCRIPTION_CHARS ?? "500";
  const parsedMaxDesc = parseInt(maxDescRaw, 10);

  const maxEmbedRaw = process.env.INDEX_MAX_EMBED_CHARS ?? "1500";
  const parsedMaxEmbed = parseInt(maxEmbedRaw, 10);

  const embedOverlapRaw = process.env.INDEX_EMBED_CHUNK_OVERLAP ?? "100";
  const parsedEmbedOverlap = parseInt(embedOverlapRaw, 10);

  const doclingConvertRaw = process.env.DOCLING_CONVERT_TIMEOUT_MS ?? "90000";
  const parsedDoclingConvert = parseInt(doclingConvertRaw, 10);

  const doclingDocTimeoutRaw = process.env.DOCLING_DOCUMENT_TIMEOUT_SEC ?? "90";
  const parsedDoclingDocTimeout = parseInt(doclingDocTimeoutRaw, 10);

  const doclingPageEndRaw = process.env.DOCLING_PAGE_RANGE_END ?? "5";
  const parsedDoclingPageEnd = parseInt(doclingPageEndRaw, 10);

  return {
    databaseUrl,
    mountRoot,
    indexDailyAt: process.env.INDEX_DAILY_AT ?? "21:00",
    timezone: process.env.TZ ?? "America/Chicago",
    runOnce,
    textHeadBytes:
      Number.isFinite(parsedTextHead) && parsedTextHead > 0 ? parsedTextHead : 65_536,
    qwenDocumentChars:
      Number.isFinite(parsedQwenDoc) && parsedQwenDoc > 0 ? parsedQwenDoc : 32_768,
    maxDescriptionChars:
      Number.isFinite(parsedMaxDesc) && parsedMaxDesc > 0 ? parsedMaxDesc : 500,
    maxEmbedChars:
      Number.isFinite(parsedMaxEmbed) && parsedMaxEmbed > 0 ? parsedMaxEmbed : 1_500,
    embedChunkOverlap:
      Number.isFinite(parsedEmbedOverlap) && parsedEmbedOverlap >= 0
        ? parsedEmbedOverlap
        : 100,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? null,
    visionModel: process.env.VISION_MODEL ?? DEFAULT_VISION_MODEL,
    embedModel: process.env.EMBED_MODEL ?? "mxbai-embed-large",
    dsmHost: process.env.DSM_HOST ?? null,
    dsmShareUser: process.env.DSM_SHARE_USER ?? null,
    dsmSharePassword: process.env.DSM_SHARE_PASSWORD ?? null,
    runpodApiKey: process.env.RUNPOD_API_KEY ?? null,
    runpodPodId: process.env.RUNPOD_POD_ID ?? null,
    runpodTemplateId: process.env.RUNPOD_TEMPLATE_ID ?? null,
    runpodImage: resolveRunpodImage(process.env.RUNPOD_IMAGE),
    runpodCloudType: process.env.RUNPOD_CLOUD_TYPE ?? "SECURE",
    runpodGpuTypeId: process.env.RUNPOD_GPU_TYPE_ID ?? "NVIDIA GeForce RTX 4090",
    runpodContainerDiskGb:
      Number.isFinite(parsedContainerDisk) && parsedContainerDisk > 0 ? parsedContainerDisk : 80,
    runpodDataCenterId: process.env.RUNPOD_DATA_CENTER_ID ?? null,
    runpodOllamaPort: parseInt(process.env.RUNPOD_OLLAMA_PORT ?? "11434", 10),
    runpodOllamaHealthyTimeoutMs:
      Number.isFinite(parsedOllamaHealthy) && parsedOllamaHealthy > 0 ? parsedOllamaHealthy : 600_000,
    runpodLeaveRunning: process.env.RUNPOD_LEAVE_RUNNING === "1",
    doclingServeUrl: process.env.DOCLING_SERVE_URL ?? null,
    doclingContainerName: process.env.DOCLING_CONTAINER_NAME ?? "grok-mcp-docling-serve",
    doclingHealthyTimeoutMs:
      Number.isFinite(parsedDoclingHealthy) && parsedDoclingHealthy > 0
        ? parsedDoclingHealthy
        : 300_000,
    doclingLeaveRunning: process.env.DOCLING_LEAVE_RUNNING === "1",
    doclingConvertTimeoutMs:
      Number.isFinite(parsedDoclingConvert) && parsedDoclingConvert > 0
        ? parsedDoclingConvert
        : 90_000,
    doclingDocumentTimeoutSec:
      Number.isFinite(parsedDoclingDocTimeout) && parsedDoclingDocTimeout > 0
        ? parsedDoclingDocTimeout
        : 90,
    doclingPageRangeEnd:
      Number.isFinite(parsedDoclingPageEnd) && parsedDoclingPageEnd > 0
        ? parsedDoclingPageEnd
        : 5,
    dockerSocketPath: process.env.DOCKER_HOST?.startsWith("unix://")
      ? process.env.DOCKER_HOST.slice("unix://".length)
      : (process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock"),
  };
}

/** True when ephemeral docling-serve lifecycle can be managed via Docker. */
export function isDoclingSidecarConfigured(config: Config): boolean {
  return Boolean(config.doclingServeUrl && config.dockerSocketPath);
}

export function doclingSidecarConfigFrom(config: Config): {
  containerName: string;
  doclingServeUrl: string;
  dockerSocketPath: string;
  healthyTimeoutMs: number;
} {
  if (!config.doclingServeUrl) {
    throw new Error("Docling is not configured (DOCLING_SERVE_URL)");
  }
  if (!config.dockerSocketPath) {
    throw new Error("Docker socket is not configured (DOCKER_SOCKET_PATH)");
  }
  return {
    containerName: config.doclingContainerName,
    doclingServeUrl: config.doclingServeUrl,
    dockerSocketPath: config.dockerSocketPath,
    healthyTimeoutMs: config.doclingHealthyTimeoutMs,
  };
}

/** True when RunPod ephemeral GPU lifecycle should be used (API key + template or image). */
export function isRunPodGpuConfigured(config: Config): boolean {
  return Boolean(config.runpodApiKey && (config.runpodTemplateId || config.runpodImage));
}

/**
 * Ollama URL override passed to withGpuPod.
 * Always null when ephemeral RunPod is configured — OLLAMA_BASE_URL must not pin a
 * stale sticky-pod proxy; the URL is always the RunPod HTTP proxy for the created pod.
 * OLLAMA_BASE_URL remains valid only for the non-RunPod (direct Ollama) path.
 */
export function ollamaUrlOverrideForGpuPod(config: Config): string | null {
  if (isRunPodGpuConfigured(config)) {
    return null;
  }
  return config.ollamaBaseUrl;
}

export function parseIndexTime(timeStr: string): { hour: number; minute: number } {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid INDEX_DAILY_AT format: ${timeStr}. Expected HH:MM`);
  }
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid INDEX_DAILY_AT time: ${timeStr}`);
  }
  return { hour, minute };
}
