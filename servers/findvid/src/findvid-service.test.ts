import { describe, expect, it, vi } from "vitest";
import type { FindvidConfig } from "./config.js";
import { FindvidService } from "./findvid-service.js";
import type { ButtonLike } from "./parse.js";
import type { ChatMessageSnapshot, InlineSearchResponse, TelegramPort } from "./telegram-port.js";
import { isFinalVideoMessage, resolveClickAction } from "./telegram-port.js";

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
  { text: "🎶 Озвучка", kind: "inline", dataBytes: Buffer.from("vo") },
  { text: "🔮 Качество", kind: "inline", dataBytes: Buffer.from("q") },
  { text: "🔔 Уведомлять", kind: "inline", dataBytes: Buffer.from("n") },
  { text: "⭐ В избранное", kind: "inline", dataBytes: Buffer.from("f") },
  { text: "🔍 Поиск", kind: "inline", dataBytes: Buffer.from("search") },
  { text: "🔼 Свернуть меню", kind: "inline", dataBytes: Buffer.from("collapse") },
];

const voiceoverButtons: ButtonLike[] = [
  { text: "✔️ Back Board Cinema", kind: "inline", dataBytes: Buffer.from("bbc") },
  { text: "✔️ Дублированный", kind: "inline", dataBytes: Buffer.from("dub") },
  { text: "✔️ AlexFilm", kind: "inline", dataBytes: Buffer.from("af") },
  { text: "✔️ [EN] Original", kind: "inline", dataBytes: Buffer.from("en") },
  { text: "🔙 Назад", kind: "inline", dataBytes: Buffer.from("back") },
];

const qualityButtons: ButtonLike[] = [
  { text: "720p", kind: "inline", dataBytes: Buffer.from("720") },
  { text: "1080p", kind: "inline", dataBytes: Buffer.from("1080") },
  { text: "🔙 Назад", kind: "inline", dataBytes: Buffer.from("back") },
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
    // Mirror production resolveClickAction rules.
    const action = resolveClickAction(button);
    if (action.type === "error") {
      throw new Error(action.reason);
    }
    if (action.type === "reply_text") {
      this.textSends.push(action.text);
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
  getFloodStats() {
    return {
      getHistoryCalls: 0,
      floodWaitEvents: 0,
      totalFloodWaitSeconds: 0,
      nextHistoryAllowedAtMs: 0,
    };
  }
  resetFloodStats(): void {}
  nextHistoryPollDelayMs(pollIntervalMs: number): number {
    return pollIntervalMs;
  }
  consumeFloodSleepMs(): number {
    return 0;
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
        { text: "720p", kind: "inline", dataBytes: Buffer.from("720") },
        { text: "1080p", kind: "inline", dataBytes: Buffer.from("1080") },
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
    expect(telegram.clicks[0]?.dataBytes?.equals(Buffer.from("vo"))).toBe(true);
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
    let historyCalls = 0;
    const originalGetRecent = telegram.getRecentMessages.bind(telegram);
    telegram.getRecentMessages = async () => {
      historyCalls += 1;
      return originalGetRecent();
    };
    // After a simulated flood, next poll delay jumps so we do not thrash GetHistory.
    telegram.nextHistoryPollDelayMs = (pollIntervalMs: number) =>
      historyCalls >= 1 ? Math.max(pollIntervalMs, 50) : pollIntervalMs;

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
      // Live post-#70: recovery key sometimes arrives as inline without callback data.
      { text: "🔍 Результат поиска", kind: "inline", messageId: 40 },
    ];
    const homeMsg = msg({ id: 40, text: "Findvid home", buttons: botHome, hasInlineMarkup: false });
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
    expect(telegram.textSends.some((t) => /Результат поиска/i.test(t))).toBe(true);
    expect(telegram.clicks.some((c) => /озвучк/i.test(c.text))).toBe(true);
    const ozv = telegram.clicks.find((c) => /озвучк/i.test(c.text));
    expect(ozv?.dataBytes).toBeTruthy();
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

  it("list_voiceovers accepts озвучки on a newer message id after Озвучка", async () => {
    const telegram = new FakeTelegram();
    telegram.inline = {
      queryId: "new-msg",
      results: [{ id: "121666", title: "Достать ножи (Knives Out) (2019)", description: "Смотреть" }],
    };

    const chromeMsg = msg({
      id: 961905,
      text: "Достать ножи (Back Board Cinema [1080p])",
      buttons: chromeButtons,
    });
    telegram.afterSend = chromeMsg;
    telegram.history = [chromeMsg];

    // Live hypothesis: chrome collapses to Back/Hide while studios arrive on a new message.
    const navOnly: ButtonLike[] = [
      { text: "⏭ Вернуться", kind: "inline", dataBytes: Buffer.from("x".repeat(33)) },
      { text: "✖️ Скрыть", kind: "inline", dataBytes: Buffer.from("y".repeat(9)) },
    ];
    telegram.onClick = (button) => {
      if (/озвучк/i.test(button.text)) {
        const idx = telegram.history.findIndex((m) => m.id === 961905);
        telegram.history[idx] = msg({
          id: 961905,
          text: chromeMsg.text,
          buttons: navOnly,
        });
        telegram.history.push(
          msg({
            id: 961906,
            text: "Озвучки",
            buttons: voiceoverButtons,
          }),
        );
      }
    };

    const service = new FindvidService(config({ waitTimeoutMs: 2_000, pollIntervalMs: 20 }), telegram);
    await service.search("Knives Out");
    const voiceovers = await service.listVoiceovers({ resultId: "121666" });
    expect(voiceovers.voiceovers.map((v) => v.text)).toEqual([
      "✔️ Back Board Cinema",
      "✔️ Дублированный",
      "✔️ AlexFilm",
      "✔️ [EN] Original",
    ]);
  });

  it("list_voiceovers fails fast when post-Озвучка keyboard is only Вернуться/Скрыть", async () => {
    const telegram = new FakeTelegram();
    telegram.inline = {
      queryId: "nav-only",
      results: [{ id: "1", title: "Film (2019)", description: "Смотреть" }],
    };

    const chromeMsg = msg({ id: 50, text: "Film", buttons: chromeButtons });
    telegram.afterSend = chromeMsg;
    telegram.history = [chromeMsg];

    telegram.onClick = (button) => {
      if (/озвучк/i.test(button.text)) {
        telegram.history[0] = msg({
          id: 50,
          text: "Film",
          buttons: [
            { text: "⏭ Вернуться", kind: "inline", dataBytes: Buffer.from("back") },
            { text: "✖️ Скрыть", kind: "inline", dataBytes: Buffer.from("hide") },
          ],
        });
      }
    };

    const service = new FindvidService(
      config({ waitTimeoutMs: 30_000, pollIntervalMs: 50 }),
      telegram,
    );
    await service.search("Film");
    const started = Date.now();
    await expect(service.listVoiceovers({ resultId: "1" })).rejects.toThrow(
      /only navigation.*(Вернуться\/Скрыть)|Вернуться.*Скрыть/i,
    );
    expect(Date.now() - started).toBeLessThan(12_000);
  });

  it("movie-card wait extends deadline by flood sleep and reports flood stats on timeout", async () => {
    const telegram = new FakeTelegram();
    let pollDelays: number[] = [];
    let floodRemainingMs = 80;
    telegram.consumeFloodSleepMs = () => {
      const ms = floodRemainingMs;
      floodRemainingMs = 0;
      return ms;
    };
    telegram.nextHistoryPollDelayMs = (pollIntervalMs: number) => {
      const delay = Math.max(pollIntervalMs, 40);
      pollDelays.push(delay);
      return delay;
    };
    telegram.getFloodStats = () => ({
      getHistoryCalls: 4,
      floodWaitEvents: 2,
      totalFloodWaitSeconds: 11,
      lastFloodWaitSeconds: 5,
      nextHistoryAllowedAtMs: Date.now() + 1_000,
    });

    const botHome: ButtonLike[] = [
      { text: "🗂 Подборки", kind: "reply" },
      { text: "🌪️ Фильтр", kind: "reply" },
    ];
    telegram.history = [msg({ id: 1, text: "home", buttons: botHome, hasInlineMarkup: false })];
    telegram.inline = {
      queryId: "q",
      results: [{ id: "1", title: "Film (2019)", description: "Смотреть" }],
    };
    telegram.afterSend = telegram.history[0];

    const service = new FindvidService(config({ waitTimeoutMs: 120, pollIntervalMs: 20 }), telegram);
    await service.search("Film");
    await expect(service.listVoiceovers({ resultId: "1" })).rejects.toThrow(
      /getHistory_calls=4.*flood_wait_events=2.*flood_wait_seconds=11.*last_flood_wait_seconds=5/,
    );
    expect(pollDelays.some((d) => d >= 40)).toBe(true);
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
