import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createIndexDaemon, type IndexRunReason } from "./daemon.js";
import { msUntilNextRun } from "./schedule.js";

const TZ = "America/Chicago";
const INDEX_DAILY_AT = "21:00";
const HOUR = 21;
const MINUTE = 0;
const HOUR_MS = 60 * 60 * 1000;

describe("createIndexDaemon manual trigger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("trigger during wait starts a manual run", async () => {
    // 12:00 CDT Aug 25 2026 = 17:00Z
    const nowMs = Date.parse("2026-08-25T17:00:00.000Z");
    const reasons: IndexRunReason[] = [];
    const logs: string[] = [];

    const daemon = createIndexDaemon({
      hour: HOUR,
      minute: MINUTE,
      timezone: TZ,
      indexDailyAt: INDEX_DAILY_AT,
      now: () => new Date(nowMs),
      sleep: (_ms, signal) =>
        new Promise((resolve) => {
          if (signal.aborted) {
            resolve("manual");
            return;
          }
          const onAbort = (): void => {
            signal.removeEventListener("abort", onAbort);
            resolve("manual");
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      runIndex: async (reason) => {
        reasons.push(reason);
      },
      logInfo: (body) => {
        logs.push(body);
      },
      logWarn: (body) => {
        logs.push(body);
      },
    });

    const loop = daemon.run();

    await vi.waitFor(() => {
      expect(logs).toContain("scheduled run waiting");
    });

    daemon.requestManualRun();

    await vi.waitFor(() => {
      expect(reasons).toEqual(["manual"]);
    });

    expect(logs).toContain("manual trigger received");

    daemon.stop();
    await loop;
  });

  it("trigger during a run does not overlap", async () => {
    const nowMs = Date.parse("2026-08-25T17:00:00.000Z");
    const reasons: IndexRunReason[] = [];
    const warns: string[] = [];
    let releaseRun: (() => void) | null = null;
    let runStarted = false;
    let sleepCount = 0;

    const daemon = createIndexDaemon({
      hour: HOUR,
      minute: MINUTE,
      timezone: TZ,
      indexDailyAt: INDEX_DAILY_AT,
      now: () => new Date(nowMs),
      sleep: (_ms, signal) =>
        new Promise((resolve) => {
          sleepCount++;
          if (sleepCount === 1) {
            // Immediate scheduled wake so we enter a run
            resolve("timer");
            return;
          }
          // Park on subsequent waits until stop()
          if (signal.aborted) {
            resolve("manual");
            return;
          }
          const onAbort = (): void => {
            signal.removeEventListener("abort", onAbort);
            resolve("manual");
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      runIndex: async (reason) => {
        reasons.push(reason);
        runStarted = true;
        await new Promise<void>((resolve) => {
          releaseRun = resolve;
        });
      },
      logInfo: () => undefined,
      logWarn: (body) => {
        warns.push(body);
      },
    });

    const loop = daemon.run();

    await vi.waitFor(() => {
      expect(runStarted).toBe(true);
      expect(daemon.isRunning()).toBe(true);
    });

    expect(reasons).toEqual(["scheduled"]);

    daemon.requestManualRun();
    daemon.requestManualRun();

    expect(warns.filter((w) => w.includes("already running"))).toHaveLength(2);
    expect(reasons).toEqual(["scheduled"]);
    expect(daemon.isRunning()).toBe(true);

    releaseRun!();
    await vi.waitFor(() => {
      expect(daemon.isRunning()).toBe(false);
    });

    // Still only one run — no overlap / no queued follow-up
    expect(reasons).toEqual(["scheduled"]);

    daemon.stop();
    await loop;
  });

  it("after a manual run the next wait is still the next 21:00 Chicago", async () => {
    // Manual run at 15:00 CDT Aug 25 = 20:00Z; next scheduled is 21:00 CDT = 02:00Z Aug 26
    let nowMs = Date.parse("2026-08-25T20:00:00.000Z");
    const sleepCalls: number[] = [];
    const reasons: IndexRunReason[] = [];

    let phase: "first-wait" | "after-manual" | "done" = "first-wait";

    const daemon = createIndexDaemon({
      hour: HOUR,
      minute: MINUTE,
      timezone: TZ,
      indexDailyAt: INDEX_DAILY_AT,
      now: () => new Date(nowMs),
      sleep: (ms, signal) =>
        new Promise((resolve) => {
          sleepCalls.push(ms);
          if (phase === "first-wait") {
            const onAbort = (): void => {
              signal.removeEventListener("abort", onAbort);
              resolve("manual");
            };
            signal.addEventListener("abort", onAbort, { once: true });
            return;
          }
          // Second wait after manual run — capture ms then stop without another run
          phase = "done";
          const onAbort = (): void => {
            signal.removeEventListener("abort", onAbort);
            resolve("manual");
          };
          signal.addEventListener("abort", onAbort, { once: true });
          queueMicrotask(() => daemon.stop());
        }),
      runIndex: async (reason) => {
        reasons.push(reason);
        // Advance "now" slightly as if the run took a few seconds
        nowMs += 5_000;
        phase = "after-manual";
      },
      logInfo: () => undefined,
      logWarn: () => undefined,
    });

    const loop = daemon.run();

    await vi.waitFor(() => {
      expect(sleepCalls.length).toBe(1);
    });

    const expectedFirstWait = msUntilNextRun(HOUR, MINUTE, TZ, new Date(nowMs));
    expect(sleepCalls[0]).toBe(expectedFirstWait);
    // From 15:00 CDT, 6h until 21:00
    expect(Math.round((sleepCalls[0]! / HOUR_MS) * 10) / 10).toBe(6);

    daemon.requestManualRun();

    await vi.waitFor(() => {
      expect(reasons).toEqual(["manual"]);
      expect(sleepCalls.length).toBe(2);
    });

    await loop;

    const expectedSecondWait = msUntilNextRun(
      HOUR,
      MINUTE,
      TZ,
      new Date(nowMs),
    );
    expect(sleepCalls[1]).toBe(expectedSecondWait);
    // Still tonight's 21:00 Chicago (~6h minus 5s), NOT 24h from the manual run
    expect(sleepCalls[1]).toBeLessThan(7 * HOUR_MS);
    expect(sleepCalls[1]).toBeGreaterThan(5 * HOUR_MS);
    expect(new Date(nowMs + sleepCalls[1]!).toISOString()).toBe(
      "2026-08-26T02:00:00.000Z",
    );
  });
});
