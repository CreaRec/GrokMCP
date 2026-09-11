import { parseAccessUrl, redactSecrets, type ParsedAccessUrl } from "./access-url.js";
import { unixToIsoOrNull } from "./dates.js";

export type FetchFn = typeof fetch;

export interface SimplefinClientOptions {
  accessUrl: string;
  timeoutMs?: number;
  fetchImpl?: FetchFn;
}

export interface SimplefinOrg {
  name: string | null;
  domain: string | null;
}

export interface SimplefinAccountSummary {
  id: string;
  name: string;
  currency: string;
  balance: string;
  "available-balance": string | null;
  "balance-date": string | null;
  org: SimplefinOrg;
}

export interface ListAccountsResult {
  accounts: SimplefinAccountSummary[];
  errors?: unknown;
  errlist?: unknown;
}

export interface SimplefinTransaction {
  id: string;
  posted: string | null;
  amount: string;
  description: string;
  payee: string | null;
  memo: string | null;
  account_id: string;
  account_name: string;
  pending?: boolean;
}

export interface GetTransactionsResult {
  transactions: SimplefinTransaction[];
  range: { start: string; end: string; start_date: number; end_date: number };
  errors?: unknown;
  errlist?: unknown;
}

export interface GetTransactionsQuery {
  startDateUnix: number;
  endDateUnix: number;
  startYmd: string;
  endYmd: string;
  account?: string | string[];
  pending?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function asOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function domainFromUrl(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost) return null;
  try {
    const withScheme = /^https?:\/\//i.test(urlOrHost)
      ? urlOrHost
      : `https://${urlOrHost}`;
    return new URL(withScheme).hostname || urlOrHost;
  } catch {
    return urlOrHost;
  }
}

function orgFromAccountAndConnections(
  account: Record<string, unknown>,
  connectionsById: Map<string, Record<string, unknown>>,
): SimplefinOrg {
  const orgRaw = account.org;
  if (isPlainObject(orgRaw)) {
    return {
      name: asOptionalString(orgRaw.name),
      domain:
        asOptionalString(orgRaw.domain) ??
        domainFromUrl(asOptionalString(orgRaw.url) ?? asOptionalString(orgRaw["sfin-url"])),
    };
  }

  const connId = asOptionalString(account.conn_id);
  const conn = connId ? connectionsById.get(connId) : undefined;
  if (conn) {
    return {
      name:
        asOptionalString(conn.org_name) ??
        asOptionalString(conn.name),
      domain: domainFromUrl(
        asOptionalString(conn.org_url) ?? asOptionalString(conn.sfin_url),
      ),
    };
  }

  return { name: null, domain: null };
}

function buildConnectionsMap(body: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const list = body.connections;
  if (!Array.isArray(list)) return map;
  for (const entry of list) {
    if (!isPlainObject(entry)) continue;
    const id = asOptionalString(entry.conn_id);
    if (id) map.set(id, entry);
  }
  return map;
}

function normalizeAccountIds(account?: string | string[]): string[] {
  if (account === undefined) return [];
  const list = Array.isArray(account) ? account : [account];
  return list.map((id) => id.trim()).filter((id) => id.length > 0);
}

export class SimplefinApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimplefinApiError";
  }
}

async function fetchAccountsJson(
  parsed: ParsedAccessUrl,
  query: URLSearchParams,
  options: { timeoutMs: number; fetchImpl: FetchFn; accessUrl: string },
): Promise<Record<string, unknown>> {
  const url = `${parsed.baseUrl}/accounts?${query.toString()}`;
  const safeUrl = `${parsed.host}/accounts?${query.toString()}`;

  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: parsed.authorizationHeader,
      },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const safe = redactSecrets(message, {
      accessUrl: options.accessUrl,
      username: parsed.username,
      password: parsed.password,
    });
    if (/timeout|aborted|AbortError/i.test(message)) {
      throw new SimplefinApiError(
        `SimpleFIN API request timed out after ${options.timeoutMs}ms (${safeUrl})`,
      );
    }
    throw new SimplefinApiError(`SimpleFIN API unreachable (${safeUrl}): ${safe}`);
  }

  if (!response.ok) {
    throw new SimplefinApiError(
      `SimpleFIN API returned HTTP ${response.status} ${response.statusText} for ${safeUrl}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new SimplefinApiError(
      `SimpleFIN API returned non-JSON content (${contentType || "unknown"}) from ${safeUrl}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SimplefinApiError(`SimpleFIN API returned invalid JSON from ${safeUrl}`);
  }

  if (!isPlainObject(body)) {
    throw new SimplefinApiError(
      `SimpleFIN API returned unexpected payload from ${safeUrl} (expected an account set object)`,
    );
  }

  return body;
}

function shapeAccounts(body: Record<string, unknown>): ListAccountsResult {
  const connectionsById = buildConnectionsMap(body);
  const accountsRaw = body.accounts;
  if (!Array.isArray(accountsRaw)) {
    throw new SimplefinApiError("SimpleFIN API response missing accounts array");
  }

  const accounts: SimplefinAccountSummary[] = accountsRaw.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new SimplefinApiError(`SimpleFIN API returned invalid account at index ${index}`);
    }
    const id = asString(entry.id);
    if (!id) {
      throw new SimplefinApiError(`SimpleFIN API returned account without id at index ${index}`);
    }
    return {
      id,
      name: asString(entry.name, id),
      currency: asString(entry.currency, "USD"),
      balance: asString(entry.balance, "0"),
      "available-balance": asOptionalString(entry["available-balance"]),
      "balance-date": unixToIsoOrNull(entry["balance-date"]),
      org: orgFromAccountAndConnections(entry, connectionsById),
    };
  });

  const result: ListAccountsResult = { accounts };
  if (body.errors !== undefined) {
    result.errors = body.errors;
  }
  if (body.errlist !== undefined) {
    result.errlist = body.errlist;
  }
  return result;
}

function shapeTransactions(
  body: Record<string, unknown>,
  query: GetTransactionsQuery,
): GetTransactionsResult {
  const accountsRaw = body.accounts;
  if (!Array.isArray(accountsRaw)) {
    throw new SimplefinApiError("SimpleFIN API response missing accounts array");
  }

  const transactions: SimplefinTransaction[] = [];
  for (const [index, entry] of accountsRaw.entries()) {
    if (!isPlainObject(entry)) {
      throw new SimplefinApiError(`SimpleFIN API returned invalid account at index ${index}`);
    }
    const accountId = asString(entry.id);
    const accountName = asString(entry.name, accountId);
    const txns = entry.transactions;
    if (txns === undefined || txns === null) continue;
    if (!Array.isArray(txns)) {
      throw new SimplefinApiError(
        `SimpleFIN API returned invalid transactions for account ${accountId || index}`,
      );
    }
    for (const txn of txns) {
      if (!isPlainObject(txn)) continue;
      const id = asString(txn.id);
      if (!id) continue;
      const pending = txn.pending === true;
      const posted = unixToIsoOrNull(txn.posted);
      transactions.push({
        id,
        posted: pending && !posted ? null : posted,
        amount: asString(txn.amount, "0"),
        description: asString(txn.description),
        payee: asOptionalString(txn.payee),
        memo: asOptionalString(txn.memo),
        account_id: accountId,
        account_name: accountName,
        ...(pending ? { pending: true } : {}),
      });
    }
  }

  const result: GetTransactionsResult = {
    transactions,
    range: {
      start: query.startYmd,
      end: query.endYmd,
      start_date: query.startDateUnix,
      end_date: query.endDateUnix,
    },
  };
  if (body.errors !== undefined) {
    result.errors = body.errors;
  }
  if (body.errlist !== undefined) {
    result.errlist = body.errlist;
  }
  return result;
}

export async function listAccounts(
  options: SimplefinClientOptions,
): Promise<ListAccountsResult> {
  const parsed = parseAccessUrl(options.accessUrl);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = new URLSearchParams({
    version: "2",
    "balances-only": "1",
  });
  const body = await fetchAccountsJson(parsed, query, {
    timeoutMs,
    fetchImpl,
    accessUrl: options.accessUrl,
  });
  return shapeAccounts(body);
}

export async function getTransactions(
  options: SimplefinClientOptions & { query: GetTransactionsQuery },
): Promise<GetTransactionsResult> {
  const parsed = parseAccessUrl(options.accessUrl);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = new URLSearchParams({
    version: "2",
    "start-date": String(options.query.startDateUnix),
    "end-date": String(options.query.endDateUnix),
  });
  if (options.query.pending) {
    query.set("pending", "1");
  }
  for (const accountId of normalizeAccountIds(options.query.account)) {
    query.append("account", accountId);
  }

  const body = await fetchAccountsJson(parsed, query, {
    timeoutMs,
    fetchImpl,
    accessUrl: options.accessUrl,
  });
  return shapeTransactions(body, options.query);
}
