import type { FindvidConfig } from "./config.js";
import { FindvidError } from "./errors.js";
import {
  findQualityMenuButton,
  findVoiceoverMenuButton,
  formatBytes,
  listChoiceButtons,
  looksLikeChromeMenu,
  looksLikeGuideMedia,
  looksLikeQualityButtons,
  looksLikeVoiceoverButtons,
  pickQualityButton,
  pickVoiceoverButton,
  rankInlineResults,
  type ButtonLike,
  type RankedMatch,
} from "./parse.js";
import {
  isFinalVideoMessage,
  type ChatMessageSnapshot,
  type TelegramPort,
} from "./telegram-port.js";

export type FlowStage =
  | "idle"
  | "searched"
  | "match_selected"
  | "voiceovers"
  | "qualities"
  | "video_ready"
  | "forwarded";

export interface FindvidSessionState {
  stage: FlowStage;
  query?: string;
  queryId?: string;
  selectedResultId?: string;
  best?: RankedMatch;
  alternatives?: RankedMatch[];
  voiceovers?: Array<{ text: string; kind: string }>;
  qualities?: Array<{ text: string; kind: string }>;
  selectedVoiceover?: string;
  selectedQuality?: string;
  lastBotMessageId?: number;
  videoMessageId?: number;
  videoSummary?: {
    messageId: number;
    fileName?: string;
    fileSize?: number;
    fileSizeLabel?: string;
    durationSeconds?: number;
    captionPreview?: string;
  };
  forwardedTo?: string;
  forwardedMessageId?: number;
}

function summarizeButtons(buttons: ButtonLike[]): Array<{ text: string; kind: string }> {
  return listChoiceButtons(buttons).map((b) => ({ text: b.text, kind: b.kind }));
}

export class FindvidService {
  private state: FindvidSessionState = { stage: "idle" };
  private connected = false;

  constructor(
    private readonly config: FindvidConfig,
    private readonly telegram: TelegramPort,
  ) {}

  getState(): FindvidSessionState {
    return { ...this.state };
  }

  async ensureConnected(): Promise<void> {
    if (this.connected) return;
    await this.telegram.connect();
    this.connected = true;
  }

  async search(query: string): Promise<{
    best: RankedMatch;
    alternatives: RankedMatch[];
    queryId: string;
    note: string;
  }> {
    await this.ensureConnected();
    const trimmed = query.trim();
    if (!trimmed) {
      throw new FindvidError("query must be a non-empty string");
    }

    const bot = this.config.findvidInlineBotUsername;
    const { queryId, results } = await this.telegram.inlineSearch(bot, trimmed);
    if (results.length === 0) {
      throw new FindvidError(
        `No Findvid inline results for "${trimmed}" via @${bot}. Check VIP access / bot username.`,
      );
    }

    const { best, alternatives } = rankInlineResults(trimmed, results);
    if (!best) {
      throw new FindvidError(`Could not rank Findvid results for "${trimmed}"`);
    }

    this.state = {
      stage: "searched",
      query: trimmed,
      queryId,
      selectedResultId: best.resultId,
      best,
      alternatives,
    };

    return {
      best,
      alternatives,
      queryId,
      note:
        "Show best match to the user. Preferred agent flow: list_voiceovers (real озвучки) → " +
        "user picks → list_qualities → user picks → confirm_and_forward. " +
        "Озвучка/Качество are chrome menu buttons, not voiceover/quality names. " +
        "Or call confirm_and_forward with optional overrides. " +
        "Findvid VIP / rate-limits / UI changes can break button automation.",
    };
  }

  async listVoiceovers(options: { resultId?: string } = {}): Promise<{
    voiceovers: Array<{ text: string; kind: string }>;
    selectedResultId: string;
    best?: RankedMatch;
  }> {
    await this.ensureConnected();
    if (!this.state.queryId) {
      throw new FindvidError("No active search. Call search first.");
    }

    const resultId = options.resultId ?? this.state.selectedResultId ?? this.state.best?.resultId;
    if (!resultId) {
      throw new FindvidError("No result selected. Pass resultId or run search again.");
    }

    const sent = await this.telegram.sendInlineResult({
      botUsername: this.config.findvidInlineBotUsername,
      queryId: this.state.queryId,
      resultId,
    });

    let reply = sent && this.hasAnyButtons(sent) ? sent : null;
    if (!reply) {
      const afterId = sent?.id ?? this.state.lastBotMessageId ?? 0;
      reply = await this.telegram.waitForMessage(
        (msg) => this.hasAnyButtons(msg),
        {
          timeoutMs: this.config.waitTimeoutMs,
          pollIntervalMs: this.config.pollIntervalMs,
          afterMessageId: Math.max(0, afterId - 1),
        },
      );
    }

    this.state.lastBotMessageId = reply.id;
    reply = await this.openChromeSubmenuIfNeeded(reply, "voiceover");

    if (!looksLikeVoiceoverButtons(reply.buttons) && looksLikeQualityButtons(reply.buttons)) {
      // Some titles skip voiceover and jump to quality.
      this.state = {
        ...this.state,
        stage: "qualities",
        selectedResultId: resultId,
        lastBotMessageId: reply.id,
        qualities: summarizeButtons(reply.buttons),
        voiceovers: this.state.voiceovers,
      };
      return {
        voiceovers: [],
        selectedResultId: resultId,
        best: this.state.best,
      };
    }

    if (looksLikeChromeMenu(reply.buttons)) {
      throw new FindvidError(
        "Findvid still shows the chrome menu after opening Озвучка. " +
          "VIP/UI changes may have renamed the voiceover submenu.",
      );
    }

    this.state = {
      ...this.state,
      stage: "voiceovers",
      selectedResultId: resultId,
      lastBotMessageId: reply.id,
      voiceovers: summarizeButtons(reply.buttons),
    };

    return {
      voiceovers: this.state.voiceovers ?? [],
      selectedResultId: resultId,
      best: this.state.best,
    };
  }

  async listQualities(options: { voiceover?: string } = {}): Promise<{
    qualities: Array<{ text: string; kind: string }>;
    selectedVoiceover?: string;
  }> {
    await this.ensureConnected();

    if (this.state.stage === "searched" || this.state.stage === "idle") {
      await this.listVoiceovers();
    }

    let buttons = await this.latestButtons();
    if (looksLikeChromeMenu(buttons)) {
      // Prefer voiceover path when listing qualities with a voiceover preference;
      // otherwise open Качество directly from chrome when already on a selected озвучка.
      if (options.voiceover || !this.state.selectedVoiceover) {
        const opened = await this.clickAndWaitForButtons(
          findVoiceoverMenuButton(buttons),
          "Озвучка chrome menu",
        );
        buttons = opened.buttons;
        this.state.selectedVoiceover = undefined;
      } else {
        const opened = await this.clickAndWaitForButtons(
          findQualityMenuButton(buttons),
          "Качество chrome menu",
        );
        buttons = opened.buttons;
      }
    }

    if (looksLikeVoiceoverButtons(buttons) && !looksLikeQualityButtons(buttons)) {
      const button = pickVoiceoverButton(
        buttons,
        this.config.preferredVoiceover,
        options.voiceover,
      );
      if (!button) {
        throw new FindvidError("No voiceover buttons available to select");
      }
      const reply = await this.clickAndWaitForButtonsOrVideo(button);
      this.state.selectedVoiceover = button.text;
      buttons = reply.buttons;

      if (isFinalVideoMessage(reply) && !looksLikeGuideMedia(reply)) {
        this.rememberVideo(reply);
        return { qualities: [], selectedVoiceover: button.text };
      }
    }

    if (looksLikeChromeMenu(buttons)) {
      const opened = await this.clickAndWaitForButtons(
        findQualityMenuButton(buttons),
        "Качество chrome menu",
      );
      buttons = opened.buttons;
    }

    if (!looksLikeQualityButtons(buttons)) {
      throw new FindvidError(
        "Expected quality buttons (1080p/720p/…) after voiceover selection. " +
          "Got chrome/support labels instead — Findvid UI may have changed.",
      );
    }

    this.state = {
      ...this.state,
      stage: "qualities",
      qualities: summarizeButtons(buttons),
    };

    return {
      qualities: this.state.qualities ?? [],
      selectedVoiceover: this.state.selectedVoiceover,
    };
  }

  async confirmAndForward(options: {
    resultId?: string;
    voiceover?: string;
    quality?: string;
  } = {}): Promise<{
    selected: {
      title?: string;
      year?: number;
      voiceover?: string;
      quality?: string;
    };
    video: FindvidSessionState["videoSummary"];
    forwardedTo: string;
    forwardedMessageId?: number;
    note: string;
  }> {
    await this.ensureConnected();
    if (!this.state.queryId && this.state.stage === "idle") {
      throw new FindvidError("No active search. Call search first, show the user, then confirm.");
    }

    if (options.resultId && options.resultId !== this.state.selectedResultId) {
      this.state.selectedResultId = options.resultId;
    }

    // Ensure we are past match selection (opens chrome → Озвучка when needed).
    if (
      this.state.stage === "searched" ||
      this.state.stage === "idle" ||
      !this.state.lastBotMessageId
    ) {
      await this.listVoiceovers({ resultId: this.state.selectedResultId });
    }

    // Voiceover step (skip if already on quality / video).
    if (this.state.stage === "voiceovers" || this.state.stage === "match_selected") {
      let buttons = await this.latestButtons();
      if (looksLikeChromeMenu(buttons)) {
        const opened = await this.clickAndWaitForButtons(
          findVoiceoverMenuButton(buttons),
          "Озвучка chrome menu",
        );
        buttons = opened.buttons;
        this.state.stage = "voiceovers";
      }

      if (looksLikeVoiceoverButtons(buttons)) {
        const button = pickVoiceoverButton(
          buttons,
          this.config.preferredVoiceover,
          options.voiceover,
        );
        if (!button) {
          throw new FindvidError("Could not pick a voiceover button");
        }
        const reply = await this.clickAndWaitForButtonsOrVideo(button);
        this.state.selectedVoiceover = button.text;
        if (isFinalVideoMessage(reply) && !looksLikeGuideMedia(reply)) {
          this.rememberVideo(reply);
        } else if (looksLikeChromeMenu(reply.buttons)) {
          this.state.stage = "qualities";
          // Stay on chrome; quality step opens Качество.
        } else if (looksLikeQualityButtons(reply.buttons)) {
          this.state.stage = "qualities";
          this.state.qualities = summarizeButtons(reply.buttons);
        } else {
          this.state.stage = "qualities";
          this.state.qualities = summarizeButtons(reply.buttons);
        }
      }
    }

    // Quality step.
    if (this.state.stage !== "video_ready" && this.state.stage !== "forwarded") {
      let buttons = await this.latestButtons();

      if (looksLikeChromeMenu(buttons)) {
        const opened = await this.clickAndWaitForButtons(
          findQualityMenuButton(buttons),
          "Качество chrome menu",
        );
        buttons = opened.buttons;
      }

      if (looksLikeQualityButtons(buttons)) {
        const button = pickQualityButton(
          buttons,
          this.config.preferredQualities,
          options.quality,
        );
        if (!button) {
          throw new FindvidError("Could not pick a quality button");
        }
        const beforeId = this.state.lastBotMessageId ?? 0;
        await this.telegram.clickButton(button);
        const reply = await this.telegram.waitForMessage(
          (msg) => isFinalVideoMessage(msg) && !looksLikeGuideMedia(msg),
          {
            timeoutMs: this.config.waitTimeoutMs,
            pollIntervalMs: this.config.pollIntervalMs,
            afterMessageId: beforeId,
          },
        );
        this.state.selectedQuality = button.text;
        this.rememberVideo(reply);
      } else if (!this.state.videoMessageId) {
        const reply = await this.telegram.waitForMessage(
          (msg) => isFinalVideoMessage(msg) && !looksLikeGuideMedia(msg),
          {
            timeoutMs: this.config.waitTimeoutMs,
            pollIntervalMs: this.config.pollIntervalMs,
            afterMessageId: this.state.lastBotMessageId ?? 0,
          },
        );
        this.rememberVideo(reply);
      }
    }

    if (!this.state.videoMessageId || !this.state.videoSummary) {
      throw new FindvidError(
        "Findvid did not produce a final video/document message to forward. VIP limits or UI changes may apply.",
      );
    }

    if (looksLikeGuideMedia(this.state.videoSummary)) {
      throw new FindvidError(
        "Refusing to forward a tiny guide/howto video " +
          `(${this.state.videoSummary.fileSizeLabel ?? "small file"}). ` +
          "Expected a multi-GB film — likely clicked chrome/support instead of озвучка/качество.",
      );
    }

    const forward = await this.telegram.forwardMessageTo(
      this.config.downloaderBotUsername,
      this.state.videoMessageId,
    );

    this.state.stage = "forwarded";
    this.state.forwardedTo = this.config.downloaderBotUsername;
    this.state.forwardedMessageId = forward.forwardedMessageId;

    return {
      selected: {
        title: this.state.best?.title,
        year: this.state.best?.year,
        voiceover: this.state.selectedVoiceover,
        quality: this.state.selectedQuality,
      },
      video: this.state.videoSummary,
      forwardedTo: this.config.downloaderBotUsername,
      forwardedMessageId: forward.forwardedMessageId,
      note:
        "Message forwarded to the downloader bot (no multi-GB download in this MCP). " +
        "CreaVideoDownloaderBot should pick it up via GramJS.",
    };
  }

  private rememberVideo(msg: ChatMessageSnapshot): void {
    this.state.stage = "video_ready";
    this.state.videoMessageId = msg.id;
    this.state.lastBotMessageId = msg.id;
    this.state.videoSummary = {
      messageId: msg.id,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      fileSizeLabel: formatBytes(msg.fileSize),
      durationSeconds: msg.durationSeconds,
      captionPreview: msg.text ? msg.text.slice(0, 240) : undefined,
    };
  }

  private hasAnyButtons(msg: ChatMessageSnapshot): boolean {
    return msg.buttons.length > 0;
  }

  private async openChromeSubmenuIfNeeded(
    reply: ChatMessageSnapshot,
    which: "voiceover" | "quality",
  ): Promise<ChatMessageSnapshot> {
    if (!looksLikeChromeMenu(reply.buttons)) return reply;
    const menuButton =
      which === "voiceover"
        ? findVoiceoverMenuButton(reply.buttons)
        : findQualityMenuButton(reply.buttons);
    return this.clickAndWaitForButtons(
      menuButton,
      which === "voiceover" ? "Озвучка chrome menu" : "Качество chrome menu",
    );
  }

  private buttonFingerprint(buttons: ButtonLike[]): string {
    return buttons.map((b) => b.text).join("\n");
  }

  /**
   * Click a button and wait for either a newer message or an in-place keyboard edit
   * (Findvid VIP often edits the same message id when opening Озвучка/Качество).
   */
  private async clickAndWaitForButtons(
    button: ButtonLike | null,
    label: string,
    options: { acceptVideo?: boolean } = {},
  ): Promise<ChatMessageSnapshot> {
    if (!button) {
      throw new FindvidError(`Could not find ${label} button on Findvid message`);
    }
    // Prefer the message we just received when lastBotMessageId is not set yet.
    const recentBefore = await this.telegram.getRecentMessages(8);
    const host =
      recentBefore.find((m) => m.id === this.state.lastBotMessageId) ??
      [...recentBefore].reverse().find((m) => m.buttons.some((b) => b.text === button.text)) ??
      recentBefore[recentBefore.length - 1];
    const beforeId = host?.id ?? this.state.lastBotMessageId ?? 0;
    const beforeFingerprint = this.buttonFingerprint(host?.buttons ?? []);
    await this.telegram.clickButton(button);

    const deadline = Date.now() + this.config.waitTimeoutMs;
    while (Date.now() < deadline) {
      const recent = await this.telegram.getRecentMessages(15);
      for (let i = recent.length - 1; i >= 0; i -= 1) {
        const msg = recent[i];
        if (options.acceptVideo && isFinalVideoMessage(msg) && !looksLikeGuideMedia(msg)) {
          if (msg.id >= beforeId) {
            this.state.lastBotMessageId = msg.id;
            return msg;
          }
        }
        if (msg.buttons.length === 0) continue;
        if (msg.id > beforeId) {
          this.state.lastBotMessageId = msg.id;
          return msg;
        }
        if (msg.id === beforeId) {
          const nextFingerprint = this.buttonFingerprint(msg.buttons);
          if (nextFingerprint && nextFingerprint !== beforeFingerprint) {
            this.state.lastBotMessageId = msg.id;
            return msg;
          }
        }
      }
      await sleep(this.config.pollIntervalMs);
    }

    throw new FindvidError(
      `Timed out waiting for Findvid keyboard update after clicking ${label}. ` +
        "VIP/rate-limits or UI changes may block automation.",
    );
  }

  private async clickAndWaitForButtonsOrVideo(
    button: ButtonLike,
  ): Promise<ChatMessageSnapshot> {
    return this.clickAndWaitForButtons(button, button.text, { acceptVideo: true });
  }

  private async latestButtons(): Promise<ButtonLike[]> {
    const recent = await this.telegram.getRecentMessages(15);
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const msg = recent[i];
      if (msg.buttons.length > 0) {
        this.state.lastBotMessageId = msg.id;
        return msg.buttons;
      }
    }
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
