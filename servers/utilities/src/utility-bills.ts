import type { UtilityData, UtilityReading } from "./dashboard-client.js";

export const UTILITY_TYPES = ["electricity", "water", "gas"] as const;
export type UtilityType = (typeof UTILITY_TYPES)[number];

export interface BillMonth {
  month: string;
  month_label: string;
  cost: number;
  consumption: number | null;
}

export interface BillDelta {
  cost_absolute: number;
  cost_percent: number | null;
  consumption_absolute: number | null;
}

export interface UtilityBillSummary {
  type: UtilityType;
  label: string;
  connected: boolean;
  currency: string | null;
  unit: string | null;
  latest_unbilled: boolean;
  comparison: {
    latest: BillMonth | null;
    previous: BillMonth | null;
    delta: BillDelta | null;
  };
  history: BillMonth[];
}

export interface UtilityBillsResult {
  fetched_at: string;
  timezone: string;
  utilities: Record<UtilityType, UtilityBillSummary | null>;
}

const MONTH_KEY_RE = /^(\d{4})-(\d{2})/;

export function parseMonthKey(month: string): Date | null {
  const trimmed = month.trim();
  const match = MONTH_KEY_RE.exec(trimmed);
  if (match) {
    const year = Number(match[1]);
    const mon = Number(match[2]);
    if (mon >= 1 && mon <= 12) {
      return new Date(Date.UTC(year, mon - 1, 15, 12, 0, 0));
    }
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatMonthLabel(month: string, timeZone: string): string {
  const date = parseMonthKey(month);
  if (!date) return month;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone,
  }).format(date);
}

export function isBilledCost(cost: number | null | undefined): cost is number {
  return typeof cost === "number" && Number.isFinite(cost) && cost > 0;
}

function sortReadingsDescending(readings: UtilityReading[]): UtilityReading[] {
  return [...readings].sort((a, b) => {
    const aDate = parseMonthKey(a.month);
    const bDate = parseMonthKey(b.month);
    if (aDate && bDate) return bDate.getTime() - aDate.getTime();
    if (aDate) return -1;
    if (bDate) return 1;
    return b.month.localeCompare(a.month);
  });
}

function toBillMonth(
  reading: UtilityReading,
  timeZone: string,
): BillMonth {
  return {
    month: reading.month,
    month_label: formatMonthLabel(reading.month, timeZone),
    cost: reading.cost ?? 0,
    consumption:
      typeof reading.consumption === "number" && Number.isFinite(reading.consumption)
        ? reading.consumption
        : null,
  };
}

function computeDelta(latest: BillMonth, previous: BillMonth): BillDelta {
  const costAbsolute = latest.cost - previous.cost;
  const costPercent =
    previous.cost > 0 ? (costAbsolute / previous.cost) * 100 : null;
  const consumptionAbsolute =
    latest.consumption !== null && previous.consumption !== null
      ? latest.consumption - previous.consumption
      : null;

  return {
    cost_absolute: round2(costAbsolute),
    cost_percent: costPercent === null ? null : round2(costPercent),
    consumption_absolute:
      consumptionAbsolute === null ? null : round2(consumptionAbsolute),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarizeUtility(
  utility: UtilityData | undefined,
  type: UtilityType,
  options: { months: number; timeZone: string },
): UtilityBillSummary | null {
  if (!utility) return null;

  const readings = sortReadingsDescending(utility.readings ?? []);
  const billedReadings = readings.filter((reading) => isBilledCost(reading.cost));
  const latestReading = readings[0];
  const latestUnbilled = Boolean(
    latestReading &&
      !isBilledCost(latestReading.cost) &&
      billedReadings.length > 0,
  );

  const historyCount = Math.max(2, Math.min(6, options.months));
  const history = billedReadings
    .slice(0, historyCount)
    .map((reading) => toBillMonth(reading, options.timeZone));

  const latest = billedReadings[0]
    ? toBillMonth(billedReadings[0], options.timeZone)
    : null;
  const previous = billedReadings[1]
    ? toBillMonth(billedReadings[1], options.timeZone)
    : null;
  const delta = latest && previous ? computeDelta(latest, previous) : null;

  return {
    type,
    label: utility.label || type,
    connected: utility.connected ?? false,
    currency: utility.currency ?? null,
    unit: utility.unit ?? null,
    latest_unbilled: latestUnbilled,
    comparison: { latest, previous, delta },
    history,
  };
}

export function buildUtilityBillsResponse(
  utilities: UtilityData[],
  options: { months: number; timeZone: string; fetchedAt?: Date },
): UtilityBillsResult {
  const byType = new Map<string, UtilityData>();
  for (const utility of utilities) {
    byType.set(utility.type, utility);
  }

  const result: Record<UtilityType, UtilityBillSummary | null> = {
    electricity: summarizeUtility(byType.get("electricity"), "electricity", options),
    water: summarizeUtility(byType.get("water"), "water", options),
    gas: summarizeUtility(byType.get("gas"), "gas", options),
  };

  return {
    fetched_at: (options.fetchedAt ?? new Date()).toISOString(),
    timezone: options.timeZone,
    utilities: result,
  };
}
