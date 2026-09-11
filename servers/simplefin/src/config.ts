import {
  getTransactions as fetchTransactions,
  listAccounts as fetchListAccounts,
  type GetTransactionsResult,
  type ListAccountsResult,
} from "./simplefin-client.js";
import {
  DEFAULT_TIME_ZONE,
  resolveTransactionDateBounds,
} from "./dates.js";
import { parseAccessUrl } from "./access-url.js";

export interface SimplefinConfig {
  accessUrl: string;
  timeoutMs: number;
  timeZone: string;
}

export function getAccessUrl(): string | undefined {
  const value = process.env.SIMPLEFIN_ACCESS_URL?.trim();
  return value ? value : undefined;
}

export function getConfig(): SimplefinConfig {
  const accessUrl = getAccessUrl();
  if (!accessUrl) {
    throw new Error("SIMPLEFIN_ACCESS_URL is not set");
  }
  // Validate shape early (throws AccessUrlError with safe message).
  parseAccessUrl(accessUrl);

  const timeoutRaw =
    process.env.SIMPLEFIN_TIMEOUT_MS?.trim() ||
    process.env.SIMPLEFIN_API_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("SIMPLEFIN_TIMEOUT_MS must be a positive integer");
  }

  return {
    accessUrl,
    timeoutMs,
    timeZone: process.env.USER_TIMEZONE?.trim() || DEFAULT_TIME_ZONE,
  };
}

export async function listAccounts(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ListAccountsResult> {
  const config = getConfig();
  return fetchListAccounts({
    accessUrl: config.accessUrl,
    timeoutMs: config.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
}

export interface GetTransactionsArgs {
  start: string;
  end: string;
  account?: string | string[];
  pending?: boolean;
}

export async function getTransactions(
  args: GetTransactionsArgs,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<GetTransactionsResult> {
  const config = getConfig();
  const bounds = resolveTransactionDateBounds(args.start, args.end, config.timeZone);
  return fetchTransactions({
    accessUrl: config.accessUrl,
    timeoutMs: config.timeoutMs,
    fetchImpl: options.fetchImpl,
    query: {
      startDateUnix: bounds.startDateUnix,
      endDateUnix: bounds.endDateUnix,
      startYmd: bounds.startYmd,
      endYmd: bounds.endYmd,
      account: args.account,
      pending: args.pending,
    },
  });
}
