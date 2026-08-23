import {
  addDaysLocal,
  localDateString,
  zonedLocalToUtc,
  zonedParts,
} from "./zoned.js";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function todayLocalDate(timeZone: string, now = new Date()): string {
  return localDateString(now, timeZone);
}

export function addLocalDateDays(
  localDate: string,
  timeZone: string,
  days: number,
): string {
  const parsed = parseLocalDate(localDate);
  if (!parsed) throw new Error(`Invalid local date: ${localDate}`);
  const noon = zonedLocalToUtc(
    timeZone,
    parsed.year,
    parsed.month,
    parsed.day,
    12,
    0,
    0,
  );
  const shifted = addDaysLocal(noon, timeZone, days);
  return localDateString(shifted, timeZone);
}

export function parseLocalDate(
  value: string,
): { year: number; month: number; day: number } | null {
  const m = DATE_RE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = zonedLocalToUtc("UTC", year, month, day, 12, 0, 0);
  const p = zonedParts(probe, "UTC");
  if (p.year !== year || p.month !== month || p.day !== day) return null;
  return { year, month, day };
}

export function isValidLocalDate(value: string): boolean {
  return parseLocalDate(value) !== null;
}

/** Start of local calendar day as UTC Date. */
export function dayStartUtc(localDate: string, timeZone: string): Date {
  const parsed = parseLocalDate(localDate);
  if (!parsed) throw new Error(`Invalid local date: ${localDate}`);
  return zonedLocalToUtc(
    timeZone,
    parsed.year,
    parsed.month,
    parsed.day,
    0,
    0,
    0,
  );
}

/** Exclusive end of local calendar day as UTC Date (= next day 00:00). */
export function dayEndUtc(localDate: string, timeZone: string): Date {
  return dayStartUtc(addLocalDateDays(localDate, timeZone, 1), timeZone);
}
