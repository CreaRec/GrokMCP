export interface Config {
  databaseUrl: string;
  mountRoot: string;
  indexDailyAt: string;
  timezone: string;
  runOnce: boolean;
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

  return {
    databaseUrl,
    mountRoot,
    indexDailyAt: process.env.INDEX_DAILY_AT ?? "21:00",
    timezone: process.env.TZ ?? "America/Chicago",
    runOnce,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? null,
    visionModel: process.env.VISION_MODEL ?? "qwen2.5vl:7b",
    embedModel: process.env.EMBED_MODEL ?? "mxbai-embed-large",
    dsmHost: process.env.DSM_HOST ?? null,
    dsmShareUser: process.env.DSM_SHARE_USER ?? null,
    dsmSharePassword: process.env.DSM_SHARE_PASSWORD ?? null,
    runpodApiKey: process.env.RUNPOD_API_KEY ?? null,
    runpodPodId: process.env.RUNPOD_POD_ID ?? null,
    runpodTemplateId: process.env.RUNPOD_TEMPLATE_ID ?? null,
    runpodImage: process.env.RUNPOD_IMAGE ?? "ollama/ollama",
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
