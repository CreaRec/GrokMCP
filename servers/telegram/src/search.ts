import { getConfig, type TelegramSearchConfig } from "./config.js";

export type LinkKind = "message" | "chat" | "none";

export interface SearchArgs {
  query: string;
  chat_ids?: Array<string | number>;
  from?: string;
  to?: string;
  limit?: number;
}

export interface PresentedMessage {
  id: number;
  date: string | null;
  sender: string | null;
  message_link: string | null;
  chat_link: string | null;
  link_kind: LinkKind;
}

export interface PresentedHit {
  chat_id: string;
  chat_title: string | null;
  chat_type: string | null;
  ts_start: string | null;
  ts_end: string | null;
  senders: string[];
  snippet: string | null;
  messages: PresentedMessage[];
}

export interface SearchResult {
  took_ms: number;
  embed_ms?: number;
  hits: PresentedHit[];
}

export function linkKind(messageLink: string | null | undefined, chatLink: string | null | undefined): LinkKind {
  if (typeof messageLink === "string" && messageLink.startsWith("https://t.me/")) return "message";
  if (typeof chatLink === "string" && chatLink.startsWith("https://t.me/")) return "chat";
  return "none";
}

export function normalizeChatIds(raw: Array<string | number> | undefined): string[] | undefined {
  if (!raw?.length) return undefined;
  return raw.map((id) => String(id).trim()).filter(Boolean);
}

interface UpstreamMessage {
  id?: number;
  date?: string | null;
  sender?: string | null;
  message_link?: string | null;
  chat_link?: string | null;
}

interface UpstreamHit {
  chat_id?: string | number;
  chat_title?: string | null;
  chat_type?: string | null;
  ts_start?: string | null;
  ts_end?: string | null;
  senders?: string[];
  snippet?: string;
  messages?: UpstreamMessage[];
}

interface UpstreamResponse {
  took_ms?: number;
  embed_ms?: number;
  hits?: UpstreamHit[];
  error?: string;
}

export function presentHit(hit: UpstreamHit): PresentedHit {
  const messages: PresentedMessage[] = (hit.messages ?? []).map((m) => {
    const message_link = m.message_link ?? null;
    const chat_link = m.chat_link ?? null;
    return {
      id: Number(m.id),
      date: m.date ?? null,
      sender: m.sender ?? null,
      message_link,
      chat_link,
      link_kind: linkKind(message_link, chat_link),
    };
  });
  return {
    chat_id: String(hit.chat_id ?? ""),
    chat_title: hit.chat_title ?? null,
    chat_type: hit.chat_type ?? null,
    ts_start: hit.ts_start ?? null,
    ts_end: hit.ts_end ?? null,
    senders: hit.senders ?? [],
    snippet: hit.snippet ?? null,
    messages,
  };
}

export async function telegramSearch(
  args: SearchArgs,
  options: { config?: TelegramSearchConfig; fetchImpl?: typeof fetch } = {},
): Promise<SearchResult> {
  const query = args.query.trim();
  if (!query) throw new Error("query is required");
  if (query.length > 2000) throw new Error("query is too long");

  const config = options.config ?? getConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = args.limit ?? 10;
  const body: Record<string, unknown> = { query, limit };
  const chatIds = normalizeChatIds(args.chat_ids);
  if (chatIds) body.chat_ids = chatIds;
  if (args.from) body.from = args.from;
  if (args.to) body.to = args.to;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${config.apiUrl}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const timeout = new Error(`tg-search API timed out after ${config.timeoutMs}ms`);
      timeout.name = "TimeoutError";
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed: UpstreamResponse;
  try {
    parsed = text ? (JSON.parse(text) as UpstreamResponse) : {};
  } catch {
    throw new Error("tg-search API returned invalid JSON");
  }

  if (!response.ok) {
    const msg = typeof parsed.error === "string" && parsed.error ? parsed.error : `HTTP ${response.status}`;
    throw new Error(`tg-search API error: ${msg}`);
  }

  return {
    took_ms: parsed.took_ms ?? 0,
    embed_ms: parsed.embed_ms,
    hits: (parsed.hits ?? []).map(presentHit),
  };
}
