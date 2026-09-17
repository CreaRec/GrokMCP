import { describe, expect, it } from "vitest";
import { resolveConfig, type FindvidConfig } from "./config.js";
import { ConfigError } from "./errors.js";

describe("resolveConfig", () => {
  it("loads from env alone", async () => {
    const config = await resolveConfig({
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "hashhash",
      TELEGRAM_SESSION: "session-string",
      FINDVID_BOT_USERNAME: "@fvidBot",
      DOWNLOADER_BOT_USERNAME: "CreaVideoDownloaderBot",
    } as NodeJS.ProcessEnv);

    expect(config.apiId).toBe(12345);
    expect(config.findvidBotUsername).toBe("fvidBot");
    expect(config.findvidInlineBotUsername).toBe("fvidBot");
    expect(config.downloaderBotUsername).toBe("CreaVideoDownloaderBot");
    expect(config.preferredVoiceover).toBe("Дублированный");
    expect(config.preferredQualities[0]).toBe("1080p");
  });

  it("reads session from downloader settings.json shape", async () => {
    const config = await resolveConfig(
      {
        TELEGRAM_SETTINGS_PATH: "/fake/settings.json",
        TELEGRAM_USER_ID: "42",
        FINDVID_INLINE_BOT_USERNAME: "fvid_try_bot",
      } as NodeJS.ProcessEnv,
      {
        loadSettings: async () => ({
          telegram: {
            apiId: 99,
            apiHash: "from-file",
            botUsername: "downloader_bot",
            userSessions: {
              "42": "gramjs-session-42",
              "99": "",
            },
          },
        }),
      },
    );

    expect(config.apiId).toBe(99);
    expect(config.apiHash).toBe("from-file");
    expect(config.session).toBe("gramjs-session-42");
    expect(config.downloaderBotUsername).toBe("downloader_bot");
    expect(config.findvidInlineBotUsername).toBe("fvid_try_bot");
  });

  it("requires TELEGRAM_USER_ID when multiple sessions exist", async () => {
    await expect(
      resolveConfig(
        {
          TELEGRAM_SETTINGS_PATH: "/fake/settings.json",
        } as NodeJS.ProcessEnv,
        {
          loadSettings: async () => ({
            telegram: {
              apiId: 1,
              apiHash: "h",
              botUsername: "bot",
              userSessions: { "1": "a", "2": "b" },
            },
          }),
        },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("fails clearly when downloader bot username is missing", async () => {
    await expect(
      resolveConfig({
        TELEGRAM_API_ID: "1",
        TELEGRAM_API_HASH: "h",
        TELEGRAM_SESSION: "s",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/DOWNLOADER_BOT_USERNAME/);
  });
});

describe("FindvidConfig defaults", () => {
  it("exposes wait timeout defaults", async () => {
    const config: FindvidConfig = await resolveConfig({
      TELEGRAM_API_ID: "1",
      TELEGRAM_API_HASH: "h",
      TELEGRAM_SESSION: "s",
      DOWNLOADER_BOT_USERNAME: "dl",
    } as NodeJS.ProcessEnv);
    expect(config.waitTimeoutMs).toBe(120_000);
    expect(config.pollIntervalMs).toBe(1_500);
  });
});
