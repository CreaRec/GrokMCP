import type { WaterDailyApiResponse, WaterDailyPoint } from "./water-daily.js";

export interface UtilityReading {
  month: string;
  consumption?: number | null;
  cost?: number | null;
}

export interface UtilityData {
  type: string;
  label: string;
  unit?: string;
  currency?: string;
  connected?: boolean;
  currentConsumption?: number | null;
  currentCost?: number | null;
  readings?: UtilityReading[];
}

export type FetchFn = typeof fetch;

export interface FetchUtilitiesOptions {
  apiBaseUrl: string;
  timeoutMs?: number;
  fetchImpl?: FetchFn;
}

export interface FetchWaterDailyOptions {
  apiBaseUrl: string;
  /** Month anchor as YYYY-MM-DD. Omit for the dashboard's current local month. */
  date?: string;
  timeoutMs?: number;
  fetchImpl?: FetchFn;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function fetchDashboardJson(
  url: string,
  options: { timeoutMs: number; fetchImpl: FetchFn },
): Promise<unknown> {
  const { timeoutMs, fetchImpl } = options;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout|aborted|AbortError/i.test(message)) {
      throw new Error(`CreaDashboard API request timed out after ${timeoutMs}ms (${url})`);
    }
    throw new Error(`CreaDashboard API unreachable at ${url}: ${message}`);
  }

  if (!response.ok) {
    throw new Error(
      `CreaDashboard API returned HTTP ${response.status} ${response.statusText} for ${url}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      `CreaDashboard API returned non-JSON content (${contentType || "unknown"}) from ${url}`,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`CreaDashboard API returned invalid JSON from ${url}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUtilityDataValue(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && typeof value.label === "string";
}

function normalizeUtilityEntry(
  key: string,
  value: Record<string, unknown>,
): UtilityData {
  const type =
    typeof value.type === "string" && value.type.length > 0 ? value.type : key;
  return { ...(value as unknown as UtilityData), type };
}

function parseUtilitiesPayload(body: unknown, url: string): UtilityData[] {
  if (body === null || typeof body !== "object") {
    throw new Error(
      `CreaDashboard API returned unexpected payload from ${url} (expected an array or object of utilities)`,
    );
  }

  if (Array.isArray(body)) {
    return body as UtilityData[];
  }

  const utilities: UtilityData[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!isUtilityDataValue(value)) {
      throw new Error(
        `CreaDashboard API returned unexpected payload from ${url} (invalid utility entry for "${key}")`,
      );
    }
    utilities.push(normalizeUtilityEntry(key, value));
  }

  return utilities;
}

function parseWaterDailyPayload(body: unknown, url: string): WaterDailyApiResponse {
  if (!isPlainObject(body)) {
    throw new Error(
      `CreaDashboard API returned unexpected payload from ${url} (expected a water daily object)`,
    );
  }

  if (!Array.isArray(body.readings)) {
    throw new Error(
      `CreaDashboard API returned unexpected payload from ${url} (missing readings array)`,
    );
  }

  const readings: WaterDailyPoint[] = body.readings.map((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.date !== "string") {
      throw new Error(
        `CreaDashboard API returned unexpected payload from ${url} (invalid reading at index ${index})`,
      );
    }
    const gallons =
      typeof entry.gallons === "number" && Number.isFinite(entry.gallons)
        ? entry.gallons
        : 0;
    return { date: entry.date, gallons };
  });

  return {
    connected: Boolean(body.connected),
    syncStatus:
      body.syncStatus === undefined || body.syncStatus === null
        ? null
        : String(body.syncStatus),
    syncError:
      body.syncError === undefined || body.syncError === null
        ? null
        : String(body.syncError),
    month: typeof body.month === "string" ? body.month : "",
    unit: typeof body.unit === "string" && body.unit.length > 0 ? body.unit : "gal",
    readings,
  };
}

export async function fetchUtilities(
  options: FetchUtilitiesOptions,
): Promise<UtilityData[]> {
  const { apiBaseUrl, timeoutMs = 10_000, fetchImpl = fetch } = options;
  const base = normalizeBaseUrl(apiBaseUrl);
  const url = `${base}/api/utilities`;
  const body = await fetchDashboardJson(url, { timeoutMs, fetchImpl });
  return parseUtilitiesPayload(body, url);
}

export async function fetchWaterDaily(
  options: FetchWaterDailyOptions,
): Promise<WaterDailyApiResponse> {
  const { apiBaseUrl, date, timeoutMs = 10_000, fetchImpl = fetch } = options;
  const base = normalizeBaseUrl(apiBaseUrl);
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  const url = `${base}/api/water/daily${query}`;
  const body = await fetchDashboardJson(url, { timeoutMs, fetchImpl });
  return parseWaterDailyPayload(body, url);
}
