export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-\d{2}$/;

export type WaterSyncStatus = "success" | "error" | "skipped" | string | null;

export interface WaterDailyPoint {
  date: string;
  gallons: number;
}

export interface WaterDailyApiResponse {
  connected: boolean;
  syncStatus: WaterSyncStatus;
  syncError: string | null;
  month: string;
  unit: string;
  readings: WaterDailyPoint[];
}

export interface WaterDailyRange {
  start: string;
  end: string;
}

export interface WaterDailyResult {
  range: WaterDailyRange;
  unit: string;
  connected: boolean;
  syncStatus: WaterSyncStatus;
  syncError: string | null;
  total_gallons: number;
  readings: WaterDailyPoint[];
}

export interface WaterDailyArgs {
  start?: string;
  end?: string;
  month?: string;
}

export class WaterDailyArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaterDailyArgError";
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatYmd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function getZonedDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) {
      throw new Error(`Unable to resolve ${type} in timezone ${timeZone}`);
    }
    return Number(value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
  };
}

export function parseYmd(value: string): { year: number; month: number; day: number } {
  if (!DATE_RE.test(value)) {
    throw new WaterDailyArgError(`Invalid date "${value}". Use YYYY-MM-DD.`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) {
    throw new WaterDailyArgError(`Invalid date "${value}". Month must be 01-12.`);
  }
  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) {
    throw new WaterDailyArgError(`Invalid date "${value}". Day must be 01-${pad2(maxDay)}.`);
  }
  return { year, month, day };
}

export function parseMonth(value: string): { year: number; month: number } {
  if (!MONTH_RE.test(value)) {
    throw new WaterDailyArgError(`Invalid month "${value}". Use YYYY-MM.`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12) {
    throw new WaterDailyArgError(`Invalid month "${value}". Month must be 01-12.`);
  }
  return { year, month };
}

export function resolveWaterDailyRange(
  args: WaterDailyArgs,
  timeZone: string,
  now: Date = new Date(),
): WaterDailyRange {
  const hasStart = args.start !== undefined;
  const hasEnd = args.end !== undefined;
  const hasMonth = args.month !== undefined;

  if (hasMonth && (hasStart || hasEnd)) {
    throw new WaterDailyArgError(
      'Provide either "month" (YYYY-MM) or "start"+"end" (YYYY-MM-DD), not both.',
    );
  }

  if (hasStart !== hasEnd) {
    throw new WaterDailyArgError('Both "start" and "end" are required when specifying a date range.');
  }

  if (hasMonth) {
    const { year, month } = parseMonth(args.month!);
    return {
      start: formatYmd(year, month, 1),
      end: formatYmd(year, month, daysInMonth(year, month)),
    };
  }

  if (hasStart && hasEnd) {
    const start = parseYmd(args.start!);
    const end = parseYmd(args.end!);
    const startKey = formatYmd(start.year, start.month, start.day);
    const endKey = formatYmd(end.year, end.month, end.day);
    if (startKey > endKey) {
      throw new WaterDailyArgError(`"start" (${startKey}) must be on or before "end" (${endKey}).`);
    }
    return { start: startKey, end: endKey };
  }

  const today = getZonedDateParts(now, timeZone);
  return {
    start: formatYmd(today.year, today.month, 1),
    end: formatYmd(today.year, today.month, daysInMonth(today.year, today.month)),
  };
}

/** First day of each calendar month that intersects [start, end], as YYYY-MM-DD anchors. */
export function monthAnchorsInRange(start: string, end: string): string[] {
  const from = parseYmd(start);
  const to = parseYmd(end);
  const anchors: string[] = [];

  let year = from.year;
  let month = from.month;
  while (year < to.year || (year === to.year && month <= to.month)) {
    anchors.push(formatYmd(year, month, 1));
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return anchors;
}

function roundGallons(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function buildWaterDailyResult(
  responses: WaterDailyApiResponse[],
  range: WaterDailyRange,
): WaterDailyResult {
  const byDate = new Map<string, number>();

  for (const response of responses) {
    for (const reading of response.readings ?? []) {
      if (typeof reading.date !== "string") continue;
      if (reading.date < range.start || reading.date > range.end) continue;
      const gallons =
        typeof reading.gallons === "number" && Number.isFinite(reading.gallons)
          ? reading.gallons
          : 0;
      byDate.set(reading.date, gallons);
    }
  }

  const readings = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, gallons]) => ({ date, gallons }));

  const total_gallons = roundGallons(
    readings.reduce((sum, reading) => sum + reading.gallons, 0),
  );

  const last = responses[responses.length - 1];
  return {
    range,
    unit: last?.unit || "gal",
    connected: responses.some((response) => response.connected === true),
    syncStatus: last?.syncStatus ?? null,
    syncError: last?.syncError ?? null,
    total_gallons,
    readings,
  };
}
