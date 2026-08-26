import { describe, it, expect } from "vitest";
import { msUntilNextRun, zonedWallTimeToUtc } from "./schedule.js";

const TZ = "America/Chicago";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function hoursUntil(ms: number): number {
  return Math.round((ms / HOUR_MS) * 10) / 10;
}

describe("msUntilNextRun", () => {
  it("from 21:54 CDT waits ~23.1h until next 21:00 CDT (not 4.1h / 02:00)", () => {
    // Production miss: container started 2026-08-25T02:54:03Z = 21:54 CDT Aug 24
    // with INDEX_DAILY_AT=21:00, TZ=America/Chicago. Bug reported hours_until_run=4.1
    // and fired at 07:00Z (02:00 CDT). Correct wait is until 21:00 CDT Aug 25 = 02:00Z Aug 26.
    const now = new Date("2026-08-25T02:54:03.000Z");
    const ms = msUntilNextRun(21, 0, TZ, now);
    const target = new Date(now.getTime() + ms);

    expect(hoursUntil(ms)).toBe(23.1);
    expect(target.toISOString()).toBe("2026-08-26T02:00:00.000Z");
  });

  it("just after 21:00 CDT schedules tomorrow 21:00 CDT", () => {
    // 21:00:01 CDT on 2026-08-25 = 02:00:01Z Aug 26
    const now = new Date("2026-08-26T02:00:01.000Z");
    const ms = msUntilNextRun(21, 0, TZ, now);
    const target = new Date(now.getTime() + ms);

    expect(target.toISOString()).toBe("2026-08-27T02:00:00.000Z");
    expect(ms).toBeGreaterThan(23 * HOUR_MS);
    expect(ms).toBeLessThan(DAY_MS);
  });

  it("exactly at 21:00 CDT schedules tomorrow (run just fired)", () => {
    const now = new Date("2026-08-26T02:00:00.000Z");
    const ms = msUntilNextRun(21, 0, TZ, now);
    const target = new Date(now.getTime() + ms);

    expect(target.toISOString()).toBe("2026-08-27T02:00:00.000Z");
    expect(ms).toBe(DAY_MS);
  });

  it("before 21:00 CDT same day waits until tonight", () => {
    // 12:00 CDT Aug 25 = 17:00Z
    const now = new Date("2026-08-25T17:00:00.000Z");
    const ms = msUntilNextRun(21, 0, TZ, now);
    const target = new Date(now.getTime() + ms);

    expect(target.toISOString()).toBe("2026-08-26T02:00:00.000Z");
    expect(hoursUntil(ms)).toBe(9);
  });

  it("works when process TZ is UTC (independent of process.env.TZ)", () => {
    // Same instant as production start; result must not depend on process local TZ.
    const now = new Date("2026-08-25T02:54:03.000Z");
    const ms = msUntilNextRun(21, 0, TZ, now);
    expect(new Date(now.getTime() + ms).toISOString()).toBe(
      "2026-08-26T02:00:00.000Z",
    );
  });

  it("handles DST spring forward (23h day) correctly", () => {
    // US spring forward 2026: 2026-03-08 02:00 CST -> 03:00 CDT
    // From 21:00 CST on Mar 7 (= 03:00Z Mar 8) to 21:00 CDT Mar 8 (= 02:00Z Mar 9)
    // is 23 hours (lost one hour overnight).
    const now = new Date("2026-03-08T03:00:00.000Z"); // exactly 21:00 CST Mar 7
    const ms = msUntilNextRun(21, 0, TZ, now);
    const target = new Date(now.getTime() + ms);

    expect(target.toISOString()).toBe("2026-03-09T02:00:00.000Z"); // 21:00 CDT Mar 8
    expect(ms).toBe(23 * HOUR_MS);
  });

  it("handles DST fall back (25h day) correctly", () => {
    // US fall back 2026: 2026-11-01 02:00 CDT -> 01:00 CST
    // From 21:00 CDT on Oct 31 (= 02:00Z Nov 1) to 21:00 CST Nov 1 (= 03:00Z Nov 2)
    // is 25 hours (gained one hour overnight).
    const now = new Date("2026-11-01T02:00:00.000Z"); // exactly 21:00 CDT Oct 31
    const ms = msUntilNextRun(21, 0, TZ, now);
    const target = new Date(now.getTime() + ms);

    expect(target.toISOString()).toBe("2026-11-02T03:00:00.000Z"); // 21:00 CST Nov 1
    expect(ms).toBe(25 * HOUR_MS);
  });

  it("from mid-afternoon after spring forward still lands on 21:00 CDT", () => {
    // 15:00 CDT Mar 8 2026 = 20:00Z
    const now = new Date("2026-03-08T20:00:00.000Z");
    const ms = msUntilNextRun(21, 0, TZ, now);
    const target = new Date(now.getTime() + ms);

    expect(target.toISOString()).toBe("2026-03-09T02:00:00.000Z");
    expect(hoursUntil(ms)).toBe(6);
  });
});

describe("zonedWallTimeToUtc", () => {
  it("maps 21:00 America/Chicago in CDT to 02:00Z next calendar day", () => {
    const utc = zonedWallTimeToUtc(2026, 8, 25, 21, 0, TZ);
    expect(utc.toISOString()).toBe("2026-08-26T02:00:00.000Z");
  });

  it("maps 21:00 America/Chicago in CST to 03:00Z next calendar day", () => {
    const utc = zonedWallTimeToUtc(2026, 1, 15, 21, 0, TZ);
    expect(utc.toISOString()).toBe("2026-01-16T03:00:00.000Z");
  });
});
