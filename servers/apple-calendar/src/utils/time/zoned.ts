export function formatLocal(date: Date, timeZone: string): string {
  const offset = fixedUtcOffsetMinutes(timeZone);
  if (offset !== null) {
    return new Date(date.getTime() + offset * 60_000).toLocaleString("en-US", {
      timeZone: "UTC",
    });
  }
  return date.toLocaleString("en-US", { timeZone });
}

/**
 * Parse Apple/ICS fixed-offset TZID labels into minutes east of UTC.
 * Examples: GMT-0500, UTC+05:30, +0530, -05:00. Null for IANA names.
 */
export function fixedUtcOffsetMinutes(timeZone: string): number | null {
  const t = timeZone.trim();
  const withMinutes = /^(?:(?:GMT|UTC)\s*)?([+-])(\d{2}):?(\d{2})$/i.exec(t);
  if (withMinutes) {
    const sign = withMinutes[1] === "-" ? -1 : 1;
    const hours = Number(withMinutes[2]);
    const minutes = Number(withMinutes[3]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (hours > 14 || minutes > 59) return null;
    return sign * (hours * 60 + minutes);
  }
  const hoursOnly = /^(?:GMT|UTC)\s*([+-])(\d{1,2})$/i.exec(t);
  if (hoursOnly) {
    const sign = hoursOnly[1] === "-" ? -1 : 1;
    const hours = Number(hoursOnly[2]);
    if (!Number.isFinite(hours) || hours > 14) return null;
    return sign * hours * 60;
  }
  return null;
}

function weekdayFromUtcMs(ms: number): number {
  const d = new Date(ms).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Parts of `date` interpreted in `timeZone`. */
export function zonedParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
} {
  const offset = fixedUtcOffsetMinutes(timeZone);
  if (offset !== null) {
    const local = new Date(date.getTime() + offset * 60_000);
    return {
      year: local.getUTCFullYear(),
      month: local.getUTCMonth() + 1,
      day: local.getUTCDate(),
      hour: local.getUTCHours(),
      minute: local.getUTCMinutes(),
      second: local.getUTCSeconds(),
      weekday: weekdayFromUtcMs(local.getTime()),
    };
  }

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayMap[parts.weekday ?? "Mon"] ?? 1,
  };
}

/**
 * Build a UTC Date for a civil datetime in `timeZone`.
 * Uses iterative offset correction (no extra deps).
 * Also accepts Apple fixed-offset labels like GMT-0500.
 */
export function zonedLocalToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  const offset = fixedUtcOffsetMinutes(timeZone);
  if (offset !== null) {
    return new Date(
      Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60_000,
    );
  }

  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, timeZone);
    const asUtc = Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      p.hour,
      p.minute,
      p.second,
    );
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    guess = new Date(guess.getTime() + (target - asUtc));
  }
  return guess;
}

export function addDaysLocal(date: Date, timeZone: string, days: number): Date {
  const p = zonedParts(date, timeZone);
  const noon = zonedLocalToUtc(timeZone, p.year, p.month, p.day, 12, 0, 0);
  const shifted = new Date(noon.getTime() + days * 24 * 60 * 60 * 1000);
  const sp = zonedParts(shifted, timeZone);
  return zonedLocalToUtc(
    timeZone,
    sp.year,
    sp.month,
    sp.day,
    p.hour,
    p.minute,
    p.second,
  );
}

export function localDateString(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

const HAS_EXPLICIT_TZ = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const NAIVE_LOCAL_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * Parse a tool datetime. Naive `YYYY-MM-DDTHH:MM[:SS]` (no Z/offset) is
 * wall time in `timeZone`. Explicit Z or ±HH:MM is an absolute instant.
 */
export function parseZonedDateTime(
  raw: string,
  timeZone: string,
): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (!HAS_EXPLICIT_TZ.test(trimmed)) {
    const m = NAIVE_LOCAL_RE.exec(trimmed);
    if (m) {
      return zonedLocalToUtc(
        timeZone,
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6] ?? 0),
      );
    }
  }

  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}
