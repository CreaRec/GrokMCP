/**
 * America/Chicago calendar day bounds → Unix epoch for SimpleFIN start-date / end-date.
 * SimpleFIN: start-date inclusive, end-date exclusive.
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_TRANSACTION_RANGE_DAYS = 90;
export const DEFAULT_TIME_ZONE = "America/Chicago";

export class DateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateRangeError";
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseYmd(value: string): { year: number; month: number; day: number } {
  if (!DATE_RE.test(value)) {
    throw new DateRangeError(`Invalid date "${value}". Use YYYY-MM-DD.`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) {
    throw new DateRangeError(`Invalid date "${value}". Month must be 01-12.`);
  }
  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) {
    throw new DateRangeError(
      `Invalid date "${value}". Day must be 01-${pad2(maxDay)}.`,
    );
  }
  return { year, month, day };
}

/**
 * Unix seconds at local midnight for YYYY-MM-DD in the given IANA timezone.
 */
export function zonedMidnightUnix(
  ymd: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): number {
  const { year, month, day } = parseYmd(ymd);
  // Guess UTC noon then correct by observed local offset (handles DST).
  const guess = Date.UTC(year, month - 1, day, 12, 0, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(new Date(guess));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) {
      throw new DateRangeError(`Unable to resolve ${type} in timezone ${timeZone}`);
    }
    return Number(value);
  };

  const asLocalMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  const offsetMs = asLocalMs - guess;
  // Local midnight = target civil date 00:00 in zone → UTC
  const targetUtcNoon = Date.UTC(year, month - 1, day, 12, 0, 0);
  const midnightUtcMs = targetUtcNoon - offsetMs - 12 * 60 * 60 * 1000;
  return Math.floor(midnightUtcMs / 1000);
}

/** Inclusive calendar-day difference: endYmd - startYmd in whole days. */
export function calendarDayDiff(startYmd: string, endYmd: string): number {
  const start = parseYmd(startYmd);
  const end = parseYmd(endYmd);
  const startUtc = Date.UTC(start.year, start.month - 1, start.day);
  const endUtc = Date.UTC(end.year, end.month - 1, end.day);
  return Math.round((endUtc - startUtc) / 86_400_000);
}

export interface TransactionDateBounds {
  startYmd: string;
  endYmd: string;
  /** Inclusive Unix start-date. */
  startDateUnix: number;
  /** Exclusive Unix end-date. */
  endDateUnix: number;
  rangeDays: number;
}

/**
 * Validate start/end YYYY-MM-DD and convert to SimpleFIN Unix bounds (Chicago midnight).
 * Rejects ranges longer than 90 calendar days (end exclusive → max end-start = 90).
 */
export function resolveTransactionDateBounds(
  start: string,
  end: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): TransactionDateBounds {
  parseYmd(start);
  parseYmd(end);

  const rangeDays = calendarDayDiff(start, end);
  if (rangeDays < 0) {
    throw new DateRangeError(
      `Invalid range: start (${start}) must be on or before end (${end}).`,
    );
  }
  if (rangeDays > MAX_TRANSACTION_RANGE_DAYS) {
    throw new DateRangeError(
      `Date range exceeds SimpleFIN limit of ${MAX_TRANSACTION_RANGE_DAYS} days ` +
        `(requested ${rangeDays} days from ${start} to ${end}). ` +
        `Use an end date at most ${MAX_TRANSACTION_RANGE_DAYS} days after start.`,
    );
  }

  return {
    startYmd: start,
    endYmd: end,
    startDateUnix: zonedMidnightUnix(start, timeZone),
    endDateUnix: zonedMidnightUnix(end, timeZone),
    rangeDays,
  };
}

/** Convert Unix epoch seconds to ISO-8601, or null when posted is 0 / missing (pending). */
export function unixToIsoOrNull(posted: unknown): string | null {
  if (posted === null || posted === undefined) return null;
  const n = typeof posted === "number" ? posted : Number(posted);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}
