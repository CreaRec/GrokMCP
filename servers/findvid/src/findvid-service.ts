import type { FindvidConfig } from "./config.js";
import { FindvidError } from "./errors.js";
import {
  formatBytes,
  listChoiceButtons,
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
        "Show best match to the user. On confirmation call confirm_and_forward " +
        "(optional voiceover/quality overrides). Or call list_voiceovers to browse озвучки first. " +
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

    let reply = sent && listChoiceButtons(sent.buttons).length > 0 ? sent : null;
    if (!reply) {
      const afterId = sent?.id ?? this.state.lastBotMessageId ?? 0;
      // Include the sent message itself when afterId equals its id by scanning >= when needed.
      reply = await this.telegram.waitForMessage(
        (msg) => listChoiceButtons(msg.buttons).length > 0,
        {
          timeoutMs: this.config.waitTimeoutMs,
          pollIntervalMs: this.config.pollIntervalMs,
          afterMessageId: Math.max(0, afterId - 1),
        },
      );
    }

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

    let voiceoverButtons = await this.latestChoiceButtons();
    if (!looksLikeQualityButtons(voiceoverButtons) && listChoiceButtons(voiceoverButtons).length > 0) {
      const button = pickVoiceoverButton(
        voiceoverButtons,
        this.config.preferredVoiceover,
        options.voiceover,
      );
      if (!button) {
        throw new FindvidError("No voiceover buttons available to select");
      }
      const beforeId = this.state.lastBotMessageId ?? 0;
      await this.telegram.clickButton(button);
      const reply = await this.telegram.waitForMessage(
        (msg) => listChoiceButtons(msg.buttons).length > 0 || isFinalVideoMessage(msg),
        {
          timeoutMs: this.config.waitTimeoutMs,
          pollIntervalMs: this.config.pollIntervalMs,
          afterMessageId: beforeId,
        },
      );
      this.state.lastBotMessageId = reply.id;
      this.state.selectedVoiceover = button.text;
      voiceoverButtons = reply.buttons;

      if (isFinalVideoMessage(reply)) {
        this.rememberVideo(reply);
        return { qualities: [], selectedVoiceover: button.text };
      }
    }

    this.state = {
      ...this.state,
      stage: "qualities",
      qualities: summarizeButtons(voiceoverButtons),
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

    // Ensure we are past match selection.
    if (
      this.state.stage === "searched" ||
      this.state.stage === "idle" ||
      !this.state.lastBotMessageId
    ) {
      await this.listVoiceovers({ resultId: this.state.selectedResultId });
    }

    // Voiceover step (skip if already on quality / video).
    if (this.state.stage === "voiceovers" || this.state.stage === "match_selected") {
      const buttons = await this.latestChoiceButtons();
      if (looksLikeVoiceoverButtons(buttons)) {
        const button = pickVoiceoverButton(
          buttons,
          this.config.preferredVoiceover,
          options.voiceover,
        );
        if (!button) {
          throw new FindvidError("Could not pick a voiceover button");
        }
        const beforeId = this.state.lastBotMessageId ?? 0;
        await this.telegram.clickButton(button);
        const reply = await this.telegram.waitForMessage(
          (msg) =>
            listChoiceButtons(msg.buttons).length > 0 || isFinalVideoMessage(msg),
          {
            timeoutMs: this.config.waitTimeoutMs,
            pollIntervalMs: this.config.pollIntervalMs,
            afterMessageId: beforeId,
          },
        );
        this.state.lastBotMessageId = reply.id;
        this.state.selectedVoiceover = button.text;
        if (isFinalVideoMessage(reply)) {
          this.rememberVideo(reply);
        } else {
          this.state.stage = "qualities";
          this.state.qualities = summarizeButtons(reply.buttons);
        }
      }
    }

    // Quality step.
    if (this.state.stage !== "video_ready" && this.state.stage !== "forwarded") {
      const buttons = await this.latestChoiceButtons();
      if (looksLikeQualityButtons(buttons) || listChoiceButtons(buttons).length > 0) {
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
          (msg) => isFinalVideoMessage(msg),
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
          (msg) => isFinalVideoMessage(msg),
          {
            timeoutMs: this.config.waitTimeoutMs,
            pollIntervalMs: this.config.pollIntervalMs,
            afterMessageId: this.state.lastBotMessageId ?? 0,
          },
        );
        this.rememberVideo(reply);
      }
    }

    if (!this.state.videoMessageId) {
      throw new FindvidError(
        "Findvid did not produce a final video/document message to forward. VIP limits or UI changes may apply.",
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

  private async latestChoiceButtons(): Promise<ButtonLike[]> {
    const recent = await this.telegram.getRecentMessages(15);
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const msg = recent[i];
      if (listChoiceButtons(msg.buttons).length > 0) {
        this.state.lastBotMessageId = msg.id;
        return msg.buttons;
      }
    }
    return [];
  }
}
