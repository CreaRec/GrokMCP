import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getConfig", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when DASHBOARD_API_URL is unset", async () => {
    vi.unstubAllEnvs();
    const { getConfig } = await import("./config.js");
    expect(() => getConfig()).toThrow(/DASHBOARD_API_URL is not set/);
  });

  it("reads dashboard URL and defaults", async () => {
    vi.stubEnv("DASHBOARD_API_URL", "http://192.168.1.135:3080");
    const { getConfig } = await import("./config.js");
    expect(getConfig()).toEqual({
      dashboardApiUrl: "http://192.168.1.135:3080",
      timeoutMs: 10_000,
      timeZone: "America/Chicago",
    });
  });
});

describe("getUtilityBills", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("DASHBOARD_API_URL", "http://192.168.1.135:3080");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns shaped utility bill data", async () => {
    const sample = [
      {
        type: "electricity",
        label: "Electricity",
        currency: "USD",
        connected: true,
        readings: [
          { month: "2026-07", consumption: 890, cost: 145.32 },
          { month: "2026-06", consumption: 820, cost: 132.1 },
        ],
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(sample, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { getUtilityBills } = await import("./config.js");
    const result = await getUtilityBills(2);
    expect(result.utilities.electricity?.comparison.latest?.cost).toBe(145.32);
  });
});
