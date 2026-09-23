/**
 * Pure parsing / ranking / button-selection helpers for Findvid bot UX.
 * Kept free of GramJS so unit tests can use fixtures without a Telegram login.
 */

export interface InlineResultLike {
  id: string;
  title?: string;
  description?: string;
  type?: string;
  /** Thumbnail / poster URL when the bot provides one. */
  thumbUrl?: string;
  /** Raw sendMessage type hint when available (e.g. text / media). */
  sendMessageType?: string;
}

export interface ParsedMovieMeta {
  title: string;
  year?: number;
  kp?: string;
  imdb?: string;
  shortMeta: string;
  kind?: "watch" | "trailer" | "other";
}

export interface RankedMatch extends ParsedMovieMeta {
  resultId: string;
  score: number;
  rawTitle: string;
  rawDescription: string;
  thumbUrl?: string;
}

export interface ButtonLike {
  text: string;
  /**
   * Opaque KeyboardButtonCallback.data bytes.
   * Must not be UTF-8 round-tripped (Telegram payloads are often non-text).
   */
  dataBytes?: Buffer;
  kind: "reply" | "inline";
  /** Host message id for GetBotCallbackAnswer (inline only). */
  messageId?: number;
}

/** True when the button carries a non-empty callback payload. */
export function hasCallbackData(button: ButtonLike): boolean {
  return Buffer.isBuffer(button.dataBytes) && button.dataBytes.length > 0;
}

const YEAR_RE = /\((\d{4})\)/;
const KP_RE = /(?:КП|KP|Kinopoisk|Кинопоиск)\s*[:\s]*([0-9]+(?:[.,][0-9]+)?)/i;
const IMDB_RE = /(?:IMDb?|IMDB)\s*[:\s]*([0-9]+(?:[.,][0-9]+)?)/i;
const QUALITY_RE = /^(\d{3,4})\s*p$/i;
const TRAILER_RE = /трейлер|trailer/i;
const WATCH_RE = /смотреть|watch/i;
/** Artist: Track / music-video style titles (e.g. Radiohead: Knives Out). */
const MUSIC_TITLE_RE = /^[^:]{1,40}:\s+.+/;
const MUSIC_META_RE = /клип|official\s*video|music\s*video|песня|lyric|audio\s*track|radiohead/i;

/**
 * Top-level Findvid movie-card chrome (not voiceover/quality picks).
 * Live VIP UI: Озвучка / Качество open nested lists; the rest are menu actions.
 * Allow optional leading «в » (e.g. «В избранное»).
 */
const CHROME_LABEL_RE =
  /^(?:в\s+)?(озвучк|качеств|уведомл|избранн|обсужден|поделит|оценить|ошибк|наши проект|tv\s*cast|подробнее|рекомендац|истори|поиск|свернуть|развернуть|инструкц|видео.?гайд|гайд|поддержк|помощь|help|projects?|share|notify|favorite|discuss|rate|cast|history|search|collapse|expand|menu)/i;

/**
 * Persistent bot-home / search reply keyboard (not movie-card chrome).
 * Live VIP: Подборки, Фильтр, Настройки, VIP, Результат поиска, …
 */
const BOT_HOME_LABEL_RE =
  /^(подборк|фильтр|настройк|vip|результат\s*поиск|поиск\s*фильм|каталог|жанр|коллекц|главн\w*\s*меню|home|settings|filter|collections?|favorites?|профиль|profile)/i;

const NAV_LABEL_RE =
  /^(вернуться|назад|скрыть?|отмена|cancel|back|hide|menu|меню|главн\w*)(\s+меню)?$/i;

/** Opens the nested voiceover list from the chrome menu. */
const VOICEOVER_MENU_RE = /озвучк/i;
/** Opens the nested quality list from the chrome menu. */
const QUALITY_MENU_RE = /качеств/i;
/** Reply-keyboard recovery: re-open last search / result card. */
const SEARCH_RESULT_RECOVERY_RE = /результат\s*поиск/i;

/** Tiny howto / support videos must never be treated as the film file. */
const GUIDE_TEXT_RE = /видео.?гайд|инструкц|howto|how.?to|гайд|туториал|tutorial|поддержк/i;

/** Below this size, media is treated as a guide unless duration is movie-length. */
export const MIN_FILM_FILE_BYTES = 80 * 1024 * 1024; // 80 MB
export const MIN_FILM_DURATION_SECONDS = 20 * 60; // 20 min

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[ё]/g, "е")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseMovieMeta(
  title: string,
  description = "",
): ParsedMovieMeta {
  const combined = `${title}\n${description}`.trim();
  const yearMatch = combined.match(YEAR_RE);
  const year = yearMatch ? Number.parseInt(yearMatch[1], 10) : undefined;

  const titleWithoutYear = title.replace(YEAR_RE, "").replace(/\s+/g, " ").trim();

  const kpMatch = combined.match(KP_RE);
  const imdbMatch = combined.match(IMDB_RE);
  const kp = kpMatch?.[1]?.replace(",", ".");
  const imdb = imdbMatch?.[1]?.replace(",", ".");

  let kind: ParsedMovieMeta["kind"] = "other";
  if (TRAILER_RE.test(combined)) kind = "trailer";
  else if (WATCH_RE.test(combined)) kind = "watch";

  const metaParts: string[] = [];
  if (year) metaParts.push(String(year));
  if (kp) metaParts.push(`kp ${kp}`);
  if (imdb) metaParts.push(`imdb ${imdb}`);
  if (kind === "trailer") metaParts.push("trailer");
  if (kind === "watch") metaParts.push("watch");

  return {
    title: titleWithoutYear || title,
    year,
    kp,
    imdb,
    shortMeta: metaParts.join(" · "),
    kind,
  };
}

export function scoreMatch(query: string, result: InlineResultLike): number {
  const q = normalizeText(query);
  const rawTitle = result.title ?? "";
  const title = normalizeText(rawTitle);
  const description = normalizeText(result.description ?? "");
  const haystack = `${title} ${description}`;

  if (!q || !title) return 0;

  let score = 0;
  if (title === q) score += 100;
  else if (title.startsWith(q)) score += 80;
  else if (title.includes(q)) score += 60;
  else if (haystack.includes(q)) score += 40;
  else {
    const qTokens = q.split(" ").filter((t) => t.length > 1);
    const hits = qTokens.filter((t) => haystack.includes(t)).length;
    if (qTokens.length === 0) return 0;
    score += Math.round((hits / qTokens.length) * 35);
  }

  // Prefer bilingual film titles where the query is the parenthetical English alias
  // (e.g. «Достать ножи (Knives Out)» for query "Knives Out").
  const parenMatches = [...rawTitle.matchAll(/\(([^)]+)\)/g)];
  for (const m of parenMatches) {
    const alias = normalizeText(m[1] ?? "");
    if (!alias || /^\d{4}$/.test(alias)) continue;
    if (alias === q) {
      score += 35;
      break;
    }
    if (alias.includes(q) || q.includes(alias)) {
      score += 20;
      break;
    }
  }

  const meta = parseMovieMeta(rawTitle, result.description ?? "");
  if (meta.kind === "watch") score += 15;
  if (meta.kind === "trailer") score -= 25;
  if (meta.year) score += 2;
  if (meta.kp || meta.imdb) score += 2;
  // Feature-film signal: year + ratings together beats a bare title match.
  if (meta.year && (meta.kp || meta.imdb)) score += 12;

  // Demote Artist: Track / music-video style hits that share a song title with a film.
  if (MUSIC_TITLE_RE.test(rawTitle.trim()) || MUSIC_META_RE.test(haystack)) {
    score -= 35;
  }

  return score;
}

export function rankInlineResults(
  query: string,
  results: InlineResultLike[],
  alternativesLimit = 5,
): { best: RankedMatch | null; alternatives: RankedMatch[] } {
  const ranked = results
    .map((result) => {
      const meta = parseMovieMeta(result.title ?? "", result.description ?? "");
      return {
        ...meta,
        resultId: result.id,
        score: scoreMatch(query, result),
        rawTitle: result.title ?? "",
        rawDescription: result.description ?? "",
        thumbUrl: result.thumbUrl,
      } satisfies RankedMatch;
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.rawTitle.localeCompare(b.rawTitle));

  const best = ranked[0] ?? null;
  const alternatives = ranked.slice(1, alternativesLimit + 1);
  return { best, alternatives };
}

export function extractButtonsFromMarkup(
  markup: unknown,
  options: { messageId?: number; markupKind?: "inline" | "reply" } = {},
): ButtonLike[] {
  if (!markup || typeof markup !== "object") return [];

  const buttons: ButtonLike[] = [];
  const maybeRows = (markup as { rows?: unknown; keyboard?: unknown }).rows
    ?? (markup as { keyboard?: unknown }).keyboard
    ?? (markup as { inlineKeyboard?: unknown }).inlineKeyboard;

  // GramJS ReplyKeyboardMarkup / KeyboardButton rows, or JSON-ish shapes.
  const rows = Array.isArray(maybeRows)
    ? maybeRows
    : Array.isArray((markup as { buttons?: unknown }).buttons)
      ? (markup as { buttons: unknown[] }).buttons
      : [];

  for (const row of rows) {
    const cells = Array.isArray(row)
      ? row
      : Array.isArray((row as { buttons?: unknown }).buttons)
        ? (row as { buttons: unknown[] }).buttons
        : [row];

    for (const cell of cells) {
      if (!cell || typeof cell !== "object") continue;
      const text =
        typeof (cell as { text?: unknown }).text === "string"
          ? (cell as { text: string }).text.trim()
          : "";
      if (!text) continue;

      const rawData =
        (cell as { data?: unknown }).data !== undefined
          ? (cell as { data?: unknown }).data
          : (cell as { callbackData?: unknown }).callbackData;
      const dataBytes = copyCallbackBytes(rawData);

      const inferredKind: ButtonLike["kind"] =
        options.markupKind ?? (dataBytes ? "inline" : "reply");
      buttons.push({
        text,
        dataBytes,
        kind: inferredKind,
        messageId: options.messageId,
      });
    }
  }

  return buttons;
}

/** Copy opaque callback bytes without UTF-8 encode/decode. */
export function copyCallbackBytes(data: unknown): Buffer | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === "string") {
    // Fixtures / JSON only — live GramJS data is bytes.
    if (data.length === 0) return undefined;
    return Buffer.from(data, "utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.length === 0 ? undefined : Buffer.from(data);
  }
  if (data instanceof Uint8Array) {
    return data.length === 0 ? undefined : Buffer.from(data);
  }
  if (data && typeof data === "object") {
    const maybe = data as { buffer?: ArrayBuffer };
    if (maybe.buffer instanceof ArrayBuffer) {
      const buf = Buffer.from(new Uint8Array(maybe.buffer));
      return buf.length === 0 ? undefined : buf;
    }
    if (Array.isArray(data)) {
      const buf = Buffer.from(data as number[]);
      return buf.length === 0 ? undefined : buf;
    }
  }
  return undefined;
}

/** Compact keyboard dump for FindvidError messages (live debug). */
export function formatKeyboardDebug(
  buttons: ButtonLike[],
  options: { messageId?: number } = {},
): string {
  const idPart = options.messageId !== undefined ? `msg#${options.messageId} ` : "";
  if (buttons.length === 0) return `${idPart}buttons=[]`;
  const parts = buttons.map((b) => {
    const dataFlag = hasCallbackData(b)
      ? `data=${b.dataBytes!.length}b`
      : "data=no";
    return `"${b.text}"(${b.kind},${dataFlag})`;
  });
  return `${idPart}buttons=[${parts.join(", ")}]`;
}

/** Strip leading selection / status emoji so labels normalize cleanly. */
export function stripButtonDecorators(text: string): string {
  return text
    .replace(/^[\s✔️✅☑️✓✔☑️●○◆◇▶►⭐️⭐🔔🎶🔮❤️😭📱📺ℹ️👌🕔🔍🔼🔽🔙⬅️➡️⏭️◀️▶️✖️❌]+/u, "")
    .trim();
}

function labelCore(text: string): string {
  return normalizeText(stripButtonDecorators(text));
}

/** True for top-level chrome / support labels (Озвучка, Качество, Поиск, …). */
export function isChromeButton(button: ButtonLike): boolean {
  const t = labelCore(button.text);
  if (!t) return false;
  return CHROME_LABEL_RE.test(t);
}

/** True for persistent bot-home / search reply-keyboard labels. */
export function isBotHomeButton(button: ButtonLike): boolean {
  const t = labelCore(button.text);
  if (!t) return false;
  return BOT_HOME_LABEL_RE.test(t);
}

/** True for back / hide / cancel style navigation. */
export function isNavButton(button: ButtonLike): boolean {
  const t = labelCore(button.text);
  if (!t) return false;
  if (NAV_LABEL_RE.test(t)) return true;
  if (/^[✖️❌⬅️➡️⏭️◀️▶️🔙🔼🔽]+$/u.test(button.text.trim())) return true;
  return false;
}

/**
 * Filter out navigation, chrome, and bot-home buttons that are not content choices.
 * Voiceover studio names and Nx p quality labels remain.
 */
export function isChoiceButton(button: ButtonLike): boolean {
  const t = labelCore(button.text);
  if (!t) return false;
  if (isNavButton(button)) return false;
  if (isChromeButton(button)) return false;
  if (isBotHomeButton(button)) return false;
  if (GUIDE_TEXT_RE.test(t)) return false;
  return true;
}

export function listChoiceButtons(buttons: ButtonLike[]): ButtonLike[] {
  return buttons.filter(isChoiceButton);
}

/**
 * Sticky Findvid reply keyboard (Подборки / Фильтр / Настройки / VIP / …).
 * Must never be treated as озвучки or movie-card chrome.
 */
export function looksLikeBotHomeKeyboard(buttons: ButtonLike[]): boolean {
  if (buttons.length === 0) return false;
  // Movie chrome wins if Озвучка/Качество are present.
  const hasVoiceoverMenu = buttons.some((b) => VOICEOVER_MENU_RE.test(labelCore(b.text)));
  const hasQualityMenu = buttons.some((b) => QUALITY_MENU_RE.test(labelCore(b.text)));
  if (hasVoiceoverMenu || hasQualityMenu) return false;
  const homeHits = buttons.filter(isBotHomeButton).length;
  if (homeHits === 0) return false;
  // Majority home labels, or any home labels with zero real content choices.
  return homeHits >= Math.ceil(buttons.length / 2) || listChoiceButtons(buttons).length === 0;
}

/** Movie-card chrome menu: contains Озвучка and/or Качество openers. */
export function looksLikeChromeMenu(buttons: ButtonLike[]): boolean {
  if (buttons.length === 0) return false;
  if (looksLikeBotHomeKeyboard(buttons)) return false;
  const hasVoiceoverMenu = buttons.some((b) => VOICEOVER_MENU_RE.test(labelCore(b.text)));
  const hasQualityMenu = buttons.some((b) => QUALITY_MENU_RE.test(labelCore(b.text)));
  if (!hasVoiceoverMenu && !hasQualityMenu) return false;
  // Real voiceover lists never include the Озвучка/Качество openers themselves.
  const chromeHits = buttons.filter(isChromeButton).length;
  return chromeHits >= 2 || (chromeHits >= 1 && listChoiceButtons(buttons).length === 0);
}

/**
 * Message is usable for voiceover/quality automation (movie chrome or nested lists),
 * not the sticky bot-home reply keyboard.
 */
export function looksLikeMovieCardButtons(buttons: ButtonLike[]): boolean {
  if (looksLikeBotHomeKeyboard(buttons)) return false;
  return (
    looksLikeChromeMenu(buttons) ||
    looksLikeVoiceoverButtons(buttons) ||
    looksLikeQualityButtons(buttons)
  );
}

export function findVoiceoverMenuButton(buttons: ButtonLike[]): ButtonLike | null {
  return (
    buttons.find((b) => VOICEOVER_MENU_RE.test(labelCore(b.text)) && isChromeButton(b)) ??
    buttons.find((b) => VOICEOVER_MENU_RE.test(labelCore(b.text))) ??
    null
  );
}

export function findQualityMenuButton(buttons: ButtonLike[]): ButtonLike | null {
  return (
    buttons.find((b) => QUALITY_MENU_RE.test(labelCore(b.text)) && isChromeButton(b)) ??
    buttons.find((b) => QUALITY_MENU_RE.test(labelCore(b.text))) ??
    null
  );
}

/** Recovery control on the sticky reply keyboard. */
export function findSearchResultRecoveryButton(buttons: ButtonLike[]): ButtonLike | null {
  return buttons.find((b) => SEARCH_RESULT_RECOVERY_RE.test(labelCore(b.text))) ?? null;
}

export function pickPreferredButton(
  buttons: ButtonLike[],
  preferences: string[],
): ButtonLike | null {
  const choices = listChoiceButtons(buttons);
  if (choices.length === 0) return null;

  for (const pref of preferences) {
    const nPref = normalizeText(pref);
    if (!nPref) continue;
    const exact = choices.find((b) => labelCore(b.text) === nPref);
    if (exact) return exact;
    const partial = choices.find((b) => labelCore(b.text).includes(nPref));
    if (partial) return partial;
  }
  return choices[0] ?? null;
}

export function pickVoiceoverButton(
  buttons: ButtonLike[],
  preferred = "Дублированный",
  override?: string,
): ButtonLike | null {
  // Never fall back to chrome / bot-home labels as "voiceovers".
  if (looksLikeChromeMenu(buttons) || looksLikeBotHomeKeyboard(buttons)) return null;
  const prefs = override
    ? [override, preferred]
    : [preferred, "дубляж", "дублирован", "official", "hdrezka"];
  return pickPreferredButton(buttons, prefs);
}

export function pickQualityButton(
  buttons: ButtonLike[],
  preferredQualities: string[] = ["1080p", "720p", "480p"],
  override?: string,
): ButtonLike | null {
  if (looksLikeChromeMenu(buttons) || looksLikeBotHomeKeyboard(buttons)) return null;
  const choices = listChoiceButtons(buttons);
  if (choices.length === 0) return null;

  if (override) {
    const hit = pickPreferredButton(choices, [override]);
    if (hit) return hit;
  }

  // Prefer explicit quality labels in priority order.
  for (const q of preferredQualities) {
    const hit = pickPreferredButton(choices, [q]);
    if (hit) return hit;
  }

  // Fallback: highest Nx p among buttons.
  const withQuality = choices
    .map((b) => {
      const m = stripButtonDecorators(b.text).match(QUALITY_RE);
      return { button: b, height: m ? Number.parseInt(m[1], 10) : 0 };
    })
    .filter((x) => x.height > 0)
    .sort((a, b) => b.height - a.height);

  if (withQuality.length > 0) return withQuality[0].button;
  // Do not fall back to non-quality chrome leftovers (e.g. Инструкция).
  return null;
}

export function looksLikeVoiceoverButtons(buttons: ButtonLike[]): boolean {
  if (looksLikeChromeMenu(buttons) || looksLikeBotHomeKeyboard(buttons)) return false;
  const choices = listChoiceButtons(buttons);
  if (choices.length === 0) return false;
  if (looksLikeQualityButtons(buttons)) return false;
  return true;
}

export function looksLikeQualityButtons(buttons: ButtonLike[]): boolean {
  if (looksLikeChromeMenu(buttons) || looksLikeBotHomeKeyboard(buttons)) return false;
  const choices = listChoiceButtons(buttons);
  if (choices.length === 0) return false;
  const qualityHits = choices.filter((b) =>
    QUALITY_RE.test(stripButtonDecorators(b.text)),
  ).length;
  return qualityHits >= Math.ceil(choices.length / 2) || qualityHits >= 1;
}

/** Heuristic: reject tiny howto / guide videos when a multi-GB film was expected. */
export function looksLikeGuideMedia(options: {
  fileName?: string;
  fileSize?: number;
  durationSeconds?: number;
  captionPreview?: string;
  text?: string;
}): boolean {
  const blob = `${options.fileName ?? ""} ${options.captionPreview ?? ""} ${options.text ?? ""}`;
  if (GUIDE_TEXT_RE.test(blob)) return true;
  const size = options.fileSize;
  const duration = options.durationSeconds;
  if (size !== undefined && size > 0 && size < MIN_FILM_FILE_BYTES) {
    if (duration === undefined || duration < MIN_FILM_DURATION_SECONDS) return true;
  }
  return false;
}

export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
