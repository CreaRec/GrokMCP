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
  /** Present for inline callback buttons. */
  data?: string;
  kind: "reply" | "inline";
}

const YEAR_RE = /\((\d{4})\)/;
const KP_RE = /(?:КП|KP|Kinopoisk|Кинопоиск)\s*[:\s]*([0-9]+(?:[.,][0-9]+)?)/i;
const IMDB_RE = /(?:IMDb?|IMDB)\s*[:\s]*([0-9]+(?:[.,][0-9]+)?)/i;
const QUALITY_RE = /^(\d{3,4})\s*p$/i;
const TRAILER_RE = /трейлер|trailer/i;
const WATCH_RE = /смотреть|watch/i;

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
  const title = normalizeText(result.title ?? "");
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

  const meta = parseMovieMeta(result.title ?? "", result.description ?? "");
  if (meta.kind === "watch") score += 15;
  if (meta.kind === "trailer") score -= 25;
  if (meta.year) score += 2;
  if (meta.kp || meta.imdb) score += 2;

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

export function extractButtonsFromMarkup(markup: unknown): ButtonLike[] {
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

      const data =
        typeof (cell as { data?: unknown }).data === "string"
          ? (cell as { data: string }).data
          : typeof (cell as { callbackData?: unknown }).callbackData === "string"
            ? (cell as { callbackData: string }).callbackData
            : Buffer.isBuffer((cell as { data?: unknown }).data)
              ? (cell as { data: Buffer }).data.toString("utf8")
              : undefined;

      const kind: ButtonLike["kind"] = data !== undefined ? "inline" : "reply";
      buttons.push({ text, data, kind });
    }
  }

  return buttons;
}

/** Filter out navigation / chrome buttons that are not content choices. */
export function isChoiceButton(button: ButtonLike): boolean {
  const t = normalizeText(button.text);
  if (!t) return false;
  if (/^(вернуться|назад|скрыт|отмена|cancel|back|hide|menu|меню|главн)/i.test(t)) {
    return false;
  }
  if (/^[✖️❌⬅️➡️⏭️◀️▶️]+$/u.test(button.text.trim())) return false;
  return true;
}

export function listChoiceButtons(buttons: ButtonLike[]): ButtonLike[] {
  return buttons.filter(isChoiceButton);
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
    const exact = choices.find((b) => normalizeText(b.text) === nPref);
    if (exact) return exact;
    const partial = choices.find((b) => normalizeText(b.text).includes(nPref));
    if (partial) return partial;
  }
  return choices[0] ?? null;
}

export function pickVoiceoverButton(
  buttons: ButtonLike[],
  preferred = "Дублированный",
  override?: string,
): ButtonLike | null {
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
      const m = b.text.trim().match(QUALITY_RE);
      return { button: b, height: m ? Number.parseInt(m[1], 10) : 0 };
    })
    .filter((x) => x.height > 0)
    .sort((a, b) => b.height - a.height);

  if (withQuality.length > 0) return withQuality[0].button;
  return choices[0] ?? null;
}

export function looksLikeVoiceoverButtons(buttons: ButtonLike[]): boolean {
  const choices = listChoiceButtons(buttons);
  if (choices.length === 0) return false;
  const qualityOnly = choices.every((b) => QUALITY_RE.test(b.text.trim()));
  return !qualityOnly;
}

export function looksLikeQualityButtons(buttons: ButtonLike[]): boolean {
  const choices = listChoiceButtons(buttons);
  if (choices.length === 0) return false;
  const qualityHits = choices.filter((b) => QUALITY_RE.test(b.text.trim())).length;
  return qualityHits >= Math.ceil(choices.length / 2) || qualityHits >= 1;
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
