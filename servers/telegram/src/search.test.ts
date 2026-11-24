import { describe, expect, it, vi } from "vitest";
import { linkKind, presentHit, telegramSearch } from "./search.js";

const config = {
  apiUrl: "http://api.example:8787",
  token: "test-token",
  timeoutMs: 5_000,
};

describe("linkKind", () => {
  it("classifies message, chat, and none", () => {
    expect(linkKind("https://t.me/news/11", "https://t.me/news")).toBe("message");
    expect(linkKind("https://t.me/c/9876543210/7", null)).toBe("message");
    expect(linkKind(null, "https://t.me/alice")).toBe("chat");
    expect(linkKind(null, null)).toBe("none");
  });
});

describe("presentHit", () => {
  it("maps upstream hits and adds link_kind", () => {
    const hit = presentHit({
      chat_id: -100123,
      chat_title: "News",
      chat_type: "channel",
      ts_start: "2024-06-01T10:00:00.000Z",
      ts_end: "2024-06-01T10:05:00.000Z",
      senders: ["Alice"],
      snippet: "hello",
      messages: [
        {
          id: 11,
          date: "2024-06-01T10:00:00.000Z",
          sender: "Alice",
          message_link: "https://t.me/news/11",
          chat_link: "https://t.me/news",
        },
      ],
    });
    expect(hit.chat_id).toBe("-100123");
    expect(hit.messages[0].link_kind).toBe("message");
    expect(hit.snippet).toBe("hello");
  });
});

describe("telegramSearch", () => {
  it("POSTs query and filters with bearer auth and maps hits", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://api.example:8787/search");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        query: "привет",
        limit: 5,
        chat_ids: ["-1001"],
        from: "2024-01-01",
        to: "2024-12-31",
      });
      return new Response(
        JSON.stringify({
          took_ms: 120,
          embed_ms: 70,
          hits: [
            {
              chat_id: "555",
              chat_title: "Alice",
              chat_type: "private",
              ts_start: "2024-02-02T12:00:00.000Z",
              ts_end: "2024-02-02T12:00:00.000Z",
              senders: ["Alice"],
              snippet: "hi",
              messages: [
                {
                  id: 9,
                  date: "2024-02-02T12:00:00.000Z",
                  sender: "Alice",
                  message_link: null,
                  chat_link: "https://t.me/alice",
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await telegramSearch(
      { query: "  привет  ", chat_ids: [-1001], from: "2024-01-01", to: "2024-12-31", limit: 5 },
      { config, fetchImpl },
    );
    expect(result.took_ms).toBe(120);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].messages[0].link_kind).toBe("chat");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects an empty query and surfaces API errors", async () => {
    await expect(telegramSearch({ query: "  " }, { config, fetchImpl: fetch })).rejects.toThrow(/query is required/);

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as unknown as typeof fetch;
    await expect(telegramSearch({ query: "ok" }, { config, fetchImpl })).rejects.toThrow(/unauthorized/);
  });
});
