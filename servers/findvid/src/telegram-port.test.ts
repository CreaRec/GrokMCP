import { describe, expect, it } from "vitest";
import bigInt from "big-integer";
import { Api } from "telegram/tl/index.js";
import { copyCallbackBytes, formatKeyboardDebug, hasCallbackData } from "./parse.js";
import {
  resolveClickAction,
  snapshotFromGramJsMessage,
} from "./telegram-port.js";

describe("copyCallbackBytes", () => {
  it("preserves opaque non-UTF8 bytes without mangling", () => {
    // Bytes that are invalid UTF-8 / would change under utf8 round-trip.
    const opaque = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x01, 0x7f]);
    const copied = copyCallbackBytes(opaque);
    expect(copied).toBeInstanceOf(Buffer);
    expect(copied!.equals(opaque)).toBe(true);
    // Classic bug: Buffer → utf8 string → Buffer corrupts these bytes.
    const mangled = Buffer.from(opaque.toString("utf8"), "utf8");
    expect(mangled.equals(opaque)).toBe(false);
    expect(copied!.equals(mangled)).toBe(false);
  });

  it("copies Uint8Array and rejects empty payloads", () => {
    expect(copyCallbackBytes(new Uint8Array([1, 2, 3]))?.equals(Buffer.from([1, 2, 3]))).toBe(
      true,
    );
    expect(copyCallbackBytes(Buffer.alloc(0))).toBeUndefined();
    expect(copyCallbackBytes("")).toBeUndefined();
  });
});

describe("resolveClickAction", () => {
  it("uses callback bytes for Озвучка (never reply_text)", () => {
    const dataBytes = Buffer.from([0xff, 0x01, 0x02]);
    const action = resolveClickAction({
      text: "🎶 Озвучка",
      kind: "inline",
      dataBytes,
      messageId: 42,
    });
    expect(action.type).toBe("callback");
    if (action.type === "callback") {
      expect(action.messageId).toBe(42);
      expect(action.dataBytes.equals(dataBytes)).toBe(true);
      // Must be a copy, not the same reference mutated later.
      dataBytes[0] = 0x00;
      expect(action.dataBytes[0]).toBe(0xff);
    }
  });

  it("uses callback for studio pick with dataBytes", () => {
    const action = resolveClickAction({
      text: "✔️ Дублированный",
      kind: "inline",
      dataBytes: Buffer.from("dub"),
      messageId: 42,
    });
    expect(action.type).toBe("callback");
  });

  it("errors instead of sendMessage when inline button lacks data", () => {
    const action = resolveClickAction({
      text: "🎶 Озвучка",
      kind: "inline",
      messageId: 42,
    });
    expect(action.type).toBe("error");
    if (action.type === "error") {
      expect(action.reason).toMatch(/Refusing to sendMessage|no callback data/i);
    }
  });

  it("errors when callback data present but messageId missing", () => {
    const action = resolveClickAction({
      text: "🎶 Озвучка",
      kind: "inline",
      dataBytes: Buffer.from("vo"),
    });
    expect(action.type).toBe("error");
  });

  it("allows reply_text only for true reply-keyboard bot-home", () => {
    const action = resolveClickAction({
      text: "🗂 Подборки",
      kind: "reply",
    });
    expect(action).toEqual({ type: "reply_text", text: "🗂 Подборки" });
  });

  it("allows sendMessage for Результат поиска even if mis-tagged inline without data", () => {
    const action = resolveClickAction({
      text: "🔍 Результат поиска",
      kind: "inline",
      messageId: 10,
    });
    expect(action).toEqual({ type: "reply_text", text: "🔍 Результат поиска" });
  });

  it("still refuses sendMessage for Озвучка without callback data", () => {
    const action = resolveClickAction({
      text: "🎶 Озвучка",
      kind: "inline",
      messageId: 42,
    });
    expect(action.type).toBe("error");
  });
});

describe("snapshotFromGramJsMessage callback bytes", () => {
  it("keeps KeyboardButtonCallback.data as raw bytes through snapshot → resolveClickAction", () => {
    const opaque = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x42]);
    const message = new Api.Message({
      id: 961896,
      peerId: new Api.PeerUser({ userId: bigInt(1) }),
      date: 1,
      message: "Достать ножи (Back Board Cinema [1080p])",
      replyMarkup: new Api.ReplyInlineMarkup({
        rows: [
          new Api.KeyboardButtonRow({
            buttons: [
              new Api.KeyboardButtonCallback({
                text: "🎶 Озвучка",
                data: opaque,
              }),
              new Api.KeyboardButtonCallback({
                text: "🔮 Качество",
                data: Buffer.from([0x01, 0x02, 0xff]),
              }),
            ],
          }),
        ],
      }),
    });

    const snap = snapshotFromGramJsMessage(message);
    expect(snap.id).toBe(961896);
    expect(snap.hasInlineMarkup).toBe(true);
    const ozv = snap.buttons.find((b) => /озвучк/i.test(b.text));
    expect(ozv?.messageId).toBe(961896);
    expect(hasCallbackData(ozv!)).toBe(true);
    expect(ozv!.dataBytes!.equals(opaque)).toBe(true);

    const action = resolveClickAction(ozv!);
    expect(action.type).toBe("callback");
    if (action.type === "callback") {
      expect(action.messageId).toBe(961896);
      expect(action.dataBytes.equals(opaque)).toBe(true);
      // Simulate GetBotCallbackAnswer payload: must match original bytes exactly.
      expect(Buffer.from(action.dataBytes).equals(opaque)).toBe(true);
    }
  });

  it("marks ReplyKeyboardMarkup as reply (bot-home), not inline callbacks", () => {
    const message = new Api.Message({
      id: 10,
      peerId: new Api.PeerUser({ userId: bigInt(1) }),
      date: 1,
      message: "home",
      replyMarkup: new Api.ReplyKeyboardMarkup({
        rows: [
          new Api.KeyboardButtonRow({
            buttons: [
              new Api.KeyboardButton({ text: "🗂 Подборки" }),
              new Api.KeyboardButton({ text: "🔍 Результат поиска" }),
            ],
          }),
        ],
      }),
    });

    const snap = snapshotFromGramJsMessage(message);
    expect(snap.hasInlineMarkup).toBe(false);
    expect(snap.buttons.every((b) => b.kind === "reply")).toBe(true);
    expect(resolveClickAction(snap.buttons[0]!).type).toBe("reply_text");
  });
});

describe("formatKeyboardDebug", () => {
  it("includes message id, kinds, and data byte lengths", () => {
    const dump = formatKeyboardDebug(
      [
        {
          text: "🎶 Озвучка",
          kind: "inline",
          dataBytes: Buffer.from([1, 2, 3]),
          messageId: 5,
        },
        { text: "🗂 Подборки", kind: "reply" },
      ],
      { messageId: 5 },
    );
    expect(dump).toContain("msg#5");
    expect(dump).toContain("data=3b");
    expect(dump).toContain("data=no");
    expect(dump).toContain("Озвучка");
  });
});
