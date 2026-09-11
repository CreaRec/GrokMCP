import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWaterDaily } from "./dashboard-client.js";
import {
  buildWaterDailyResult,
  monthAnchorsInRange,
  resolveWaterDailyRange,
  WaterDailyArgError,
  type WaterDailyApiResponse,
} from "./water-daily.js";

const julyPayload: WaterDailyApiResponse = {
  connected: true,
  syncStatus: "success",
  syncError: null,
  month: "2026-07",
  unit: "gal",
  readings: [
    { date: "2026-07-30", gallons: 100 },
    { date: "2026-07-31", gallons: 110 },
  ],
};

const augustPayload: WaterDailyApiResponse = {
  connected: true,
  syncStatus: "success",
  syncError: null,
  month: "2026-08",
  unit: "gal",
  readings: [
    { date: "2026-08-01", gallons: 120 },
    { date: "2026-08-02", gallons: 130 },
    { date: "2026-08-15", gallons: 140 },
  ],
};

describe("resolveWaterDailyRange", () => {
  it("defaults to the current calendar month in America/Chicago", () => {
    // 2026-09-11 18:00 UTC is still Sep 11 in Chicago (CDT)
    const range = resolveWaterDailyRange(
      {},
      "America/Chicago",
      new Date("2026-09-11T18:00:00.000Z"),
    );
    expect(range).toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });

  it("uses a single YYYY-MM month", () => {
    expect(resolveWaterDailyRange({ month: "2026-02" }, "America/Chicago")).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
  });

  it("accepts an inclusive start/end range", () => {
    expect(
      resolveWaterDailyRange(
        { start: "2026-07-30", end: "2026-08-02" },
        "America/Chicago",
      ),
    ).toEqual({ start: "2026-07-30", end: "2026-08-02" });
  });

  it("rejects mixing month with start/end", () => {
    expect(() =>
      resolveWaterDailyRange(
        { month: "2026-07", start: "2026-07-01", end: "2026-07-31" },
        "America/Chicago",
      ),
    ).toThrow(WaterDailyArgError);
  });

  it("rejects start without end", () => {
    expect(() =>
      resolveWaterDailyRange({ start: "2026-07-01" }, "America/Chicago"),
    ).toThrow(/Both "start" and "end"/);
  });

  it("rejects end before start", () => {
    expect(() =>
      resolveWaterDailyRange(
        { start: "2026-08-01", end: "2026-07-01" },
        "America/Chicago",
      ),
    ).toThrow(/on or before/);
  });

  it("rejects invalid date formats", () => {
    expect(() =>
      resolveWaterDailyRange({ month: "2026-7" }, "America/Chicago"),
    ).toThrow(/YYYY-MM/);
    expect(() =>
      resolveWaterDailyRange(
        { start: "2026/07/01", end: "2026-07-02" },
        "America/Chicago",
      ),
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      resolveWaterDailyRange(
        { start: "2026-02-30", end: "2026-03-01" },
        "America/Chicago",
      ),
    ).toThrow(/Invalid date/);
  });
});

describe("monthAnchorsInRange", () => {
  it("returns one anchor for a single month", () => {
    expect(monthAnchorsInRange("2026-07-01", "2026-07-31")).toEqual(["2026-07-01"]);
  });

  it("returns anchors for each intersecting month", () => {
    expect(monthAnchorsInRange("2026-07-30", "2026-09-02")).toEqual([
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
    ]);
  });
});

describe("buildWaterDailyResult", () => {
  it("filters, dedupes by date, and totals gallons", () => {
    const duplicateAugust: WaterDailyApiResponse = {
      ...augustPayload,
      readings: [
        ...augustPayload.readings,
        { date: "2026-08-01", gallons: 999 }, // later duplicate wins
      ],
    };

    const result = buildWaterDailyResult([julyPayload, duplicateAugust], {
      start: "2026-07-31",
      end: "2026-08-02",
    });

    expect(result.range).toEqual({ start: "2026-07-31", end: "2026-08-02" });
    expect(result.unit).toBe("gal");
    expect(result.connected).toBe(true);
    expect(result.syncStatus).toBe("success");
    expect(result.readings).toEqual([
      { date: "2026-07-31", gallons: 110 },
      { date: "2026-08-01", gallons: 999 },
      { date: "2026-08-02", gallons: 130 },
    ]);
    expect(result.total_gallons).toBe(1239);
  });
});

describe("fetchWaterDaily", () => {
  it("fetches /api/water/daily with a month anchor", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(julyPayload, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const data = await fetchWaterDaily({
      apiBaseUrl: "http://192.168.1.135:3080/",
      date: "2026-07-01",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.168.1.135:3080/api/water/daily?date=2026-07-01",
      expect.objectContaining({ method: "GET" }),
    );
    expect(data.month).toBe("2026-07");
    expect(data.readings).toHaveLength(2);
  });

  it("omits date query when no anchor is provided", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(julyPayload, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await fetchWaterDaily({
      apiBaseUrl: "http://192.168.1.135:3080",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.168.1.135:3080/api/water/daily",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fails clearly when dashboard is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });

    await expect(
      fetchWaterDaily({
        apiBaseUrl: "http://192.168.1.135:3080",
        date: "2026-07-01",
        fetchImpl,
      }),
    ).rejects.toThrow(/unreachable/i);
  });

  it("rejects unexpected payloads", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ connected: true }, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      fetchWaterDaily({
        apiBaseUrl: "http://192.168.1.135:3080",
        fetchImpl,
      }),
    ).rejects.toThrow(/readings array/i);
  });
});

describe("getWaterDaily", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("DASHBOARD_API_URL", "http://192.168.1.135:3080");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("fetches one month for month=YYYY-MM", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(augustPayload, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { getWaterDaily } = await import("./config.js");
    const result = await getWaterDaily({ month: "2026-08" }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.168.1.135:3080/api/water/daily?date=2026-08-01",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.range).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(result.total_gallons).toBe(390);
    expect(result.readings).toHaveLength(3);
  });

  it("aggregates multi-month ranges with filter and dedupe", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.includes("date=2026-07-01") ? julyPayload : augustPayload;
      return Response.json(payload, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { getWaterDaily } = await import("./config.js");
    const result = await getWaterDaily(
      { start: "2026-07-31", end: "2026-08-02" },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.readings.map((reading) => reading.date)).toEqual([
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
    expect(result.total_gallons).toBe(360);
  });

  it("defaults to the Chicago current month", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          connected: true,
          syncStatus: null,
          syncError: null,
          month: "2026-09",
          unit: "gal",
          readings: [{ date: "2026-09-01", gallons: 10 }],
        },
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const { getWaterDaily } = await import("./config.js");
    const result = await getWaterDaily(
      {},
      { fetchImpl, now: new Date("2026-09-11T18:00:00.000Z") },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.168.1.135:3080/api/water/daily?date=2026-09-01",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.range).toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });

  it("surfaces bad argument errors", async () => {
    const { getWaterDaily } = await import("./config.js");
    await expect(getWaterDaily({ start: "2026-07-01" })).rejects.toMatchObject({
      name: "WaterDailyArgError",
      message: expect.stringMatching(/Both "start" and "end"/),
    });
  });
});
