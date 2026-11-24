export interface TelegramSearchConfig {
  apiUrl: string;
  token: string;
  timeoutMs: number;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): TelegramSearchConfig {
  const token = env.TG_SEARCH_API_TOKEN?.trim() ?? "";
  if (!token) {
    throw new Error("TG_SEARCH_API_TOKEN is not set");
  }

  const apiUrl = (env.TG_SEARCH_API_URL?.trim() || "http://100.118.169.52:8787").replace(/\/+$/, "");

  const timeoutRaw = env.TG_SEARCH_API_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("TG_SEARCH_API_TIMEOUT_MS must be a positive integer");
  }

  return { apiUrl, token, timeoutMs };
}
