import { describe, expect, it, vi } from "vitest";
import type { UtilityData } from "./dashboard-client.js";
import { fetchUtilities } from "./dashboard-client.js";
import {
  buildUtilityBillsResponse,
  formatMonthLabel,
  isBilledCost,
  summarizeUtility,
} from "./utility-bills.js";

const sampleUtilities: UtilityData[] = [
  {
    type: "electricity",
    label: "Electricity",
    unit: "kWh",
    currency: "USD",
    connected: true,
    readings: [
      { month: "2026-07", consumption: 890, cost: 145.32 },
      { month: "2026-06", consumption: 820, cost: 132.1 },
      { month: "2026-05", consumption: 760, cost: 118.5 },
    ],
  },
  {
    type: "water",
    label: "Water",
    unit: "gal",
    currency: "USD",
    connected: true,
    readings: [
      { month: "2026-07", consumption: 4200, cost: 58.4 },
      { month: "2026-06", consumption: 3900, cost: 52.1 },
    ],
  },
  {
    type: "gas",
    label: "Gas",
    unit: "therms",
    currency: "USD",
    connected: false,
    readings: [
      { month: "2026-07", consumption: 12, cost: 24.5 },
      { month: "2026-06", consumption: 8, cost: 18.0 },
    ],
  },
];

describe("utility-bills", () => {
  it("formats month labels in America/Chicago", () => {
    expect(formatMonthLabel("2026-07", "America/Chicago")).toBe("July 2026");
  });

  it("identifies billed costs", () => {
    expect(isBilledCost(10)).toBe(true);
    expect(isBilledCost(0)).toBe(false);
    expect(isBilledCost(null)).toBe(false);
  });

  it("builds last-vs-previous comparison for all three utilities", () => {
    const result = buildUtilityBillsResponse(sampleUtilities, {
      months: 2,
      timeZone: "America/Chicago",
      fetchedAt: new Date("2026-08-01T12:00:00.000Z"),
    });

    expect(result.timezone).toBe("America/Chicago");
    expect(result.utilities.electricity?.comparison.latest?.cost).toBe(145.32);
    expect(result.utilities.electricity?.comparison.previous?.cost).toBe(132.1);
    expect(result.utilities.electricity?.comparison.delta).toEqual({
      cost_absolute: 13.22,
      cost_percent: 10.01,
      consumption_absolute: 70,
    });
    expect(result.utilities.water?.comparison.latest?.month_label).toBe("July 2026");
    expect(result.utilities.gas?.connected).toBe(false);
    expect(result.utilities.electricity?.history).toHaveLength(2);
  });

  it("flags missing latest bill when newest month has zero cost", () => {
    const utilities: UtilityData[] = [
      {
        type: "electricity",
        label: "Electricity",
        currency: "USD",
        connected: true,
        readings: [
          { month: "2026-08", consumption: 0, cost: 0 },
          { month: "2026-07", consumption: 890, cost: 145.32 },
          { month: "2026-06", consumption: 820, cost: 132.1 },
        ],
      },
    ];

    const summary = summarizeUtility(utilities[0], "electricity", {
      months: 2,
      timeZone: "America/Chicago",
    });

    expect(summary?.latest_unbilled).toBe(true);
    expect(summary?.comparison.latest?.month).toBe("2026-07");
    expect(summary?.comparison.previous?.month).toBe("2026-06");
  });

  it("includes extended history when months > 2", () => {
    const result = buildUtilityBillsResponse(sampleUtilities, {
      months: 3,
      timeZone: "America/Chicago",
    });

    expect(result.utilities.electricity?.history).toHaveLength(3);
    expect(result.utilities.electricity?.comparison.latest?.month).toBe("2026-07");
  });
});

describe("fetchUtilities", () => {
  it("fetches and parses /api/utilities", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(sampleUtilities, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const data = await fetchUtilities({
      apiBaseUrl: "http://192.168.1.135:3080",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.168.1.135:3080/api/utilities",
      expect.objectContaining({ method: "GET" }),
    );
    expect(data).toHaveLength(3);
  });

  it("fails clearly when dashboard is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });

    await expect(
      fetchUtilities({
        apiBaseUrl: "http://192.168.1.135:3080",
        fetchImpl,
      }),
    ).rejects.toThrow(/unreachable/i);
  });

  it("fails on HTTP 500", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(
      fetchUtilities({
        apiBaseUrl: "http://192.168.1.135:3080",
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("fails on non-JSON response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("<html>error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(
      fetchUtilities({
        apiBaseUrl: "http://192.168.1.135:3080",
        fetchImpl,
      }),
    ).rejects.toThrow(/non-JSON/i);
  });

  it("fails on invalid JSON body", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      fetchUtilities({
        apiBaseUrl: "http://192.168.1.135:3080",
        fetchImpl,
      }),
    ).rejects.toThrow(/invalid JSON/i);
  });
});
