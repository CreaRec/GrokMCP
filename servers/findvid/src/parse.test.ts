import { describe, expect, it } from "vitest";
import {
  extractButtonsFromMarkup,
  formatBytes,
  looksLikeQualityButtons,
  looksLikeVoiceoverButtons,
  normalizeText,
  parseMovieMeta,
  pickQualityButton,
  pickVoiceoverButton,
  rankInlineResults,
  scoreMatch,
  type ButtonLike,
  type InlineResultLike,
} from "./parse.js";

describe("normalizeText", () => {
  it("folds yo and punctuation", () => {
    expect(normalizeText("Девушка с татуировкой!")).toContain("девушка");
    expect(normalizeText("Ёлка")).toBe("елка");
  });
});

describe("parseMovieMeta", () => {
  it("extracts year and ratings from title/description", () => {
    const meta = parseMovieMeta(
      "Девушка с татуировкой дракона (2011)",
      "Смотреть · КП: 7.8 · IMDb: 7.8",
    );
    expect(meta.title).toBe("Девушка с татуировкой дракона");
    expect(meta.year).toBe(2011);
    expect(meta.kp).toBe("7.8");
    expect(meta.imdb).toBe("7.8");
    expect(meta.kind).toBe("watch");
    expect(meta.shortMeta).toContain("2011");
  });

  it("marks trailers", () => {
    const meta = parseMovieMeta("Inception (2010)", "Трейлер");
    expect(meta.kind).toBe("trailer");
  });
});

describe("rankInlineResults", () => {
  const fixtures: InlineResultLike[] = [
    {
      id: "1",
      title: "Девушка с татуировкой дракона (2011)",
      description: "Смотреть · КП: 7.8",
    },
    {
      id: "2",
      title: "Девушка с татуировкой дракона (2011)",
      description: "Трейлер",
    },
    {
      id: "3",
      title: "Другая девушка (2005)",
      description: "Смотреть",
    },
  ];

  it("prefers watch over trailer for the same title", () => {
    const { best, alternatives } = rankInlineResults(
      "Девушка с татуировкой дракона",
      fixtures,
    );
    expect(best?.resultId).toBe("1");
    expect(best?.kind).toBe("watch");
    expect(alternatives.some((a) => a.resultId === "2")).toBe(true);
  });

  it("scores exact title higher", () => {
    expect(scoreMatch("Inception", { id: "a", title: "Inception (2010)" })).toBeGreaterThan(
      scoreMatch("Inception", { id: "b", title: "Interstellar (2014)" }),
    );
  });
});

describe("button selection", () => {
  const voiceovers: ButtonLike[] = [
    { text: "HDrezka", kind: "reply" },
    { text: "LostFilm", kind: "reply" },
    { text: "Дублированный", kind: "reply" },
    { text: "⏭️ Вернуться", kind: "reply" },
    { text: "✖️ Скрыть", kind: "reply" },
  ];

  const qualities: ButtonLike[] = [
    { text: "720p", kind: "inline", data: "q720" },
    { text: "480p", kind: "inline", data: "q480" },
    { text: "1080p", kind: "inline", data: "q1080" },
    { text: "Вернуться", kind: "inline", data: "back" },
  ];

  it("picks Дублированный by default", () => {
    expect(pickVoiceoverButton(voiceovers)?.text).toBe("Дублированный");
  });

  it("honors voiceover override", () => {
    expect(pickVoiceoverButton(voiceovers, "Дублированный", "LostFilm")?.text).toBe(
      "LostFilm",
    );
  });

  it("picks 1080p over lower qualities", () => {
    expect(pickQualityButton(qualities)?.text).toBe("1080p");
  });

  it("honors quality override", () => {
    expect(pickQualityButton(qualities, ["1080p"], "720p")?.text).toBe("720p");
  });

  it("detects voiceover vs quality button sets", () => {
    expect(looksLikeVoiceoverButtons(voiceovers)).toBe(true);
    expect(looksLikeQualityButtons(qualities)).toBe(true);
    expect(looksLikeQualityButtons(voiceovers)).toBe(false);
  });

  it("extracts buttons from markup rows", () => {
    const buttons = extractButtonsFromMarkup({
      rows: [
        [{ text: "1080p", data: "x" }, { text: "720p", data: "y" }],
        [{ text: "Вернуться" }],
      ],
    });
    expect(buttons.map((b) => b.text)).toEqual(["1080p", "720p", "Вернуться"]);
    expect(buttons[0].kind).toBe("inline");
  });
});

describe("formatBytes", () => {
  it("formats GB sizes like the Findvid card", () => {
    expect(formatBytes(2.9 * 1024 ** 3)).toBe("2.9 GB");
  });
});
