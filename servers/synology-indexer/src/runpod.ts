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
  console.log(`[runpod] Started pod ${config.podId}`);
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
  console.log(`[runpod] Stopped pod ${config.podId}`);
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
  timeoutMs: number = 120000,
  pollIntervalMs: number = 5000,
): Promise<PodInfo> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const { status, pod } = await getPodStatus(config);

    if (status === "RUNNING" && pod) {
      console.log(`[runpod] Pod ${config.podId} is RUNNING`);
      return pod;
    }

    if (status === "TERMINATED") {
      throw new Error(`Pod ${config.podId} is TERMINATED and cannot be started`);
    }

    console.log(`[runpod] Pod status: ${status}, waiting...`);
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
        console.log(`[runpod] Ollama is healthy at ${ollamaUrl}`);
        return;
      }
    } catch {
      // Connection refused or other error, keep trying
    }

    console.log(`[runpod] Waiting for Ollama to be healthy...`);
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
    console.log(`[runpod] Model ${modelName} already present`);
    return;
  }

  console.log(`[runpod] Pulling model ${modelName}...`);
  const pullResponse = await fetch(`${ollamaUrl}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelName, stream: false }),
  });

  if (!pullResponse.ok) {
    throw new Error(`Failed to pull model ${modelName}: ${pullResponse.status}`);
  }

  console.log(`[runpod] Model ${modelName} pulled successfully`);
}

export interface GpuLifecycleCallbacks {
  onStart?: () => void;
  onStop?: () => void;
}

export async function withGpuPod<T>(
  config: RunPodConfig,
  ollamaUrlOverride: string | null,
  visionModel: string,
  embedModel: string,
  fn: (ollamaUrl: string) => Promise<T>,
  callbacks?: GpuLifecycleCallbacks,
): Promise<T> {
  let podStarted = false;
  let ollamaUrl = ollamaUrlOverride;

  try {
    const { status } = await getPodStatus(config);
    
    if (status !== "RUNNING") {
      console.log(`[runpod] Pod status is ${status}, starting...`);
      await startPod(config);
      podStarted = true;
      callbacks?.onStart?.();
    } else {
      console.log(`[runpod] Pod already RUNNING`);
    }

    const pod = await waitForPodRunning(config);

    if (!ollamaUrl) {
      ollamaUrl = getOllamaUrlFromPod(pod, config.ollamaPort);
      if (!ollamaUrl) {
        throw new Error(`Could not determine Ollama URL from pod ports`);
      }
      console.log(`[runpod] Derived Ollama URL: ${ollamaUrl}`);
    }

    await waitForOllamaHealthy(ollamaUrl);

    await pullModelIfMissing(ollamaUrl, visionModel);
    await pullModelIfMissing(ollamaUrl, embedModel);

    return await fn(ollamaUrl);
  } finally {
    if (podStarted) {
      try {
        await stopPod(config);
        callbacks?.onStop?.();
      } catch (err) {
        console.error(`[runpod] Error stopping pod:`, err);
      }
    }
  }
}
