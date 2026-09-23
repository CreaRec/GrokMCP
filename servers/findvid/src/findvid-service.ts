import type { FindvidConfig } from "./config.js";
import { FindvidError } from "./errors.js";
import {
  findQualityMenuButton,
  findSearchResultRecoveryButton,
  findVoiceoverMenuButton,
  formatBytes,
  formatKeyboardDebug,
  hasCallbackData,
  listChoiceButtons,
  looksLikeBotHomeKeyboard,
  looksLikeChromeMenu,
  looksLikeGuideMedia,
  looksLikeMovieCardButtons,
  looksLikeNavOnlyKeyboard,
  looksLikeQualityButtons,
  looksLikeVoiceoverButtons,
  messageMatchesSelectedFilm,
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
import { formatFloodStats } from "./flood.js";

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
        "user picks voiceover only → list_qualities → agent auto-picks max quality " +
        "(1080p/…) → confirm_and_forward immediately (no second user OK). " +
        "After voiceover, qualities arrive on a NEW message — not the film file yet. " +
        "Озвучка/Качество are chrome menu buttons, not voiceover/quality names. " +
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

    this.telegram.resetFloodStats();

    const selectedMatch = this.resolveSelectedMatch(resultId);
    this.state.selectedResultId = resultId;

    // Nikita: once the *correct* movie card is on screen, never sendMessage /
    // SendInlineBotResult — only click inline callbacks. Wrong-film cards and
    // collapsed Вернуться/Скрыть keyboards must not be reused; bootstrap this resultId.
    let reply = await this.findExistingMovieCardMessage(selectedMatch);
    if (!reply) {
      const sent = await this.telegram.sendInlineResult({
        botUsername: this.config.findvidInlineBotUsername,
        queryId: this.state.queryId,
        resultId,
      });

      // Trust the message returned for this resultId; title-match only gates
      // *reuse* of preexisting history cards (wrong-film steal).
      reply =
        sent && this.hasMovieCardChrome(sent)
          ? sent
          : await this.waitForMovieCardMessage({
              afterMessageId: Math.max(0, (sent?.id ?? this.state.lastBotMessageId ?? 0) - 1),
              resultId,
              match: selectedMatch,
              allowResend: true,
            });
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

    if (looksLikeChromeMenu(reply.buttons) || looksLikeBotHomeKeyboard(reply.buttons)) {
      throw new FindvidError(
        "Findvid did not show a voiceover list after selecting the match. " +
          "Still on chrome/bot-home keyboard — VIP/UI changes may have renamed Озвучка. " +
          formatKeyboardDebug(reply.buttons, { messageId: reply.id }),
      );
    }

    if (!looksLikeVoiceoverButtons(reply.buttons)) {
      throw new FindvidError(
        "Findvid buttons after match select are neither voiceovers nor qualities. " +
          formatKeyboardDebug(reply.buttons, { messageId: reply.id }),
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
          { requireVoiceoverOrQuality: true },
        );
        buttons = opened.buttons;
        this.state.selectedVoiceover = undefined;
      } else {
        const opened = await this.clickAndWaitForButtons(
          findQualityMenuButton(buttons),
          "Качество chrome menu",
          { requireQuality: true },
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
      // Nikita: clicking an озвучка yields a NEW message with quality buttons.
      // Intermediate/preview media on the movie card is NOT the downloadable film —
      // never treat isFinalVideoMessage here as done (that returned empty qualities).
      const reply = await this.clickVoiceoverAndWaitForQualityStep(button);
      this.state.selectedVoiceover = button.text;
      buttons = reply.buttons;
    }

    if (looksLikeChromeMenu(buttons)) {
      const opened = await this.clickAndWaitForButtons(
        findQualityMenuButton(buttons),
        "Качество chrome menu",
        { requireQuality: true },
      );
      buttons = opened.buttons;
    }

    if (!looksLikeQualityButtons(buttons)) {
      throw new FindvidError(
        "Expected quality buttons (1080p/720p/…) on a new message after voiceover selection. " +
          "Post-voiceover preview media is not the film — refusing empty qualities. " +
          "Findvid UI may have changed, or the quality step did not arrive in time. " +
          formatKeyboardDebug(buttons, { messageId: this.state.lastBotMessageId }),
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
          { requireVoiceoverOrQuality: true },
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
        // Film arrives only AFTER quality click. Post-voiceover media is preview.
        const reply = await this.clickVoiceoverAndWaitForQualityStep(button);
        this.state.selectedVoiceover = button.text;
        this.state.stage = "qualities";
        if (looksLikeQualityButtons(reply.buttons)) {
          this.state.qualities = summarizeButtons(reply.buttons);
        }
      }
    }

    // Quality step — final film is the message after quality click only.
    if (this.state.stage !== "video_ready" && this.state.stage !== "forwarded") {
      let buttons = await this.latestButtons();

      if (looksLikeChromeMenu(buttons)) {
        const opened = await this.clickAndWaitForButtons(
          findQualityMenuButton(buttons),
          "Качество chrome menu",
          { requireQuality: true },
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
        throw new FindvidError(
          "Expected quality buttons (1080p/720p/…) after voiceover before the film file. " +
            "Refusing to forward a post-voiceover preview. " +
            formatKeyboardDebug(buttons, { messageId: this.state.lastBotMessageId }),
        );
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

  /** Resolve RankedMatch metadata for a resultId (best or alternatives). */
  private resolveSelectedMatch(resultId?: string): RankedMatch | undefined {
    const id = resultId ?? this.state.selectedResultId;
    if (!id) return this.state.best;
    if (this.state.best?.resultId === id) return this.state.best;
    return this.state.alternatives?.find((a) => a.resultId === id);
  }

  private hasMovieCardChrome(msg: ChatMessageSnapshot): boolean {
    if (!looksLikeMovieCardButtons(msg.buttons)) return false;
    if (looksLikeNavOnlyKeyboard(msg.buttons)) return false;
    return (
      msg.hasInlineMarkup ||
      looksLikeChromeMenu(msg.buttons) ||
      looksLikeVoiceoverButtons(msg.buttons) ||
      looksLikeQualityButtons(msg.buttons)
    );
  }

  private isUsableMovieCardMessage(
    msg: ChatMessageSnapshot,
    match?: RankedMatch,
  ): boolean {
    if (!this.hasMovieCardChrome(msg)) return false;
    // Without title metadata we cannot safely reuse a preexisting card.
    if (!match) return false;
    return messageMatchesSelectedFilm(msg, match);
  }

  /**
   * Prefer an already-visible movie card for the *selected* film
   * (chrome / озвучки / qualities). Wrong-film cards and nav-only collapsed
   * keyboards are ignored so callers may SendInlineBotResult for this resultId.
   * When a matching card is present, callers must not sendMessage / SendInlineBotResult.
   */
  private async findExistingMovieCardMessage(
    match?: RankedMatch,
  ): Promise<ChatMessageSnapshot | null> {
    const recent = await this.telegram.getRecentMessages(15);
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const msg = recent[i];
      if (this.isUsableMovieCardMessage(msg, match)) return msg;
    }
    return null;
  }

  /**
   * Wait for movie-card chrome (Озвучка/Качество) or nested voiceover/quality lists
   * that belong to the selected film. Ignores sticky bot-home and other films’ cards.
   * Recovery: click «Результат поиска» only when no matching card exists yet, then
   * optionally re-send the inline result once. Never send after a matching card is visible.
   * Flood-aware: does not burn waitTimeout during FLOOD_WAIT backoff on GetHistory.
   */
  private async waitForMovieCardMessage(options: {
    afterMessageId: number;
    resultId: string;
    match?: RankedMatch;
    allowResend: boolean;
  }): Promise<ChatMessageSnapshot> {
    let deadline = Date.now() + this.config.waitTimeoutMs;
    const startedAt = Date.now();
    let afterId = options.afterMessageId;
    let triedRecoveryClick = false;
    let triedResend = false;
    const match = options.match ?? this.resolveSelectedMatch(options.resultId);

    const acceptsCard = (msg: ChatMessageSnapshot, requireAfterId: boolean): boolean => {
      if (requireAfterId && msg.id < afterId) return false;
      if (match) return this.isUsableMovieCardMessage(msg, match);
      // No title metadata for this resultId: only accept chrome that arrived after our send.
      return msg.id >= afterId && this.hasMovieCardChrome(msg);
    };

    while (Date.now() < deadline) {
      const recent = await this.telegram.getRecentMessages(15);
      deadline += this.telegram.consumeFloodSleepMs();

      for (let i = recent.length - 1; i >= 0; i -= 1) {
        const msg = recent[i];
        if (acceptsCard(msg, true)) {
          this.state.lastBotMessageId = msg.id;
          return msg;
        }
      }

      // Matching card anywhere in recent history (even older than afterId) is enough —
      // do not SendInlineBotResult again for that film. Without match metadata, skip
      // this path so we do not steal a neighbor card that predates the send.
      if (match) {
        const cardAnywhere = [...recent]
          .reverse()
          .find((m) => this.isUsableMovieCardMessage(m, match));
        if (cardAnywhere) {
          this.state.lastBotMessageId = cardAnywhere.id;
          return cardAnywhere;
        }
      }

      // Collapsed Вернуться/Скрыть (own film or neighbor) is not usable and must not
      // block waiting / resend for this resultId.

      const latestWithButtons = [...recent].reverse().find((m) => m.buttons.length > 0);
      if (
        latestWithButtons &&
        looksLikeBotHomeKeyboard(latestWithButtons.buttons) &&
        !triedRecoveryClick
      ) {
        const recovery = findSearchResultRecoveryButton(latestWithButtons.buttons);
        if (recovery) {
          triedRecoveryClick = true;
          this.state.lastBotMessageId = latestWithButtons.id;
          await this.telegram.clickButton(recovery);
          afterId = latestWithButtons.id;
          await sleep(this.telegram.nextHistoryPollDelayMs(this.config.pollIntervalMs));
          continue;
        }
      }

      const elapsed = Date.now() - startedAt;
      if (
        options.allowResend &&
        !triedResend &&
        this.state.queryId &&
        elapsed >= Math.floor(this.config.waitTimeoutMs / 3)
      ) {
        // Re-check: never SendInlineBotResult if a *matching* card appeared mid-wait.
        const cardNow = await this.findExistingMovieCardMessage(match);
        if (cardNow) {
          this.state.lastBotMessageId = cardNow.id;
          return cardNow;
        }
        triedResend = true;
        const resent = await this.telegram.sendInlineResult({
          botUsername: this.config.findvidInlineBotUsername,
          queryId: this.state.queryId,
          resultId: options.resultId,
        });
        if (
          resent &&
          this.hasMovieCardChrome(resent) &&
          (!match || messageMatchesSelectedFilm(resent, match))
        ) {
          this.state.lastBotMessageId = resent.id;
          return resent;
        }
        afterId = Math.max(afterId, resent?.id ?? afterId);
      }

      await sleep(this.telegram.nextHistoryPollDelayMs(this.config.pollIntervalMs));
    }

    const flood = formatFloodStats(this.telegram.getFloodStats());
    const titleHint = match?.rawTitle || match?.title || options.resultId;
    throw new FindvidError(
      `Timed out waiting for Findvid movie card for "${titleHint}" ` +
        "(Озвучка/Качество or озвучки list). Other films’ cards and collapsed " +
        "Вернуться/Скрыть keyboards are ignored — re-select the match or search again. " +
        `${flood}. VIP/rate-limits or UI changes may block automation.`,
    );
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
    // Ensure callback metadata is present (never sendMessage Озвучка as chat text).
    if (
      menuButton &&
      (menuButton.kind !== "inline" ||
        !hasCallbackData(menuButton) ||
        menuButton.messageId === undefined)
    ) {
      throw new FindvidError(
        `Cannot click ${which === "voiceover" ? "Озвучка" : "Качество"}: missing inline callback data. ` +
          formatKeyboardDebug(reply.buttons, { messageId: reply.id }),
      );
    }
    return this.clickAndWaitForButtons(
      menuButton,
      which === "voiceover" ? "Озвучка chrome menu" : "Качество chrome menu",
      {
        requireVoiceoverOrQuality: which === "voiceover",
        requireQuality: which === "quality",
      },
    );
  }

  private buttonFingerprint(buttons: ButtonLike[]): string {
    return buttons
      .map((b) => `${b.kind}:${hasCallbackData(b) ? "d" : "-"}:${b.text}`)
      .join("\n");
  }

  /**
   * Click a button and wait for either a newer message or an in-place keyboard edit
   * (Findvid VIP often edits the same message id when opening Озвучка/Качество).
   * When requiring voiceover/quality lists, accept them on **any** recent bot message
   * whose keyboard is new or changed since the click — not only the chrome host.
   * Nav-only keyboards (Вернуться/Скрыть) after chrome open fail fast instead of
   * burning the full waitTimeout.
   */
  private async clickAndWaitForButtons(
    button: ButtonLike | null,
    label: string,
    options: {
      acceptVideo?: boolean;
      requireVoiceoverOrQuality?: boolean;
      requireQuality?: boolean;
      /**
       * After selecting a studio озвучка: wait for Nx p buttons or chrome with
       * Качество. Never accept film/preview media as completion of this step.
       */
      requireQualityStep?: boolean;
    } = {},
  ): Promise<ChatMessageSnapshot> {
    if (!button) {
      throw new FindvidError(`Could not find ${label} button on Findvid message`);
    }
    // Prefer the message we just received when lastBotMessageId is not set yet.
    const recentBefore = await this.telegram.getRecentMessages(8);
    const host =
      recentBefore.find((m) => m.id === (button.messageId ?? this.state.lastBotMessageId)) ??
      recentBefore.find((m) => m.id === this.state.lastBotMessageId) ??
      [...recentBefore]
        .reverse()
        .find((m) =>
          m.buttons.some(
            (b) =>
              b.text === button.text ||
              (hasCallbackData(b) &&
                hasCallbackData(button) &&
                b.dataBytes!.equals(button.dataBytes!)),
          ),
        ) ??
      recentBefore[recentBefore.length - 1];
    const beforeId = button.messageId ?? host?.id ?? this.state.lastBotMessageId ?? 0;
    const beforeFingerprints = new Map<number, string>();
    for (const m of recentBefore) {
      beforeFingerprints.set(m.id, this.buttonFingerprint(m.buttons));
    }
    if (host && !beforeFingerprints.has(host.id)) {
      beforeFingerprints.set(host.id, this.buttonFingerprint(host.buttons));
    }

    // Stamp messageId so clickButton can GetBotCallbackAnswer without sendMessage fallback.
    const clickTarget: ButtonLike = {
      ...button,
      messageId: button.messageId ?? beforeId,
      kind: hasCallbackData(button) ? "inline" : button.kind,
      dataBytes: button.dataBytes ? Buffer.from(button.dataBytes) : undefined,
    };
    await this.telegram.clickButton(clickTarget);

    const needsList = Boolean(
      options.requireVoiceoverOrQuality ||
        options.requireQuality ||
        options.requireQualityStep,
    );
    /** Grace before treating Вернуться/Скрыть-only as a hard dead-end. */
    const navOnlyFailAfterMs = Math.min(
      8_000,
      Math.max(2_500, this.config.pollIntervalMs * 3),
    );
    let navOnlySinceMs: number | undefined;
    let navOnlyWitness: ChatMessageSnapshot | undefined;

    let deadlineMs = Date.now() + this.config.waitTimeoutMs;
    while (Date.now() < deadlineMs) {
      const recent = await this.telegram.getRecentMessages(15);
      deadlineMs += this.telegram.consumeFloodSleepMs();

      const listHit = needsList
        ? this.findRequiredListMessage(recent, beforeFingerprints, beforeId, options)
        : undefined;
      if (listHit) {
        this.state.lastBotMessageId = listHit.id;
        return listHit;
      }

      for (let i = recent.length - 1; i >= 0; i -= 1) {
        const msg = recent[i];
        // acceptVideo is only for post-quality film waits — never after voiceover.
        if (
          options.acceptVideo &&
          !options.requireQualityStep &&
          isFinalVideoMessage(msg) &&
          !looksLikeGuideMedia(msg)
        ) {
          if (msg.id > beforeId) {
            this.state.lastBotMessageId = msg.id;
            return msg;
          }
        }
        if (needsList) continue;
        if (msg.buttons.length === 0) continue;
        if (looksLikeBotHomeKeyboard(msg.buttons)) continue;

        if (this.messageKeyboardChangedSince(msg, beforeFingerprints, beforeId)) {
          this.state.lastBotMessageId = msg.id;
          return msg;
        }
      }

      if (needsList) {
        const navOnly = this.findNavOnlyAfterClick(recent, beforeFingerprints, beforeId);
        if (navOnly) {
          if (navOnlySinceMs === undefined) {
            navOnlySinceMs = Date.now();
            navOnlyWitness = navOnly;
          } else if (Date.now() - navOnlySinceMs >= navOnlyFailAfterMs) {
            throw new FindvidError(
              `Findvid keyboard after clicking ${label} is only navigation ` +
                `(Вернуться/Скрыть) with no озвучки/qualities. ` +
                formatKeyboardDebug(navOnly.buttons, { messageId: navOnly.id }) +
                `. ${formatFloodStats(this.telegram.getFloodStats())}. ` +
                "Empty/collapsed submenu or UI change — retry or pick another match.",
            );
          }
        } else {
          navOnlySinceMs = undefined;
          navOnlyWitness = undefined;
        }
      }

      await sleep(this.telegram.nextHistoryPollDelayMs(this.config.pollIntervalMs));
    }

    const latest = this.pickTimeoutDumpMessage(
      await this.telegram.getRecentMessages(15),
      beforeId,
      navOnlyWitness,
    );
    throw new FindvidError(
      `Timed out waiting for Findvid keyboard update after clicking ${label}. ` +
        (latest
          ? formatKeyboardDebug(latest.buttons, { messageId: latest.id })
          : `no message after msg#${beforeId}`) +
        `. ${formatFloodStats(this.telegram.getFloodStats())}. ` +
        (options.requireQualityStep
          ? "Expected a NEW message with quality buttons after voiceover — not film preview. "
          : "") +
        "VIP/rate-limits or UI changes may block automation.",
    );
  }

  /** True when this message is new or its keyboard changed vs the pre-click snapshot. */
  private messageKeyboardChangedSince(
    msg: ChatMessageSnapshot,
    beforeFingerprints: Map<number, string>,
    beforeId: number,
  ): boolean {
    if (msg.id > beforeId && !beforeFingerprints.has(msg.id)) return true;
    const prev = beforeFingerprints.get(msg.id);
    if (prev === undefined) return msg.id >= beforeId;
    return this.buttonFingerprint(msg.buttons) !== prev;
  }

  /**
   * After Озвучка/Качество, accept studios/qualities on any recent bot message whose
   * keyboard is new or edited — including a sibling message id, not only chrome.
   */
  private findRequiredListMessage(
    recent: ChatMessageSnapshot[],
    beforeFingerprints: Map<number, string>,
    beforeId: number,
    options: {
      requireVoiceoverOrQuality?: boolean;
      requireQuality?: boolean;
      requireQualityStep?: boolean;
    },
  ): ChatMessageSnapshot | undefined {
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const msg = recent[i];
      if (msg.buttons.length === 0) continue;
      if (looksLikeBotHomeKeyboard(msg.buttons)) continue;
      if (!this.messageKeyboardChangedSince(msg, beforeFingerprints, beforeId)) continue;

      if (options.requireQualityStep) {
        // Prefer a *new* message with quality buttons (Nikita live flow).
        if (looksLikeQualityButtons(msg.buttons)) return msg;
        // Some titles briefly return chrome; caller opens Качество next.
        if (looksLikeChromeMenu(msg.buttons) && findQualityMenuButton(msg.buttons)) {
          return msg;
        }
        continue;
      }
      if (options.requireQuality) {
        if (looksLikeQualityButtons(msg.buttons)) return msg;
        continue;
      }
      if (
        looksLikeVoiceoverButtons(msg.buttons) ||
        looksLikeQualityButtons(msg.buttons)
      ) {
        return msg;
      }
    }
    return undefined;
  }

  private findNavOnlyAfterClick(
    recent: ChatMessageSnapshot[],
    beforeFingerprints: Map<number, string>,
    beforeId: number,
  ): ChatMessageSnapshot | undefined {
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const msg = recent[i];
      if (msg.buttons.length === 0) continue;
      if (!this.messageKeyboardChangedSince(msg, beforeFingerprints, beforeId)) continue;
      if (looksLikeNavOnlyKeyboard(msg.buttons)) return msg;
    }
    return undefined;
  }

  private pickTimeoutDumpMessage(
    recent: ChatMessageSnapshot[],
    beforeId: number,
    navOnlyWitness?: ChatMessageSnapshot,
  ): ChatMessageSnapshot | undefined {
    if (navOnlyWitness) return navOnlyWitness;
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const msg = recent[i];
      if (msg.id >= beforeId && msg.buttons.length > 0) return msg;
    }
    return recent.find((m) => m.id >= beforeId);
  }

  /**
   * Click a studio озвучка and wait for the quality step (Nx p list or chrome
   * with Качество). Ignores intermediate/preview media — film comes only after
   * quality click.
   */
  private async clickVoiceoverAndWaitForQualityStep(
    button: ButtonLike,
  ): Promise<ChatMessageSnapshot> {
    return this.clickAndWaitForButtons(button, button.text, {
      requireQualityStep: true,
    });
  }

  private async latestButtons(): Promise<ButtonLike[]> {
    const recent = await this.telegram.getRecentMessages(15);

    // Prefer the message we already selected for this film (avoid neighbor cards).
    if (this.state.lastBotMessageId) {
      const pinned = recent.find((m) => m.id === this.state.lastBotMessageId);
      if (
        pinned &&
        pinned.buttons.length > 0 &&
        !looksLikeBotHomeKeyboard(pinned.buttons) &&
        !looksLikeNavOnlyKeyboard(pinned.buttons)
      ) {
        return pinned.buttons;
      }
    }

    const match = this.resolveSelectedMatch();
    if (match) {
      for (let i = recent.length - 1; i >= 0; i -= 1) {
        const msg = recent[i];
        if (!this.isUsableMovieCardMessage(msg, match)) continue;
        this.state.lastBotMessageId = msg.id;
        return msg.buttons;
      }
    }

    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const msg = recent[i];
      if (msg.buttons.length === 0) continue;
      if (looksLikeBotHomeKeyboard(msg.buttons)) continue;
      if (looksLikeNavOnlyKeyboard(msg.buttons)) continue;
      this.state.lastBotMessageId = msg.id;
      return msg.buttons;
    }
    // Fall back to any buttons if nothing else is available.
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
