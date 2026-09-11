import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TEST_ACCESS_BASE,
  TEST_ACCESS_PASS,
  TEST_ACCESS_USER,
  buildTestAccessUrl,
} from "./test-access-url.js";

const ACCESS_URL = buildTestAccessUrl();

describe("getConfig", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when SIMPLEFIN_ACCESS_URL is unset", async () => {
    vi.unstubAllEnvs();
    const { getConfig } = await import("./config.js");
    expect(() => getConfig()).toThrow(/SIMPLEFIN_ACCESS_URL is not set/);
  });

  it("reads access URL and defaults", async () => {
    vi.stubEnv("SIMPLEFIN_ACCESS_URL", ACCESS_URL);
    const { getConfig } = await import("./config.js");
    const config = getConfig();
    expect(config.timeoutMs).toBe(15_000);
    expect(config.timeZone).toBe("America/Chicago");
    expect(config.accessUrl).toBe(ACCESS_URL);
  });
});

describe("listAccounts / getTransactions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("SIMPLEFIN_ACCESS_URL", ACCESS_URL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("list_accounts calls balances-only version=2 and shapes accounts + errors", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain(`${TEST_ACCESS_BASE}/accounts?`);
      expect(url).toContain("version=2");
      expect(url).toContain("balances-only=1");
      expect(url).not.toContain(TEST_ACCESS_PASS);
      expect(url).not.toContain(`${TEST_ACCESS_USER}:`);
      expect(init?.headers).toMatchObject({
        Authorization: expect.stringMatching(/^Basic /),
      });
      return Response.json(
        {
          errors: ["Connection warning"],
          errlist: [{ code: "con.auth", msg: "Auth needed", conn_id: "C1" }],
          connections: [
            {
              conn_id: "C1",
              name: "My Bank - Demo",
              org_id: "ORG1",
              org_name: "My Bank",
              org_url: "https://mybank.example",
              sfin_url: "https://sfin.mybank.example",
            },
          ],
          accounts: [
            {
              id: "ACT-1",
              name: "Checking",
              conn_id: "C1",
              currency: "USD",
              balance: "100.23",
              "available-balance": "90.00",
              "balance-date": 1_700_000_000,
              transactions: [],
            },
          ],
        },
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { listAccounts } = await import("./config.js");
    const result = await listAccounts();
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      id: "ACT-1",
      name: "Checking",
      currency: "USD",
      balance: "100.23",
      "available-balance": "90.00",
      org: { name: "My Bank", domain: "mybank.example" },
    });
    expect(result.accounts[0]["balance-date"]).toBe(
      new Date(1_700_000_000 * 1000).toISOString(),
    );
    expect(result.errors).toEqual(["Connection warning"]);
    expect(result.errlist).toEqual([
      { code: "con.auth", msg: "Auth needed", conn_id: "C1" },
    ]);
  });

  it("get_transactions flattens txns and maps pending posted to null", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      expect(url).toContain("version=2");
      expect(url).toContain("start-date=");
      expect(url).toContain("end-date=");
      expect(url).toContain("pending=1");
      expect(url).toContain("account=ACT-1");
      expect(url).not.toContain(TEST_ACCESS_PASS);
      return Response.json(
        {
          errors: [],
          connections: [],
          accounts: [
            {
              id: "ACT-1",
              name: "Checking",
              currency: "USD",
              balance: "10.00",
              "balance-date": 1_700_000_000,
              transactions: [
                {
                  id: "TX-1",
                  posted: 1_700_000_100,
                  amount: "-12.34",
                  description: "Coffee",
                  payee: "Cafe",
                  memo: "latte",
                },
                {
                  id: "TX-2",
                  posted: 0,
                  amount: "-5.00",
                  description: "Pending charge",
                  pending: true,
                },
              ],
            },
          ],
        },
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getTransactions } = await import("./config.js");
    const result = await getTransactions({
      start: "2026-01-01",
      end: "2026-01-31",
      account: "ACT-1",
      pending: true,
    });

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({
      id: "TX-1",
      amount: "-12.34",
      description: "Coffee",
      payee: "Cafe",
      memo: "latte",
      account_id: "ACT-1",
      account_name: "Checking",
    });
    expect(result.transactions[0].posted).toBe(
      new Date(1_700_000_100 * 1000).toISOString(),
    );
    expect(result.transactions[1].posted).toBeNull();
    expect(result.transactions[1].pending).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects >90 day ranges before calling SimpleFIN", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { getTransactions } = await import("./config.js");
    await expect(
      getTransactions({ start: "2026-01-01", end: "2026-05-01" }),
    ).rejects.toThrow(/90 days/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never surfaces Access URL credentials in HTTP error messages", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error(`getaddrinfo ENOTFOUND for ${ACCESS_URL}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { listAccounts } = await import("./config.js");
    await expect(listAccounts()).rejects.toThrow(/SimpleFIN API unreachable/);
    try {
      await listAccounts();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(TEST_ACCESS_PASS);
      expect(message).not.toContain(ACCESS_URL);
      expect(message).not.toContain(`${TEST_ACCESS_USER}:${TEST_ACCESS_PASS}`);
    }
  });
});
