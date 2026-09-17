import { describe, expect, it, vi } from "vitest";
import type { FindvidConfig } from "./config.js";
import { FindvidService } from "./findvid-service.js";
import type { ButtonLike } from "./parse.js";
import type { ChatMessageSnapshot, InlineSearchResponse, TelegramPort } from "./telegram-port.js";
import { isFinalVideoMessage } from "./telegram-port.js";

function config(overrides: Partial<FindvidConfig> = {}): FindvidConfig {
  return {
    apiId: 1,
    apiHash: "hash",
    session: "session",
    findvidBotUsername: "fvidBot",
    findvidInlineBotUsername: "fvidBot",
    downloaderBotUsername: "CreaDownloader",
    waitTimeoutMs: 5_000,
    pollIntervalMs: 1,
    preferredVoiceover: "Дублированный",
    preferredQualities: ["1080p", "720p"],
    ...overrides,
  };
}

function msg(partial: Partial<ChatMessageSnapshot> & { id: number }): ChatMessageSnapshot {
  return {
    date: 1,
    text: "",
    buttons: [],
    hasVideo: false,
    hasDocument: false,
    raw: {},
    ...partial,
  };
}

class FakeTelegram implements TelegramPort {
  connected = false;
  forwarded: Array<{ username: string; messageId: number }> = [];
  clicks: ButtonLike[] = [];
  history: ChatMessageSnapshot[] = [];
  inline: InlineSearchResponse = { queryId: "qid", results: [] };
  afterSend: ChatMessageSnapshot | null = null;

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async inlineSearch(): Promise<InlineSearchResponse> {
    return this.inline;
  }
  async sendInlineResult(): Promise<ChatMessageSnapshot | null> {
    if (this.afterSend) this.history.push(this.afterSend);
    return this.afterSend;
  }
  async clickButton(button: ButtonLike): Promise<void> {
    this.clicks.push(button);
  }
  async getRecentMessages(): Promise<ChatMessageSnapshot[]> {
    return [...this.history].sort((a, b) => a.id - b.id);
  }
  async waitForMessage(
    predicate: (m: ChatMessageSnapshot) => boolean,
    options: { afterMessageId?: number },
  ): Promise<ChatMessageSnapshot> {
    const found = this.history.find(
      (m) => m.id > (options.afterMessageId ?? 0) && predicate(m),
    );
    if (!found) throw new Error("waitForMessage: nothing matched in fake history");
    return found;
  }
  async forwardMessageTo(username: string, messageId: number) {
    this.forwarded.push({ username, messageId });
    return { forwardedMessageId: 9000 + messageId };
  }
}

describe("isFinalVideoMessage", () => {
  it("accepts large video documents", () => {
    expect(
      isFinalVideoMessage(
        msg({
          id: 1,
          hasDocument: true,
          hasVideo: true,
          fileSize: 2.9 * 1024 ** 3,
          durationSeconds: 2 * 3600,
          fileName: "movie.mkv",
        }),
      ),
    ).toBe(true);
  });
});

describe("FindvidService flow", () => {
  it("search ranks best match and confirm_and_forward forwards video", async () => {
    const telegram = new FakeTelegram();
    telegram.inline = {
      queryId: "1001",
      results: [
        {
          id: "r-watch",
          title: "Девушка с татуировкой дракона (2011)",
          description: "Смотреть · КП: 7.8 · IMDb: 7.8",
          thumbUrl: "https://example.com/poster.jpg",
        },
        {
          id: "r-trailer",
          title: "Девушка с татуировкой дракона (2011)",
          description: "Трейлер",
        },
      ],
    };

    const voiceoverMsg = msg({
      id: 10,
      text: "Выберите озвучку",
      buttons: [
        { text: "HDrezka", kind: "reply" },
        { text: "Дублированный", kind: "reply" },
        { text: "LostFilm", kind: "reply" },
        { text: "Вернуться", kind: "reply" },
      ],
    });
    const qualityMsg = msg({
      id: 11,
      text: "Выберите качество",
      buttons: [
        { text: "720p", kind: "inline", data: "720" },
        { text: "1080p", kind: "inline", data: "1080" },
      ],
    });
    const videoMsg = msg({
      id: 12,
      text: "@fvid_try_bot • AnyMov.TV",
      hasDocument: true,
      hasVideo: true,
      fileName: "dragon.mkv",
      fileSize: Math.round(2.9 * 1024 ** 3),
      durationSeconds: 9487,
    });

    telegram.afterSend = voiceoverMsg;
    telegram.history = [voiceoverMsg];

    const originalClick = telegram.clickButton.bind(telegram);
    telegram.clickButton = async (button) => {
      await originalClick(button);
      if (button.text === "Дублированный") {
        telegram.history.push(qualityMsg);
      }
      if (button.text === "1080p") {
        telegram.history.push(videoMsg);
      }
    };

    const service = new FindvidService(config(), telegram);
    const searched = await service.search("Девушка с татуировкой дракона");
    expect(searched.best.resultId).toBe("r-watch");
    expect(searched.best.year).toBe(2011);
    expect(searched.best.thumbUrl).toBe("https://example.com/poster.jpg");

    const result = await service.confirmAndForward();
    expect(result.selected.voiceover).toBe("Дублированный");
    expect(result.selected.quality).toBe("1080p");
    expect(result.video?.fileSizeLabel).toBe("2.9 GB");
    expect(result.forwardedTo).toBe("CreaDownloader");
    expect(telegram.forwarded).toEqual([{ username: "CreaDownloader", messageId: 12 }]);
  });

  it("list_voiceovers returns озвучки after selecting match", async () => {
    const telegram = new FakeTelegram();
    telegram.inline = {
      queryId: "1",
      results: [{ id: "r1", title: "Inception (2010)", description: "Смотреть" }],
    };
    telegram.afterSend = msg({
      id: 5,
      buttons: [
        { text: "Дублированный", kind: "reply" },
        { text: "HDrezka", kind: "reply" },
      ],
    });
    telegram.history = [telegram.afterSend];

    const service = new FindvidService(config(), telegram);
    await service.search("Inception");
    const voiceovers = await service.listVoiceovers();
    expect(voiceovers.voiceovers.map((v) => v.text)).toEqual([
      "Дублированный",
      "HDrezka",
    ]);
  });
});

describe("telemetry classify smoke", () => {
  it("imports without otel endpoint", async () => {
    vi.resetModules();
    const { classifyError } = await import("./telemetry.js");
    expect(classifyError(new Error("TELEGRAM_SESSION is required"))).toBe("validation");
    expect(classifyError(new Error("Findvid VIP rate limit"))).toBe("findvid");
  });
});
