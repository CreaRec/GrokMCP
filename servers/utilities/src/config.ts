import { fetchUtilities, fetchWaterDaily } from "./dashboard-client.js";
import { buildUtilityBillsResponse } from "./utility-bills.js";
import {
  buildWaterDailyResult,
  monthAnchorsInRange,
  resolveWaterDailyRange,
  type WaterDailyArgs,
  type WaterDailyResult,
} from "./water-daily.js";

export interface UtilitiesConfig {
  dashboardApiUrl: string;
  timeoutMs: number;
  timeZone: string;
}

export function getDashboardApiUrl(): string | undefined {
  const value = process.env.DASHBOARD_API_URL?.trim();
  return value ? value : undefined;
}

export function getConfig(): UtilitiesConfig {
  const dashboardApiUrl = getDashboardApiUrl();
  if (!dashboardApiUrl) {
    throw new Error("DASHBOARD_API_URL is not set");
  }

  const timeoutRaw = process.env.DASHBOARD_API_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("DASHBOARD_API_TIMEOUT_MS must be a positive integer");
  }

  return {
    dashboardApiUrl,
    timeoutMs,
    timeZone: process.env.USER_TIMEZONE?.trim() || "America/Chicago",
  };
}

export async function getUtilityBills(months: number): Promise<ReturnType<typeof buildUtilityBillsResponse>> {
  const config = getConfig();
  const utilities = await fetchUtilities({
    apiBaseUrl: config.dashboardApiUrl,
    timeoutMs: config.timeoutMs,
  });

  return buildUtilityBillsResponse(utilities, {
    months,
    timeZone: config.timeZone,
  });
}

export async function getWaterDaily(
  args: WaterDailyArgs = {},
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<WaterDailyResult> {
  const config = getConfig();
  const range = resolveWaterDailyRange(args, config.timeZone, options.now);
  const anchors = monthAnchorsInRange(range.start, range.end);

  const responses = [];
  for (const date of anchors) {
    responses.push(
      await fetchWaterDaily({
        apiBaseUrl: config.dashboardApiUrl,
        timeoutMs: config.timeoutMs,
        date,
        fetchImpl: options.fetchImpl,
      }),
    );
  }

  return buildWaterDailyResult(responses, range);
}
