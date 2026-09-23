import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import bigInt from "big-integer";
import type { FindvidConfig } from "./config.js";
import { FindvidError, TelegramError, TimeoutError } from "./errors.js";
import {
  copyCallbackBytes,
  extractButtonsFromMarkup,
  hasCallbackData,
  isBotHomeButton,
  looksLikeGuideMedia,
  type ButtonLike,
  type InlineResultLike,
} from "./parse.js";

export interface ChatMessageSnapshot {
  id: number;
  date: number;
  text: string;
  /**
   * Buttons used for movie-card automation.
   * Prefer ReplyInlineMarkup (Озвучка / studios / Nx p). ReplyKeyboardMarkup
   * (Подборки/…) is only used when no inline markup is present on the message.
   */
  buttons: ButtonLike[];
  /** True when `buttons` came from ReplyInlineMarkup. */
  hasInlineMarkup: boolean;
  hasVideo: boolean;
  hasDocument: boolean;
  fileName?: string;
  fileSize?: number;
  durationSeconds?: number;
  raw: unknown;
}

export interface InlineSearchResponse {
  queryId: string;
  results: InlineResultLike[];
}

export interface TelegramPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  inlineSearch(botUsername: string, query: string): Promise<InlineSearchResponse>;
  sendInlineResult(options: {
    botUsername: string;
    queryId: string;
    resultId: string;
  }): Promise<ChatMessageSnapshot | null>;
  clickButton(button: ButtonLike): Promise<void>;
  waitForMessage(
    predicate: (msg: ChatMessageSnapshot) => boolean,
    options: { timeoutMs: number; pollIntervalMs: number; afterMessageId?: number },
  ): Promise<ChatMessageSnapshot>;
  getRecentMessages(limit?: number): Promise<ChatMessageSnapshot[]>;
  forwardMessageTo(username: string, messageId: number): Promise<{ forwardedMessageId?: number }>;
}

function className(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const ctor = (value as { className?: string; constructor?: { name?: string } }).className
    ?? (value as { constructor?: { name?: string } }).constructor?.name
    ?? "";
  return String(ctor);
}

/** @deprecated Use copyCallbackBytes — kept for test imports that only need a utf8 decode helper. */
export function bufferToUtf8(data: unknown): string | undefined {
  const bytes = copyCallbackBytes(data);
  return bytes?.toString("utf8");
}

function readThumbUrl(result: Api.TypeBotInlineResult): string | undefined {
  const thumb = (result as { thumb?: { url?: string } }).thumb;
  if (thumb && typeof thumb.url === "string" && thumb.url) return thumb.url;
  const photo = (result as { photo?: unknown }).photo;
  // Photo thumbs are not trivially URL-addressable without file refs; skip.
  void photo;
  return undefined;
}

function mapInlineResult(result: Api.TypeBotInlineResult): InlineResultLike {
  const id = String((result as { id?: string }).id ?? "");
  const title = typeof (result as { title?: unknown }).title === "string"
    ? (result as { title: string }).title
    : undefined;
  const description = typeof (result as { description?: unknown }).description === "string"
    ? (result as { description: string }).description
    : undefined;
  const type = typeof (result as { type?: unknown }).type === "string"
    ? (result as { type: string }).type
    : undefined;
  const sendMessage = (result as { sendMessage?: unknown }).sendMessage;
  return {
    id,
    title,
    description,
    type,
    thumbUrl: readThumbUrl(result),
    sendMessageType: className(sendMessage) || undefined,
  };
}

function isInlineMarkup(markup: unknown): boolean {
  const name = className(markup);
  return name.includes("ReplyInlineMarkup") || name.includes("InlineKeyboard");
}

function isReplyKeyboardMarkup(markup: unknown): boolean {
  const name = className(markup);
  return name.includes("ReplyKeyboardMarkup") && !name.includes("Inline");
}

function extractButtonsFromRows(
  rows: unknown[] | undefined,
  options: { messageId: number; markupKind: "inline" | "reply" },
): ButtonLike[] {
  const buttons: ButtonLike[] = [];
  for (const row of rows ?? []) {
    const cells = row && typeof row === "object" && "buttons" in row
      ? ((row as { buttons?: unknown[] }).buttons ?? [])
      : Array.isArray(row)
        ? row
        : [];
    for (const button of cells) {
      if (!button || typeof button !== "object") continue;
      const btnText =
        "text" in button && typeof (button as { text?: unknown }).text === "string"
          ? (button as { text: string }).text.trim()
          : "";
      if (!btnText) continue;

      const rawData = "data" in button ? (button as { data?: unknown }).data : undefined;
      if (options.markupKind === "inline") {
        const dataBytes = copyCallbackBytes(rawData);
        buttons.push({
          text: btnText,
          dataBytes,
          kind: "inline",
          messageId: options.messageId,
        });
      } else {
        buttons.push({
          text: btnText,
          dataBytes: undefined,
          kind: "reply",
          messageId: options.messageId,
        });
      }
    }
  }
  return buttons;
}

/**
 * How to invoke a Findvid button.
 * - Movie-card chrome / studios / qualities (inline + callback bytes) → GetBotCallbackAnswer only.
 * - Sticky bot-home reply keyboard (Подборки / Результат поиска / …) → sendMessage OK.
 */
export type ClickAction =
  | { type: "callback"; dataBytes: Buffer; messageId: number; text: string }
  | { type: "reply_text"; text: string }
  | { type: "error"; reason: string; text: string };

export function resolveClickAction(button: ButtonLike): ClickAction {
  const hasData = hasCallbackData(button);

  // Sticky bot-home reply keyboard: sendMessage is required when there is no callback data.
  if (isBotHomeButton(button) && !hasData) {
    return { type: "reply_text", text: button.text };
  }

  if (button.kind === "reply" && !hasData) {
    return { type: "reply_text", text: button.text };
  }

  // Movie-card inline path — NEVER degrade to sendMessage for Озвучка/studios/qualities.
  if (button.kind === "inline" || hasData) {
    if (!hasData || !button.dataBytes) {
      return {
        type: "error",
        text: button.text,
        reason:
          `Inline button "${button.text}" has no callback data. ` +
          "Refusing to sendMessage the label (Озвучка/studios must be GetBotCallbackAnswer).",
      };
    }
    if (button.messageId === undefined) {
      return {
        type: "error",
        text: button.text,
        reason:
          `Inline button "${button.text}" has callback data but no host messageId. ` +
          "Cannot invoke GetBotCallbackAnswer.",
      };
    }
    return {
      type: "callback",
      dataBytes: Buffer.from(button.dataBytes),
      messageId: button.messageId,
      text: button.text,
    };
  }

  return { type: "reply_text", text: button.text };
}

export function snapshotFromGramJsMessage(message: Api.Message): ChatMessageSnapshot {
  const text = message.message ?? "";
  const messageId = message.id;
  const replyMarkup = message.replyMarkup;

  let buttons: ButtonLike[] = [];
  let hasInlineMarkup = false;

  if (replyMarkup && "rows" in replyMarkup) {
    const rows = (replyMarkup as { rows?: unknown[] }).rows;
    if (isInlineMarkup(replyMarkup)) {
      hasInlineMarkup = true;
      buttons = extractButtonsFromRows(rows, { messageId, markupKind: "inline" });
    } else if (isReplyKeyboardMarkup(replyMarkup)) {
      // Sticky bot-home keyboard only — never treat as movie-card inline.
      buttons = extractButtonsFromRows(rows, { messageId, markupKind: "reply" });
    } else {
      // Unknown markup: extract with data when present, prefer inline if any callback data.
      const extracted = extractButtonsFromMarkup(replyMarkup, { messageId });
      const anyData = extracted.some((b) => hasCallbackData(b));
      hasInlineMarkup = anyData;
      buttons = extracted.map((b) => ({
        ...b,
        kind: hasCallbackData(b) ? "inline" : b.kind,
        messageId,
      }));
    }
  }

  if (buttons.length === 0 && replyMarkup) {
    buttons = extractButtonsFromMarkup(replyMarkup, { messageId });
  }

  const media = message.media;
  const mediaName = className(media);

  let hasVideo = mediaName.includes("MessageMediaPhoto") === false && mediaName.includes("MessageMediaVideo");
  let hasDocument = mediaName.includes("MessageMediaDocument");
  let fileName: string | undefined;
  let fileSize: number | undefined;
  let durationSeconds: number | undefined;

  if (media && "document" in media && media.document && className(media.document).includes("Document")) {
    const doc = media.document as Api.Document;
    hasDocument = true;
    fileSize = Number(doc.size);
    for (const attr of doc.attributes ?? []) {
      const attrName = className(attr);
      if (attrName.includes("DocumentAttributeFilename") && "fileName" in attr) {
        fileName = String((attr as { fileName: string }).fileName);
      }
      if (attrName.includes("DocumentAttributeVideo")) {
        hasVideo = true;
        if ("duration" in attr) {
          durationSeconds = Number((attr as { duration: number }).duration);
        }
      }
    }
  }

  return {
    id: messageId,
    date: message.date,
    text,
    buttons,
    hasInlineMarkup,
    hasVideo,
    hasDocument,
    fileName,
    fileSize,
    durationSeconds,
    raw: message,
  };
}

export function isFinalVideoMessage(msg: ChatMessageSnapshot): boolean {
  if (!(msg.hasVideo || msg.hasDocument)) return false;
  // Never treat howto / «Видео-гайд» support clips as the film.
  if (looksLikeGuideMedia(msg)) return false;
  // Prefer large media (movie files); still accept any video/document if size unknown.
  if (msg.fileSize !== undefined && msg.fileSize > 0) return true;
  if (msg.durationSeconds !== undefined && msg.durationSeconds > 60) return true;
  if (msg.fileName && /\.(mkv|mp4|avi|mov|ts|m4v)$/i.test(msg.fileName)) return true;
  return msg.hasVideo || msg.hasDocument;
}

export class GramJsTelegramPort implements TelegramPort {
  private client: TelegramClient | null = null;
  private findvidEntity: Api.TypeInputPeer | null = null;

  constructor(private readonly config: FindvidConfig) {}

  async connect(): Promise<void> {
    if (this.client?.connected) return;

    const client = new TelegramClient(
      new StringSession(this.config.session),
      this.config.apiId,
      this.config.apiHash,
      { connectionRetries: 5 },
    );

    try {
      await client.connect();
      if (!(await client.checkAuthorization())) {
        throw new TelegramError(
          "GramJS session is not authorized. Re-run login in CreaVideoDownloaderBot and refresh TELEGRAM_SESSION / settings.json.",
        );
      }
      const entity = await client.getEntity(`@${this.config.findvidBotUsername}`);
      this.findvidEntity = await client.getInputEntity(entity);
      this.client = client;
    } catch (err) {
      await client.disconnect().catch(() => undefined);
      if (err instanceof TelegramError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new TelegramError(`Failed to connect GramJS: ${message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    await this.client.disconnect();
    this.client = null;
    this.findvidEntity = null;
  }

  private requireClient(): TelegramClient {
    if (!this.client) {
      throw new TelegramError("Telegram client is not connected");
    }
    return this.client;
  }

  private requireFindvidPeer(): Api.TypeInputPeer {
    if (!this.findvidEntity) {
      throw new TelegramError("Findvid bot peer is not resolved");
    }
    return this.findvidEntity;
  }

  async inlineSearch(botUsername: string, query: string): Promise<InlineSearchResponse> {
    const client = this.requireClient();
    const bot = await client.getInputEntity(`@${botUsername.replace(/^@/, "")}`);
    const peer = this.requireFindvidPeer();

    try {
      const response = await client.invoke(
        new Api.messages.GetInlineBotResults({
          bot,
          peer,
          query,
          offset: "",
        }),
      );

      const results = (response.results ?? []).map(mapInlineResult).filter((r) => r.id);
      return {
        queryId: String(response.queryId),
        results,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new FindvidError(`Inline search failed against @${botUsername}: ${message}`);
    }
  }

  async sendInlineResult(options: {
    botUsername: string;
    queryId: string;
    resultId: string;
  }): Promise<ChatMessageSnapshot | null> {
    const client = this.requireClient();
    const peer = this.requireFindvidPeer();
    const randomId = bigInt(Math.floor(Math.random() * 1e15));

    try {
      const updates = await client.invoke(
        new Api.messages.SendInlineBotResult({
          peer,
          queryId: bigInt(options.queryId),
          id: options.resultId,
          randomId,
        }),
      );

      const messages = extractMessagesFromUpdates(updates);
      if (messages.length === 0) return null;
      return snapshotFromGramJsMessage(messages[messages.length - 1]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new FindvidError(`Failed to send inline result: ${message}`);
    }
  }

  /**
   * Click a button. Movie-card inline buttons (Озвучка / studios / quality) use
   * GetBotCallbackAnswer only — never sendMessage of the label.
   * Sticky reply-keyboard bot-home may sendMessage the label.
   *
   * Callback payloads are opaque bytes: prefer GramJS Message.click (uses the
   * live KeyboardButtonCallback.data), else pass preserved dataBytes as-is.
   */
  async clickButton(button: ButtonLike): Promise<void> {
    const client = this.requireClient();
    const peer = this.requireFindvidPeer();
    const action = resolveClickAction(button);

    if (action.type === "error") {
      throw new TelegramError(action.reason);
    }

    if (action.type === "reply_text") {
      await client.sendMessage(peer, { message: action.text });
      return;
    }

    // Prefer GramJS custom Message.click so callback bytes come from the live markup.
    try {
      const fetched = await client.getMessages(peer, { ids: [action.messageId] });
      const host = Array.isArray(fetched) ? fetched[0] : undefined;
      if (host && typeof (host as { click?: unknown }).click === "function") {
        await (host as { click: (opts: { text?: string }) => Promise<unknown> }).click({
          text: action.text,
        });
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/success|QUERY_ID_INVALID|BOT_RESPONSE_TIMEOUT/i.test(message)) {
        return;
      }
      // Fall through to raw GetBotCallbackAnswer with preserved bytes.
    }

    try {
      await client.invoke(
        new Api.messages.GetBotCallbackAnswer({
          peer,
          msgId: action.messageId,
          // Exact opaque bytes from KeyboardButtonCallback — no UTF-8 round-trip.
          data: action.dataBytes,
        }),
      );
    } catch (err) {
      // GramJS often surfaces a successful answer as an RPC "error" with success text.
      const message = err instanceof Error ? err.message : String(err);
      if (/success|QUERY_ID_INVALID|BOT_RESPONSE_TIMEOUT/i.test(message)) {
        return;
      }
      // Do NOT fall back to sendMessage for inline callbacks (Озвучка must be a real click).
      throw new TelegramError(
        `GetBotCallbackAnswer failed for "${action.text}" on msg#${action.messageId}: ${message}`,
      );
    }
  }

  async getRecentMessages(limit = 20): Promise<ChatMessageSnapshot[]> {
    const client = this.requireClient();
    const peer = this.requireFindvidPeer();
    const history = await client.invoke(
      new Api.messages.GetHistory({
        peer,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        hash: bigInt(0),
      }),
    );

    const messages: Api.Message[] = [];
    if ("messages" in history) {
      for (const msg of history.messages ?? []) {
        if (className(msg).includes("Message") && "id" in msg) {
          messages.push(msg as Api.Message);
        }
      }
    }

    return messages
      .map(snapshotFromGramJsMessage)
      .sort((a, b) => a.id - b.id);
  }

  async waitForMessage(
    predicate: (msg: ChatMessageSnapshot) => boolean,
    options: { timeoutMs: number; pollIntervalMs: number; afterMessageId?: number },
  ): Promise<ChatMessageSnapshot> {
    const deadline = Date.now() + options.timeoutMs;
    let lastSeenId = options.afterMessageId ?? 0;

    while (Date.now() < deadline) {
      const messages = await this.getRecentMessages(25);
      for (const msg of messages) {
        if (msg.id <= lastSeenId) continue;
        lastSeenId = Math.max(lastSeenId, msg.id);
        if (predicate(msg)) return msg;
      }
      await sleep(options.pollIntervalMs);
    }

    throw new TimeoutError(
      `Timed out after ${options.timeoutMs}ms waiting for Findvid bot reply. VIP/rate-limits or UI changes may block automation.`,
    );
  }

  async forwardMessageTo(
    username: string,
    messageId: number,
  ): Promise<{ forwardedMessageId?: number }> {
    const client = this.requireClient();
    const fromPeer = this.requireFindvidPeer();
    const toPeer = await client.getInputEntity(`@${username.replace(/^@/, "")}`);

    try {
      const updates = await client.invoke(
        new Api.messages.ForwardMessages({
          fromPeer,
          id: [messageId],
          randomId: [bigInt(Math.floor(Math.random() * 1e15))],
          toPeer,
          dropAuthor: false,
          silent: false,
        }),
      );

      const messages = extractMessagesFromUpdates(updates);
      return { forwardedMessageId: messages[0]?.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new TelegramError(
        `Failed to forward message ${messageId} to @${username}: ${message}`,
      );
    }
  }
}

function extractMessagesFromUpdates(updates: Api.TypeUpdates): Api.Message[] {
  const out: Api.Message[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (className(value).includes("Message") && "id" in value && "message" in value) {
      out.push(value as Api.Message);
      return;
    }
    if ("updates" in value && Array.isArray((value as { updates: unknown[] }).updates)) {
      for (const u of (value as { updates: unknown[] }).updates) visit(u);
    }
    if ("message" in value) visit((value as { message: unknown }).message);
  };
  visit(updates);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
