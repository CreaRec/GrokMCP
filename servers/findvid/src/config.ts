import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./errors.js";

export interface FindvidConfig {
  apiId: number;
  apiHash: string;
  session: string;
  findvidBotUsername: string;
  /** Optional alternate inline bot (e.g. fvid_try_bot). Falls back to findvidBotUsername. */
  findvidInlineBotUsername: string;
  downloaderBotUsername: string;
  /** Max wait for bot replies / final video (ms). */
  waitTimeoutMs: number;
  /** Poll interval while waiting for bot messages (ms). */
  pollIntervalMs: number;
  /** Preferred voiceover label substring (default Дублированный). */
  preferredVoiceover: string;
  /** Preferred quality labels in priority order. */
  preferredQualities: string[];
}

interface DownloaderSettingsTelegram {
  apiId?: number;
  apiHash?: string;
  userSessions?: Record<string, string>;
  botUsername?: string;
}

interface DownloaderSettingsFile {
  telegram?: DownloaderSettingsTelegram;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function stripAt(username: string): string {
  return username.replace(/^@+/, "");
}

function parsePositiveInt(raw: string | undefined, fallback: number, envName: string): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${envName} must be a positive integer`);
  }
  return n;
}

export async function loadDownloaderSettings(
  settingsPath: string,
): Promise<DownloaderSettingsFile> {
  const resolved = path.resolve(settingsPath);
  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `Could not read TELEGRAM_SETTINGS_PATH at ${resolved}: ${message}`,
    );
  }
  try {
    return JSON.parse(raw) as DownloaderSettingsFile;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`TELEGRAM_SETTINGS_PATH is not valid JSON: ${message}`);
  }
}

/**
 * Resolve GramJS credentials from env and/or CreaVideoDownloaderBot settings.json.
 *
 * Preferred (no second login):
 * - TELEGRAM_SETTINGS_PATH + TELEGRAM_USER_ID → apiId/apiHash/session from settings
 * - Optional TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION override fields
 * - DOWNLOADER_BOT_USERNAME from env or settings.telegram.botUsername
 */
export async function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { loadSettings?: typeof loadDownloaderSettings } = {},
): Promise<FindvidConfig> {
  const settingsPath = env.TELEGRAM_SETTINGS_PATH?.trim();
  const userId = env.TELEGRAM_USER_ID?.trim();

  let fromSettings: DownloaderSettingsTelegram | undefined;
  if (settingsPath) {
    const load = options.loadSettings ?? loadDownloaderSettings;
    const file = await load(settingsPath);
    fromSettings = file.telegram;
  }

  const apiIdRaw = env.TELEGRAM_API_ID?.trim() || (fromSettings?.apiId != null ? String(fromSettings.apiId) : undefined);
  const apiHash = env.TELEGRAM_API_HASH?.trim() || fromSettings?.apiHash?.trim();
  let session = env.TELEGRAM_SESSION?.trim();

  if (!session && fromSettings?.userSessions && userId) {
    session = fromSettings.userSessions[userId]?.trim();
  }

  if (!session && fromSettings?.userSessions) {
    const entries = Object.entries(fromSettings.userSessions).filter(
      ([, value]) => typeof value === "string" && value.trim().length > 0,
    );
    if (entries.length === 1) {
      session = entries[0][1].trim();
    } else if (entries.length > 1 && !userId) {
      throw new ConfigError(
        "Multiple telegram.userSessions found; set TELEGRAM_USER_ID to pick one",
      );
    }
  }

  if (!apiIdRaw) {
    throw new ConfigError(
      "TELEGRAM_API_ID is required (or TELEGRAM_SETTINGS_PATH with telegram.apiId)",
    );
  }
  const apiId = Number.parseInt(apiIdRaw, 10);
  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new ConfigError("TELEGRAM_API_ID must be a positive integer");
  }
  if (!apiHash) {
    throw new ConfigError(
      "TELEGRAM_API_HASH is required (or TELEGRAM_SETTINGS_PATH with telegram.apiHash)",
    );
  }
  if (!session) {
    throw new ConfigError(
      "TELEGRAM_SESSION is required (or TELEGRAM_SETTINGS_PATH + TELEGRAM_USER_ID with a GramJS string session)",
    );
  }

  const findvidBotUsername = stripAt(
    env.FINDVID_BOT_USERNAME?.trim() || "fvidBot",
  );
  const findvidInlineBotUsername = stripAt(
    env.FINDVID_INLINE_BOT_USERNAME?.trim() || findvidBotUsername,
  );

  const downloaderFromEnv = env.DOWNLOADER_BOT_USERNAME?.trim();
  const downloaderFromSettings = fromSettings?.botUsername?.trim();
  const downloaderBotUsername = stripAt(
    downloaderFromEnv || downloaderFromSettings || "",
  );
  if (!downloaderBotUsername) {
    throw new ConfigError(
      "DOWNLOADER_BOT_USERNAME is required (or telegram.botUsername in TELEGRAM_SETTINGS_PATH)",
    );
  }

  const preferredVoiceover =
    env.FINDVID_PREFERRED_VOICEOVER?.trim() || "Дублированный";
  const preferredQualitiesRaw =
    env.FINDVID_PREFERRED_QUALITIES?.trim() || "1080p,720p,480p";
  const preferredQualities = preferredQualitiesRaw
    .split(",")
    .map((q) => q.trim())
    .filter(Boolean);

  return {
    apiId,
    apiHash,
    session,
    findvidBotUsername,
    findvidInlineBotUsername,
    downloaderBotUsername,
    waitTimeoutMs: parsePositiveInt(
      env.FINDVID_WAIT_TIMEOUT_MS?.trim(),
      120_000,
      "FINDVID_WAIT_TIMEOUT_MS",
    ),
    pollIntervalMs: parsePositiveInt(
      env.FINDVID_POLL_INTERVAL_MS?.trim(),
      1_500,
      "FINDVID_POLL_INTERVAL_MS",
    ),
    preferredVoiceover,
    preferredQualities,
  };
}

export function readOptionalEnv(name: string): string | undefined {
  return readEnv(name);
}