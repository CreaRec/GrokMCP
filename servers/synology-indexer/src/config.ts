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
  runpodPodId: string | null;
  runpodOllamaPort: number;
  runpodLeaveRunning: boolean;
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
    runpodOllamaPort: parseInt(process.env.RUNPOD_OLLAMA_PORT ?? "11434", 10),
    runpodLeaveRunning: process.env.RUNPOD_LEAVE_RUNNING === "1",
  };
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
