import { describe, expect, it } from "vitest";
import {
  extractButtonsFromMarkup,
  findQualityMenuButton,
  findSearchResultRecoveryButton,
  findVoiceoverMenuButton,
  formatBytes,
  isChoiceButton,
  looksLikeBotHomeKeyboard,
  looksLikeChromeMenu,
  looksLikeGuideMedia,
  looksLikeMovieCardButtons,
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

/** Live Findvid VIP chrome row (screenshot 1). */
const chromeMenu: ButtonLike[] = [
  { text: "🎶 Озвучка", kind: "inline", data: "vo" },
  { text: "🔮 Качество", kind: "inline", data: "q" },
  { text: "🔔 Уведомлять", kind: "inline", data: "n" },
  { text: "⭐ В избранное", kind: "inline", data: "f" },
  { text: "💬 Обсуждения", kind: "inline", data: "d" },
  { text: "⤴️ Поделиться", kind: "inline", data: "s" },
  { text: "❤️ Оценить текущую озвучку", kind: "inline", data: "r" },
  { text: "😭 Ошибка в видео", kind: "inline", data: "e" },
  { text: "📱 Наши проекты", kind: "inline", data: "p" },
  { text: "📺 TV Cast", kind: "inline", data: "c" },
  { text: "ℹ️ Подробнее", kind: "inline", data: "i" },
  { text: "👌 Рекомендации", kind: "inline", data: "rec" },
  { text: "🕔 История", kind: "inline", data: "h" },
  { text: "🔍 Поиск", kind: "inline", data: "search" },
  { text: "🔼 Свернуть меню", kind: "inline", data: "collapse" },
];

/** Live Findvid VIP voiceover list after clicking Озвучка (screenshot 2). */
const voiceoverList: ButtonLike[] = [
  { text: "✔️ Back Board Cinema", kind: "inline", data: "v1" },
  { text: "✔️ Back Board Cinema | Студийная Банда", kind: "inline", data: "v2" },
  { text: "✔️ Дублированный", kind: "inline", data: "v3" },
  { text: "✔️ AlexFilm", kind: "inline", data: "v4" },
  { text: "✔️ Перевод", kind: "inline", data: "v5" },
  { text: "✔️ Синема УС", kind: "inline", data: "v6" },
  { text: "✔️ Одноголосый", kind: "inline", data: "v7" },
  { text: "✔️ Малиновский Сергей | Vaxywod", kind: "inline", data: "v8" },
  { text: "✔️ iTunes", kind: "inline", data: "v9" },
  { text: "✔️ Хихикающий доктор | Xixidok", kind: "inline", data: "v10" },
  { text: "✔️ [EN] Original", kind: "inline", data: "v11" },
  { text: "🔙 Назад", kind: "inline", data: "back" },
];

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

describe("chrome menu vs voiceover/quality lists", () => {
  it("detects live chrome menu and finds Озвучка / Качество openers", () => {
    expect(looksLikeChromeMenu(chromeMenu)).toBe(true);
    expect(looksLikeVoiceoverButtons(chromeMenu)).toBe(false);
    expect(looksLikeQualityButtons(chromeMenu)).toBe(false);
    expect(findVoiceoverMenuButton(chromeMenu)?.text).toBe("🎶 Озвучка");
    expect(findQualityMenuButton(chromeMenu)?.text).toBe("🔮 Качество");
  });

  it("excludes chrome labels from choice buttons and picks", () => {
    expect(chromeMenu.every((b) => !isChoiceButton(b))).toBe(true);
    expect(pickVoiceoverButton(chromeMenu, "Дублированный")?.text).toBeUndefined();
    expect(pickQualityButton(chromeMenu)?.text).toBeUndefined();
  });

  it("treats post-Озвучка list as real voiceovers, not chrome", () => {
    expect(looksLikeChromeMenu(voiceoverList)).toBe(false);
    expect(looksLikeVoiceoverButtons(voiceoverList)).toBe(true);
    expect(looksLikeQualityButtons(voiceoverList)).toBe(false);
    expect(pickVoiceoverButton(voiceoverList)?.text).toBe("✔️ Дублированный");
    expect(pickVoiceoverButton(voiceoverList, "Дублированный", "AlexFilm")?.text).toBe(
      "✔️ AlexFilm",
    );
    // Nav / chrome must not appear in choice list.
    const choices = voiceoverList.filter(isChoiceButton).map((b) => b.text);
    expect(choices).not.toContain("🔙 Назад");
    expect(choices.some((t) => /озвучк/i.test(t))).toBe(false);
  });

  it("keeps Back Board Cinema as a voiceover (not nav «back»)", () => {
    expect(isChoiceButton({ text: "✔️ Back Board Cinema", kind: "inline", data: "x" })).toBe(
      true,
    );
    expect(isChoiceButton({ text: "🔙 Назад", kind: "inline", data: "b" })).toBe(false);
  });

  it("does not treat Инструкция / Видео-гайд as qualities", () => {
    const junk: ButtonLike[] = [
      { text: "Инструкция", kind: "inline", data: "i" },
      { text: "Видео-гайд", kind: "inline", data: "g" },
      { text: "Поддержка", kind: "inline", data: "s" },
    ];
    expect(junk.every((b) => !isChoiceButton(b))).toBe(true);
    expect(looksLikeQualityButtons(junk)).toBe(false);
    expect(pickQualityButton(junk)).toBeNull();
  });
});

/** Live Findvid VIP sticky reply keyboard (not movie card). */
const botHomeKeyboard: ButtonLike[] = [
  { text: "🗂 Подборки", kind: "reply" },
  { text: "🌪️ Фильтр", kind: "reply" },
  { text: "⚙️ Настройки", kind: "reply" },
  { text: "💝 VIP", kind: "reply" },
  { text: "🔍 Результат поиска", kind: "reply" },
];

describe("bot-home reply keyboard", () => {
  it("excludes Подборки/Фильтр/… from voiceover choices", () => {
    expect(looksLikeBotHomeKeyboard(botHomeKeyboard)).toBe(true);
    expect(looksLikeVoiceoverButtons(botHomeKeyboard)).toBe(false);
    expect(looksLikeChromeMenu(botHomeKeyboard)).toBe(false);
    expect(looksLikeMovieCardButtons(botHomeKeyboard)).toBe(false);
    expect(botHomeKeyboard.every((b) => !isChoiceButton(b))).toBe(true);
    expect(pickVoiceoverButton(botHomeKeyboard)).toBeNull();
    expect(findSearchResultRecoveryButton(botHomeKeyboard)?.text).toBe("🔍 Результат поиска");
  });
});

describe("Knives Out ranking", () => {
  it("prefers Достать ножи (Knives Out) film over Radiohead: Knives Out", () => {
    const { best, alternatives } = rankInlineResults("Knives Out", [
      {
        id: "radiohead",
        title: "Radiohead: Knives Out",
        description: "Клип",
      },
      {
        id: "121666",
        title: "Достать ножи (Knives Out) (2019)",
        description: "Смотреть · КП: 8.197",
      },
    ]);
    expect(best?.resultId).toBe("121666");
    expect(best?.year).toBe(2019);
    expect(alternatives.some((a) => a.resultId === "radiohead")).toBe(true);
    expect(scoreMatch("Knives Out", {
      id: "121666",
      title: "Достать ножи (Knives Out) (2019)",
      description: "Смотреть · КП: 8.197",
    })).toBeGreaterThan(
      scoreMatch("Knives Out", {
        id: "radiohead",
        title: "Radiohead: Knives Out",
        description: "Клип",
      }),
    );
  });
});

describe("looksLikeGuideMedia", () => {
  it("flags tiny Видео-гайд clips", () => {
    expect(
      looksLikeGuideMedia({
        fileName: "video-guide.mp4",
        fileSize: Math.round(8.4 * 1024 * 1024),
        text: "Видео-гайд по использованию",
      }),
    ).toBe(true);
  });

  it("accepts multi-GB film sizes", () => {
    expect(
      looksLikeGuideMedia({
        fileName: "movie.mkv",
        fileSize: Math.round(2.4 * 1024 ** 3),
        durationSeconds: 6372,
      }),
    ).toBe(false);
  });
});

describe("formatBytes", () => {
  it("formats GB sizes like the Findvid card", () => {
    expect(formatBytes(2.9 * 1024 ** 3)).toBe("2.9 GB");
  });
});
