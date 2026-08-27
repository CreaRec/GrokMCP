import { logInfo, logErrorWithCause, logWarn } from "./telemetry.js";

const RUNPOD_API_BASE = "https://api.runpod.io/graphql";

/** Default: 6 attempts ~2 minutes apart ≈ 10–12 minutes total. */
export const DEFAULT_START_ATTEMPTS = 6;
export const DEFAULT_START_RETRY_MS = 120_000;
export const DEFAULT_OLLAMA_HEALTHY_TIMEOUT_MS = 180_000;
/** How long to wait for runtime.ports after desiredStatus becomes RUNNING. */
export const DEFAULT_OLLAMA_PORTS_TIMEOUT_MS = 90_000;
export const DEFAULT_OLLAMA_PORTS_POLL_MS = 2_000;

/** Deploy-time configuration for ephemeral on-demand pods. */
export interface RunPodDeployConfig {
  apiKey: string;
  ollamaPort: number;
  templateId: string | null;
  imageName: string;
  cloudType: string;
  gpuTypeId: string;
  containerDiskInGb: number;
  dataCenterId: string | null;
  podName: string;
  ollamaHealthyTimeoutMs: number;
  /** Wait for published ports after RUNNING (default 90s). */
  ollamaPortsTimeoutMs: number;
}

/** Runtime reference to a specific pod instance. */
export interface RunPodPodConfig {
  apiKey: string;
  podId: string;
  ollamaPort: number;
}

export type PodStatus = "CREATED" | "RUNNING" | "EXITED" | "PAUSED" | "TERMINATED" | "UNKNOWN";

export interface CreatePodOptions {
  /** Total create attempts (default 6 from RUNPOD_START_RETRIES). */
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
 * Retry only GPU capacity / fleet stock class errors on pod create.
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
    lower.includes("no longer any instances available") ||
    lower.includes("no instances available") ||
    lower.includes("zero gpu") ||
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

/** RunPod env entries so Ollama listens on all interfaces (not 127.0.0.1). */
export function ollamaContainerEnv(ollamaPort: number): Array<{ key: string; value: string }> {
  return [{ key: "OLLAMA_HOST", value: `0.0.0.0:${ollamaPort}` }];
}

export function buildDeployInput(config: RunPodDeployConfig): Record<string, unknown> {
  const input: Record<string, unknown> = {
    name: config.podName,
    gpuCount: 1,
    volumeInGb: 0,
    ports: `${config.ollamaPort}/http`,
    env: ollamaContainerEnv(config.ollamaPort),
  };

  if (config.templateId) {
    input.templateId = config.templateId;
  } else {
    input.cloudType = config.cloudType;
    input.gpuTypeId = config.gpuTypeId;
    input.imageName = config.imageName;
    input.containerDiskInGb = config.containerDiskInGb;
  }

  if (config.dataCenterId) {
    input.dataCenterId = config.dataCenterId;
  }

  return input;
}

export async function createPod(
  config: RunPodDeployConfig,
  options: CreatePodOptions = {},
): Promise<RunPodPodConfig> {
  const defaults = getStartPodRetryDefaults();
  const maxAttempts = options.maxAttempts ?? defaults.maxAttempts;
  const retryDelayMs = options.retryDelayMs ?? defaults.retryDelayMs;
  const sleep = options.sleep ?? defaultSleep;

  const query = `
    mutation deployPod($input: PodFindAndDeployOnDemandInput!) {
      podFindAndDeployOnDemand(input: $input) {
        id
        desiredStatus
      }
    }
  `;

  const variables = { input: buildDeployInput(config) };
  let lastError: unknown;
  let allocatedPodId: string | null = null;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const data = (await graphqlRequest(config.apiKey, query, variables)) as {
          podFindAndDeployOnDemand: { id: string; desiredStatus: string };
        };

        allocatedPodId = data.podFindAndDeployOnDemand.id;
        logInfo("runpod pod created", {
          pod_id: allocatedPodId,
          attempt,
          max_attempts: maxAttempts,
        });

        return {
          apiKey: config.apiKey,
          podId: allocatedPodId,
          ollamaPort: config.ollamaPort,
        };
      } catch (err) {
        lastError = err;
        const retryable = isRetryablePodStartError(err);
        const message = err instanceof Error ? err.message : String(err);

        if (!retryable || attempt >= maxAttempts) {
          logWarn("runpod pod create failed", {
            attempt,
            max_attempts: maxAttempts,
            retryable,
            error: message,
          });
          throw err;
        }

        logWarn("runpod pod create capacity error; retrying", {
          attempt,
          max_attempts: maxAttempts,
          retry_delay_ms: retryDelayMs,
          error: message,
        });
        await sleep(retryDelayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to create RunPod pod");
  } catch (err) {
    if (allocatedPodId) {
      try {
        await terminatePod({
          apiKey: config.apiKey,
          podId: allocatedPodId,
          ollamaPort: config.ollamaPort,
        });
      } catch (terminateErr) {
        logErrorWithCause("runpod terminate after failed create", terminateErr, {
          pod_id: allocatedPodId,
        });
      }
    }
    throw err;
  }
}

export async function terminatePod(config: RunPodPodConfig): Promise<void> {
  const query = `
    mutation terminatePod($input: PodTerminateInput!) {
      podTerminate(input: $input)
    }
  `;

  await graphqlRequest(config.apiKey, query, { input: { podId: config.podId } });
  logInfo("runpod pod terminated", { pod_id: config.podId });
}

export async function getPodStatus(
  config: RunPodPodConfig,
): Promise<{ status: PodStatus; pod: PodInfo | null }> {
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

/**
 * Derive Ollama base URL from published pod ports.
 * Matches by privatePort only (http or tcp) — RunPod may label the mapping either way.
 */
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

/** Safe port summary for logs — scalars only; never includes ip / proxy host tokens. */
export function summarizePodPortsSafe(pod: PodInfo | null): {
  port_count: number;
  ports_summary: string;
} {
  const ports = pod?.runtime?.ports ?? [];
  return {
    port_count: ports.length,
    ports_summary: ports
      .map((p) => `${p.privatePort}/${p.type}->${p.publicPort}`)
      .join(","),
  };
}

export interface WaitForOllamaUrlOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * After the pod is RUNNING, keep polling until runtime.ports publishes the Ollama mapping.
 * Empty/null ports on the first RUNNING sample are not a hard failure.
 */
export async function waitForOllamaUrlFromPod(
  config: RunPodPodConfig,
  ollamaPort: number,
  options: WaitForOllamaUrlOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OLLAMA_PORTS_TIMEOUT_MS;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_OLLAMA_PORTS_POLL_MS);
  const sleep = options.sleep ?? defaultSleep;
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  let lastPod: PodInfo | null = null;

  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    const { status, pod } = await getPodStatus(config);
    lastPod = pod;

    if (status === "TERMINATED") {
      throw new Error(`Pod ${config.podId} is TERMINATED and cannot be started`);
    }

    if (pod) {
      const url = getOllamaUrlFromPod(pod, ollamaPort);
      if (url) {
        logInfo("runpod ollama ports ready", { pod_id: config.podId });
        return url;
      }
    }

    if (attempt < maxPolls) {
      logInfo("runpod waiting for ollama ports", {
        pod_id: config.podId,
        status,
        attempt,
        max_attempts: maxPolls,
        ...summarizePodPortsSafe(pod),
      });
      await sleep(pollIntervalMs);
    }
  }

  logWarn("runpod ollama ports timeout", {
    pod_id: config.podId,
    timeout_ms: timeoutMs,
    ...summarizePodPortsSafe(lastPod),
  });
  throw new Error("Could not determine Ollama URL from pod ports");
}

export async function waitForPodRunning(
  config: RunPodPodConfig,
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
  timeoutMs: number = DEFAULT_OLLAMA_HEALTHY_TIMEOUT_MS,
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
    (m) => m.name === modelName || m.name.startsWith(`${modelName}:`),
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
  /** Injectable sleep for ports / wait loops (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Ports poll interval override (tests). */
  portsPollIntervalMs?: number;
}

export async function withGpuPod<T>(
  deployConfig: RunPodDeployConfig,
  ollamaUrlOverride: string | null,
  visionModel: string,
  embedModel: string,
  fn: (ollamaUrl: string) => Promise<T>,
  options?: GpuLifecycleOptions,
): Promise<T> {
  let ollamaUrl = ollamaUrlOverride;
  let podRef: RunPodPodConfig | null = null;

  try {
    logInfo("runpod creating ephemeral pod");
    podRef = await createPod(deployConfig);
    options?.onStart?.();

    // RUNNING can precede published ports — do not derive URL from this first sample alone.
    await waitForPodRunning(podRef);

    if (!ollamaUrl) {
      ollamaUrl = await waitForOllamaUrlFromPod(podRef, deployConfig.ollamaPort, {
        timeoutMs: deployConfig.ollamaPortsTimeoutMs,
        pollIntervalMs: options?.portsPollIntervalMs,
        sleep: options?.sleep,
      });
      // Log source only — never log the URL (may include host tokens / proxy ids).
      logInfo("runpod ollama url source", { source: "derived" });
    } else {
      logInfo("runpod ollama url source", { source: "override" });
    }

    await waitForOllamaHealthy(ollamaUrl, deployConfig.ollamaHealthyTimeoutMs);

    await pullModelIfMissing(ollamaUrl, visionModel);
    await pullModelIfMissing(ollamaUrl, embedModel);

    return await fn(ollamaUrl);
  } finally {
    if (podRef && !options?.leaveRunning) {
      try {
        await terminatePod(podRef);
        options?.onStop?.();
      } catch (err) {
        logErrorWithCause("runpod terminate failed", err, { pod_id: podRef.podId });
      }
    } else if (options?.leaveRunning && podRef) {
      logInfo("runpod leaving pod running", { pod_id: podRef.podId });
    }
  }
}
