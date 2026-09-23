import { describe, expect, it } from "vitest";
import { Api } from "telegram/tl/index.js";
import { formatKeyboardDebug } from "./parse.js";
import {
  bufferToUtf8,
  resolveClickAction,
  snapshotFromGramJsMessage,
} from "./telegram-port.js";

describe("bufferToUtf8", () => {
  it("decodes Buffer and Uint8Array callback data", () => {
    expect(bufferToUtf8(Buffer.from("vo_open", "utf8"))).toBe("vo_open");
    expect(bufferToUtf8(new Uint8Array(Buffer.from("q_open", "utf8")))).toBe("q_open");
    expect(bufferToUtf8("plain")).toBe("plain");
  });
});

describe("resolveClickAction", () => {
  it("uses callback for Озвучка with data+messageId (never reply_text)", () => {
    const action = resolveClickAction({
      text: "🎶 Озвучка",
      kind: "inline",
      data: "vo_open",
      messageId: 42,
    });
    expect(action).toEqual({
      type: "callback",
      data: "vo_open",
      messageId: 42,
      text: "🎶 Озвучка",
    });
  });

  it("uses callback for studio pick with data", () => {
    const action = resolveClickAction({
      text: "✔️ Дублированный",
      kind: "inline",
      data: "dub",
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
      data: "vo",
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
    // Live post-#70 deadlock: recovery button had kind=inline + no callback data.
    const action = resolveClickAction({
      text: "🔍 Результат поиска",
      kind: "inline",
      messageId: 10,
    });
    expect(action).toEqual({ type: "reply_text", text: "🔍 Результат поиска" });
  });

  it("allows sendMessage for Результат поиска with empty callback data string", () => {
    const action = resolveClickAction({
      text: "🔍 Результат поиска",
      kind: "inline",
      data: "",
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

describe("snapshotFromGramJsMessage markup kinds", () => {
  it("extracts inline callback data + messageId from ReplyInlineMarkup", () => {
    const message = new Api.Message({
      id: 77,
      peerId: new Api.PeerUser({ userId: bigIntish(1) }),
      date: 1,
      message: "Достать ножи (Back Board Cinema [1080p])",
      replyMarkup: new Api.ReplyInlineMarkup({
        rows: [
          new Api.KeyboardButtonRow({
            buttons: [
              new Api.KeyboardButtonCallback({
                text: "🎶 Озвучка",
                data: Buffer.from("vo_open", "utf8"),
              }),
              new Api.KeyboardButtonCallback({
                text: "🔮 Качество",
                data: Buffer.from("q_open", "utf8"),
              }),
            ],
          }),
        ],
      }),
    });

    const snap = snapshotFromGramJsMessage(message);
    expect(snap.hasInlineMarkup).toBe(true);
    expect(snap.buttons.map((b) => b.text)).toEqual(["🎶 Озвучка", "🔮 Качество"]);
    expect(snap.buttons.every((b) => b.kind === "inline")).toBe(true);
    expect(snap.buttons[0]?.data).toBe("vo_open");
    expect(snap.buttons[0]?.messageId).toBe(77);
    expect(resolveClickAction(snap.buttons[0]!).type).toBe("callback");
  });

  it("marks ReplyKeyboardMarkup as reply (bot-home), not inline callbacks", () => {
    const message = new Api.Message({
      id: 10,
      peerId: new Api.PeerUser({ userId: bigIntish(1) }),
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
  it("includes message id, kinds, and data flags", () => {
    const dump = formatKeyboardDebug(
      [
        { text: "🎶 Озвучка", kind: "inline", data: "vo", messageId: 5 },
        { text: "🗂 Подборки", kind: "reply" },
      ],
      { messageId: 5 },
    );
    expect(dump).toContain("msg#5");
    expect(dump).toContain('data=yes');
    expect(dump).toContain('data=no');
    expect(dump).toContain("Озвучка");
  });
});

/** big-integer-ish value accepted by GramJS constructors in tests. */
function bigIntish(n: number): import("big-integer").BigInteger {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bigInt = require("big-integer") as typeof import("big-integer");
  return bigInt(n);
}
