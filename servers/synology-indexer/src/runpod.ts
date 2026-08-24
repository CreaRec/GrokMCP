import { logInfo, logErrorWithCause } from "./telemetry.js";

const RUNPOD_API_BASE = "https://api.runpod.io/graphql";

export interface RunPodConfig {
  apiKey: string;
  podId: string;
  ollamaPort: number;
}

export type PodStatus = "CREATED" | "RUNNING" | "EXITED" | "PAUSED" | "TERMINATED" | "UNKNOWN";

interface PodInfo {
  id: string;
  desiredStatus: string;
  runtime: {
    ports?: Array<{ ip: string; publicPort: number; privatePort: number; type: string }>;
  } | null;
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

export async function startPod(config: RunPodConfig): Promise<void> {
  const query = `
    mutation resumePod($podId: String!) {
      podResume(input: { podId: $podId }) {
        id
        desiredStatus
      }
    }
  `;

  await graphqlRequest(config.apiKey, query, { podId: config.podId });
  logInfo("runpod pod started", { pod_id: config.podId });
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
