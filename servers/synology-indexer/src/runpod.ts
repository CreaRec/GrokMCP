import { logInfo, logErrorWithCause, logWarn } from "./telemetry.js";

const RUNPOD_API_BASE = "https://api.runpod.io/graphql";

/** Default: 6 attempts ~2 minutes apart ≈ 10–12 minutes total. */
export const DEFAULT_START_ATTEMPTS = 6;
export const DEFAULT_START_RETRY_MS = 120_000;

export interface RunPodConfig {
  apiKey: string;
  podId: string;
  ollamaPort: number;
}

export type PodStatus = "CREATED" | "RUNNING" | "EXITED" | "PAUSED" | "TERMINATED" | "UNKNOWN";

export interface StartPodOptions {
  /** Total resume attempts (default 6 from RUNPOD_START_RETRIES). */
  maxAttempts?: number;
  /** Delay between capacity retries in ms (default 120000 from RUNPOD_START_RETRY_MS). */
  retryDelayMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

interface PodInfo {
  id: string;
  desiredStatus: string;
  runtime: {
    ports?: Array<{ ip: string; publicPort: number; privatePort: number; type: string }>;
  } | null;
}

export function getStartPodRetryDefaults(
  env: NodeJS.ProcessEnv = process.env,
): { maxAttempts: number; retryDelayMs: number } {
  const retriesRaw = env.RUNPOD_START_RETRIES;
  const delayRaw = env.RUNPOD_START_RETRY_MS;

  const parsedAttempts = retriesRaw !== undefined ? parseInt(retriesRaw, 10) : DEFAULT_START_ATTEMPTS;
  const parsedDelay = delayRaw !== undefined ? parseInt(delayRaw, 10) : DEFAULT_START_RETRY_MS;

  return {
    maxAttempts: Number.isFinite(parsedAttempts) && parsedAttempts >= 1 ? parsedAttempts : DEFAULT_START_ATTEMPTS,
    retryDelayMs: Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : DEFAULT_START_RETRY_MS,
  };
}

/**
 * Retry only host GPU capacity / no-free-GPU class errors.
 * Never retry auth (401) or TERMINATED pods.
 */
export function isRetryablePodStartError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("authentication") ||
    lower.includes("terminated")
  ) {
    return false;
  }

  return (
    lower.includes("not enough free gpu") ||
    lower.includes("not enough free gpus") ||
    lower.includes("no free gpu") ||
    lower.includes("no free gpus") ||
    (lower.includes("insufficient") && lower.includes("gpu")) ||
    (lower.includes("capacity") && lower.includes("gpu"))
  );
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphqlRequest(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await fetch(RUNPOD_API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`RunPod API error: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (result.errors && result.errors.length > 0) {
    throw new Error(`RunPod GraphQL error: ${result.errors[0].message}`);
  }

  return result.data;
}

export async function getPodStatus(config: RunPodConfig): Promise<{ status: PodStatus; pod: PodInfo | null }> {
  const query = `
    query getPod($podId: String!) {
      pod(input: { podId: $podId }) {
        id
        desiredStatus
        runtime {
          ports {
            ip
            publicPort
            privatePort
            type
          }
        }
      }
    }
  `;

  const data = (await graphqlRequest(config.apiKey, query, { podId: config.podId })) as {
    pod: PodInfo | null;
  };

  if (!data.pod) {
    return { status: "UNKNOWN", pod: null };
  }

  return {
    status: data.pod.desiredStatus as PodStatus,
    pod: data.pod,
  };
}

export async function startPod(
  config: RunPodConfig,
  options: StartPodOptions = {},
): Promise<void> {
  const defaults = getStartPodRetryDefaults();
  const maxAttempts = options.maxAttempts ?? defaults.maxAttempts;
  const retryDelayMs = options.retryDelayMs ?? defaults.retryDelayMs;
  const sleep = options.sleep ?? defaultSleep;

  const query = `
    mutation resumePod($podId: String!) {
      podResume(input: { podId: $podId }) {
        id
        desiredStatus
      }
    }
  `;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await graphqlRequest(config.apiKey, query, { podId: config.podId });
      logInfo("runpod pod started", {
        pod_id: config.podId,
        attempt,
        max_attempts: maxAttempts,
      });
      return;
    } catch (err) {
      lastError = err;
      const retryable = isRetryablePodStartError(err);
      const message = err instanceof Error ? err.message : String(err);

      if (!retryable || attempt >= maxAttempts) {
        logWarn("runpod pod start failed", {
          pod_id: config.podId,
          attempt,
          max_attempts: maxAttempts,
          retryable,
          error: message,
        });
        throw err;
      }

      logWarn("runpod pod start capacity error; retrying", {
        pod_id: config.podId,
        attempt,
        max_attempts: maxAttempts,
        retry_delay_ms: retryDelayMs,
        error: message,
      });
      await sleep(retryDelayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to start pod ${config.podId}`);
}

export async function stopPod(config: RunPodConfig): Promise<void> {
  const query = `
    mutation stopPod($podId: String!) {
      podStop(input: { podId: $podId }) {
        id
        desiredStatus
      }
    }
  `;

  await graphqlRequest(config.apiKey, query, { podId: config.podId });
  logInfo("runpod pod stopped", { pod_id: config.podId });
}

export function getOllamaUrlFromPod(pod: PodInfo, ollamaPort: number): string | null {
  if (!pod.runtime?.ports) {
    return null;
  }

  const ollamaPortInfo = pod.runtime.ports.find((p) => p.privatePort === ollamaPort);
  if (!ollamaPortInfo) {
    return null;
  }

  return `http://${ollamaPortInfo.ip}:${ollamaPortInfo.publicPort}`;
}

export async function waitForPodRunning(
  config: RunPodConfig,
  timeoutMs: number = 600000,
  pollIntervalMs: number = 5000,
): Promise<PodInfo> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const { status, pod } = await getPodStatus(config);

    if (status === "RUNNING" && pod) {
      logInfo("runpod pod running", { pod_id: config.podId });
      return pod;
    }

    if (status === "TERMINATED") {
      throw new Error(`Pod ${config.podId} is TERMINATED and cannot be started`);
    }

    logInfo("runpod waiting for pod", { pod_id: config.podId, status });
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timeout waiting for pod ${config.podId} to reach RUNNING state`);
}

export async function waitForOllamaHealthy(
  ollamaUrl: string,
  timeoutMs: number = 60000,
  pollIntervalMs: number = 3000,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${ollamaUrl}/api/tags`, { method: "GET" });
      if (response.ok) {
        logInfo("runpod ollama healthy");
        return;
      }
    } catch {
      // Connection refused or other error, keep trying
    }

    logInfo("runpod waiting for ollama");
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timeout waiting for Ollama to be healthy at ${ollamaUrl}`);
}

export async function pullModelIfMissing(
  ollamaUrl: string,
  modelName: string,
): Promise<void> {
  const tagsResponse = await fetch(`${ollamaUrl}/api/tags`, { method: "GET" });
  if (!tagsResponse.ok) {
    throw new Error(`Failed to get Ollama tags: ${tagsResponse.status}`);
  }

  const tags = (await tagsResponse.json()) as { models?: Array<{ name: string }> };
  const modelExists = tags.models?.some(
    (m) => m.name === modelName || m.name.startsWith(`${modelName}:`)
  );

  if (modelExists) {
    logInfo("runpod model already present", { model: modelName });
    return;
  }

  logInfo("runpod pulling model", { model: modelName });
  const pullResponse = await fetch(`${ollamaUrl}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelName, stream: false }),
  });

  if (!pullResponse.ok) {
    throw new Error(`Failed to pull model ${modelName}: ${pullResponse.status}`);
  }

  logInfo("runpod model pulled", { model: modelName });
}

export interface GpuLifecycleOptions {
  leaveRunning?: boolean;
  onStart?: () => void;
  onStop?: () => void;
}

export async function withGpuPod<T>(
  config: RunPodConfig,
  ollamaUrlOverride: string | null,
  visionModel: string,
  embedModel: string,
  fn: (ollamaUrl: string) => Promise<T>,
  options?: GpuLifecycleOptions,
): Promise<T> {
  let ollamaUrl = ollamaUrlOverride;
  let podUsed = false;

  try {
    const { status } = await getPodStatus(config);
    
    if (status !== "RUNNING") {
      logInfo("runpod starting pod", { pod_id: config.podId, status });
      await startPod(config);
      options?.onStart?.();
    } else {
      logInfo("runpod pod already running", { pod_id: config.podId });
    }

    podUsed = true;

    const pod = await waitForPodRunning(config);

    if (!ollamaUrl) {
      ollamaUrl = getOllamaUrlFromPod(pod, config.ollamaPort);
      if (!ollamaUrl) {
        throw new Error(`Could not determine Ollama URL from pod ports`);
      }
      logInfo("runpod derived ollama url");
    }

    await waitForOllamaHealthy(ollamaUrl);

    await pullModelIfMissing(ollamaUrl, visionModel);
    await pullModelIfMissing(ollamaUrl, embedModel);

    return await fn(ollamaUrl);
  } finally {
    if (podUsed && !options?.leaveRunning) {
      try {
        await stopPod(config);
        options?.onStop?.();
      } catch (err) {
        logErrorWithCause("runpod stop failed", err, { pod_id: config.podId });
      }
    } else if (options?.leaveRunning) {
      logInfo("runpod leaving pod running", { pod_id: config.podId });
    }
  }
}
