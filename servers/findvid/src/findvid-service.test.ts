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
  const buttons = (partial.buttons ?? []).map((b) => ({
    ...b,
    messageId: b.messageId ?? partial.id,
  }));
  const { buttons: _ignored, ...rest } = partial;
  return {
    date: 1,
    text: "",
    hasVideo: false,
    hasDocument: false,
    raw: {},
    hasInlineMarkup: buttons.some((b) => b.kind === "inline"),
    ...rest,
    buttons,
  };
}

const chromeButtons: ButtonLike[] = [
  { text: "🎶 Озвучка", kind: "inline", data: "vo" },
  { text: "🔮 Качество", kind: "inline", data: "q" },
  { text: "🔔 Уведомлять", kind: "inline", data: "n" },
  { text: "⭐ В избранное", kind: "inline", data: "f" },
  { text: "🔍 Поиск", kind: "inline", data: "search" },
  { text: "🔼 Свернуть меню", kind: "inline", data: "collapse" },
];

const voiceoverButtons: ButtonLike[] = [
  { text: "✔️ Back Board Cinema", kind: "inline", data: "bbc" },
  { text: "✔️ Дублированный", kind: "inline", data: "dub" },
  { text: "✔️ AlexFilm", kind: "inline", data: "af" },
  { text: "✔️ [EN] Original", kind: "inline", data: "en" },
  { text: "🔙 Назад", kind: "inline", data: "back" },
];

const qualityButtons: ButtonLike[] = [
  { text: "720p", kind: "inline", data: "720" },
  { text: "1080p", kind: "inline", data: "1080" },
  { text: "🔙 Назад", kind: "inline", data: "back" },
];

class FakeTelegram implements TelegramPort {
  connected = false;
  forwarded: Array<{ username: string; messageId: number }> = [];
  clicks: ButtonLike[] = [];
  /** True when clickButton would have used sendMessage (reply_text path). */
  textSends: string[] = [];
  history: ChatMessageSnapshot[] = [];
  inline: InlineSearchResponse = { queryId: "qid", results: [] };
  afterSend: ChatMessageSnapshot | null = null;
  /** Optional handler to mutate history after a click (in-place edit or new msg). */
  onClick?: (button: ButtonLike) => void;

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
    if (this.afterSend) {
      const already = this.history.some((m) => m.id === this.afterSend!.id);
      if (!already) this.history.push(this.afterSend);
      else {
        // Refresh buttons on the existing snapshot (simulate send replacing UI).
        const idx = this.history.findIndex((m) => m.id === this.afterSend!.id);
        this.history[idx] = this.afterSend;
      }
    }
    return this.afterSend;
  }
  async clickButton(button: ButtonLike): Promise<void> {
    // Mirror resolveClickAction: inline without data must not become a text send.
    if (button.kind === "inline" || button.data !== undefined) {
      if (!button.data) {
        throw new Error(
          `Inline button "${button.text}" has no callback data. Refusing to sendMessage.`,
        );
      }
      if (button.messageId === undefined) {
        throw new Error(
          `Inline button "${button.text}" missing messageId for GetBotCallbackAnswer.`,
        );
      }
    } else {
      this.textSends.push(button.text);
    }
    this.clicks.push(button);
    this.onClick?.(button);
  }
  async getRecentMessages(): Promise<ChatMessageSnapshot[]> {
    return [...this.history].sort((a, b) => a.id - b.id);
  }
  async waitForMessage(
    predicate: (m: ChatMessageSnapshot) => boolean,
    options: { afterMessageId?: number; timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<ChatMessageSnapshot> {
    const deadline = Date.now() + (options.timeoutMs ?? 50);
    const afterId = options.afterMessageId ?? 0;
    while (Date.now() < deadline) {
      const found = this.history.find((m) => m.id > afterId && predicate(m));
      if (found) return found;
      await new Promise((r) => setTimeout(r, options.pollIntervalMs ?? 1));
    }
    throw new Error(
      `Timed out waiting for Findvid bot reply (afterMessageId=${afterId})`,
    );
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

  it("rejects tiny Видео-гайд clips", () => {
    expect(
      isFinalVideoMessage(
        msg({
          id: 2,
          hasDocument: true,
          hasVideo: true,
          fileSize: Math.round(8.4 * 1024 * 1024),
          durationSeconds: 90,
          fileName: "guide.mp4",
          text: "Видео-гайд",
        }),
      ),
    ).toBe(false);
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

    telegram.onClick = (button) => {
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

  it("list_voiceovers clicks Озвучка chrome before returning real озвучки", async () => {
    const telegram = new FakeTelegram();
    telegram.inline = {
      queryId: "1",
      results: [{ id: "r1", title: "Невидимый гость (2016)", description: "Смотреть" }],
    };

    const chromeMsg = msg({
      id: 5,
      text: "Невидимый гость (Back Board Cinema [1080p])",
      buttons: chromeButtons,
    });
    telegram.afterSend = chromeMsg;
    telegram.history = [chromeMsg];

    // In-place keyboard edit (same message id) — matches live VIP behavior.
    telegram.onClick = (button) => {
      if (/озвучк/i.test(button.text)) {
        const idx = telegram.history.findIndex((m) => m.id === 5);
        telegram.history[idx] = msg({
          id: 5,
          text: chromeMsg.text,
          buttons: voiceoverButtons,
        });
      }
    };

    const service = new FindvidService(config(), telegram);
    await service.search("Невидимый гость");
    const voiceovers = await service.listVoiceovers();

    expect(telegram.clicks.map((c) => c.text)).toEqual(["🎶 Озвучка"]);
    expect(telegram.clicks[0]?.data).toBe("vo");
    expect(telegram.clicks[0]?.messageId).toBe(5);
    expect(telegram.textSends).toEqual([]);
    expect(voiceovers.voiceovers.map((v) => v.text)).toEqual([
      "✔️ Back Board Cinema",
      "✔️ Дублированный",
      "✔️ AlexFilm",
      "✔️ [EN] Original",
    ]);
    expect(voiceovers.voiceovers.some((v) => /озвучк|качеств|уведомл|поиск/i.test(v.text))).toBe(
      false,
    );
  });

  it("list_qualities opens Качество from chrome and ignores guide labels", async () => {
    const telegram = new FakeTelegram();
    telegram.inline = {
      queryId: "2",
      results: [{ id: "r1", title: "Inception (2010)", description: "Смотреть" }],
    };

    const chromeMsg = msg({ id: 20, buttons: chromeButtons });
    telegram.afterSend = chromeMsg;
    telegram.history = [chromeMsg];

    telegram.onClick = (button) => {
      if (/озвучк/i.test(button.text)) {
        const idx = telegram.history.findIndex((m) => m.id === 20);
        telegram.history[idx] = msg({ id: 20, buttons: voiceoverButtons });
      }
      if (/дублирован/i.test(button.text)) {
        telegram.history.push(msg({ id: 21, buttons: chromeButtons }));
      }
      if (/качеств/i.test(button.text)) {
        const idx = telegram.history.findIndex((m) => m.id === 21);
        if (idx >= 0) {
          telegram.history[idx] = msg({ id: 21, buttons: qualityButtons });
        } else {
          telegram.history.push(msg({ id: 21, buttons: qualityButtons }));
        }
      }
    };

    const service = new FindvidService(config(), telegram);
    await service.search("Inception");
    await service.listVoiceovers();
    const qualities = await service.listQualities({ voiceover: "Дублированный" });

    expect(qualities.selectedVoiceover).toMatch(/Дублированный/);
    expect(qualities.qualities.map((q) => q.text)).toEqual(["720p", "1080p"]);
    expect(telegram.clicks.some((c) => /озвучк/i.test(c.text))).toBe(true);
    expect(telegram.clicks.some((c) => /качеств/i.test(c.text))).toBe(true);
  });

  it("confirm_and_forward refuses to forward tiny guide videos", async () => {
    const telegram = new FakeTelegram();
    telegram.inline = {
      queryId: "3",
      results: [{ id: "r1", title: "Inception (2010)", description: "Смотреть" }],
    };

    const chromeMsg = msg({ id: 30, buttons: chromeButtons });
    telegram.afterSend = chromeMsg;
    telegram.history = [chromeMsg];

    const guideMsg = msg({
      id: 99,
      text: "Видео-гайд",
      hasVideo: true,
      hasDocument: true,
      fileName: "guide.mp4",
      fileSize: Math.round(8.4 * 1024 * 1024),
      durationSeconds: 120,
    });

    telegram.onClick = (button) => {
      if (/озвучк/i.test(button.text)) {
        telegram.history[0] = msg({ id: 30, buttons: voiceoverButtons });
      }
      if (/дублирован/i.test(button.text)) {
        telegram.history.push(msg({ id: 31, buttons: qualityButtons }));
      }
      if (button.text === "1080p") {
        telegram.history.push(guideMsg);
      }
    };

    const service = new FindvidService(config({ waitTimeoutMs: 80 }), telegram);
    await service.search("Inception");
    await expect(service.confirmAndForward({ voiceover: "Дублированный", quality: "1080p" }))
      .rejects.toThrow(/guide|гайд|Timed out|multi-GB|quality|video/i);
    expect(telegram.forwarded).toEqual([]);
  }, 10_000);

  it("list_voiceovers skips sticky bot-home keyboard and recovers to movie card", async () => {
    const telegram = new FakeTelegram();
    telegram.inline = {
      queryId: "knives",
      results: [
        { id: "radiohead", title: "Radiohead: Knives Out", description: "Клип" },
        {
          id: "121666",
          title: "Достать ножи (Knives Out) (2019)",
          description: "Смотреть · КП: 8.197",
        },
      ],
    };

    const botHome: ButtonLike[] = [
      { text: "🗂 Подборки", kind: "reply" },
      { text: "🌪️ Фильтр", kind: "reply" },
      { text: "⚙️ Настройки", kind: "reply" },
      { text: "💝 VIP", kind: "reply" },
      { text: "🔍 Результат поиска", kind: "reply" },
    ];
    const homeMsg = msg({ id: 40, text: "Findvid home", buttons: botHome });
    const chromeMsg = msg({
      id: 41,
      text: "Достать ножи (Back Board Cinema [1080p])",
      buttons: chromeButtons,
    });

    // First send returns sticky reply keyboard only (live failure mode).
    telegram.afterSend = homeMsg;
    telegram.history = [homeMsg];

    telegram.onClick = (button) => {
      if (/результат\s*поиска/i.test(button.text)) {
        telegram.history.push(chromeMsg);
      }
      if (/озвучк/i.test(button.text)) {
        const idx = telegram.history.findIndex((m) => m.id === 41);
        if (idx >= 0) {
          telegram.history[idx] = msg({ id: 41, text: chromeMsg.text, buttons: voiceoverButtons });
        }
      }
    };

    const service = new FindvidService(config({ waitTimeoutMs: 500 }), telegram);
    const searched = await service.search("Knives Out");
    expect(searched.best.resultId).toBe("121666");

    const voiceovers = await service.listVoiceovers({ resultId: "121666" });
    expect(telegram.clicks.some((c) => /Результат поиска/i.test(c.text))).toBe(true);
    expect(telegram.clicks.some((c) => /озвучк/i.test(c.text))).toBe(true);
    const ozv = telegram.clicks.find((c) => /озвучк/i.test(c.text));
    expect(ozv?.data).toBeTruthy();
    expect(ozv?.messageId).toBe(41);
    expect(telegram.textSends.every((t) => !/озвучк/i.test(t))).toBe(true);
    expect(voiceovers.voiceovers.map((v) => v.text)).toEqual([
      "✔️ Back Board Cinema",
      "✔️ Дублированный",
      "✔️ AlexFilm",
      "✔️ [EN] Original",
    ]);
    expect(
      voiceovers.voiceovers.some((v) => /подборк|фильтр|настройк|vip|результат/i.test(v.text)),
    ).toBe(false);
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
