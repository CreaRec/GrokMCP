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

  if (!Array.isArray(body)) {
    throw new Error(`CreaDashboard API returned unexpected payload from ${url}`);
  }

  return body as UtilityData[];
}
