import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import bigInt from "big-integer";
import type { FindvidConfig } from "./config.js";
import { FindvidError, TelegramError, TimeoutError } from "./errors.js";
import {
  extractButtonsFromMarkup,
  looksLikeGuideMedia,
  type ButtonLike,
  type InlineResultLike,
} from "./parse.js";

export interface ChatMessageSnapshot {
  id: number;
  date: number;
  text: string;
  buttons: ButtonLike[];
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

function bufferToUtf8(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  return undefined;
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

export function snapshotFromGramJsMessage(message: Api.Message): ChatMessageSnapshot {
  const text = message.message ?? "";
  const buttons: ButtonLike[] = [];

  const replyMarkup = message.replyMarkup;
  if (replyMarkup && "rows" in replyMarkup) {
    for (const row of (replyMarkup as Api.ReplyInlineMarkup | Api.ReplyKeyboardMarkup).rows ?? []) {
      for (const button of row.buttons ?? []) {
        const btnText = "text" in button && typeof button.text === "string" ? button.text.trim() : "";
        if (!btnText) continue;
        const data =
          "data" in button ? bufferToUtf8((button as { data?: unknown }).data) : undefined;
        buttons.push({
          text: btnText,
          data,
          kind: data !== undefined ? "inline" : "reply",
        });
      }
    }
  }

  if (buttons.length === 0) {
    buttons.push(...extractButtonsFromMarkup(replyMarkup));
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
    id: message.id,
    date: message.date,
    text,
    buttons,
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

  async clickButton(button: ButtonLike): Promise<void> {
    const client = this.requireClient();
    const peer = this.requireFindvidPeer();

    if (button.kind === "reply" || !button.data) {
      await client.sendMessage(peer, { message: button.text });
      return;
    }

    const recent = await this.getRecentMessages(8);
    const host = recent.find((m) =>
      m.buttons.some((b) => b.data === button.data || b.text === button.text),
    );
    if (!host) {
      // Fall back to sending the visible label as text (works for many reply-style UIs).
      await client.sendMessage(peer, { message: button.text });
      return;
    }

    try {
      await client.invoke(
        new Api.messages.GetBotCallbackAnswer({
          peer,
          msgId: host.id,
          data: Buffer.from(button.data, "utf8"),
        }),
      );
    } catch (err) {
      // Some bots return "success" as an exception-like RPC; still try text fallback.
      const message = err instanceof Error ? err.message : String(err);
      if (/success|QUERY_ID_INVALID/i.test(message)) {
        return;
      }
      await client.sendMessage(peer, { message: button.text });
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
