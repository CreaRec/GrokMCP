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

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
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

export async function fetchUtilities(
  options: FetchUtilitiesOptions,
): Promise<UtilityData[]> {
  const { apiBaseUrl, timeoutMs = 10_000, fetchImpl = fetch } = options;
  const base = normalizeBaseUrl(apiBaseUrl);
  const url = `${base}/api/utilities`;

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

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`CreaDashboard API returned invalid JSON from ${url}`);
  }

  return parseUtilitiesPayload(body, url);
}
