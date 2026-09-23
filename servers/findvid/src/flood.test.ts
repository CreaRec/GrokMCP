import { describe, expect, it } from "vitest";
import {
  extractFloodWaitSeconds,
  FloodWaitTracker,
  formatFloodStats,
  parseFloodWaitSeconds,
} from "./flood.js";

describe("parseFloodWaitSeconds", () => {
  it("parses FLOOD_WAIT_N and GramJS sleep log lines", () => {
    expect(parseFloodWaitSeconds("FLOOD_WAIT_5")).toBe(5);
    expect(parseFloodWaitSeconds("A wait of 7 seconds is required (caused by messages.GetHistory)")).toBe(7);
    expect(parseFloodWaitSeconds("Sleeping for 6s on flood wait (Caused by messages.GetHistory)")).toBe(6);
    expect(parseFloodWaitSeconds("Sleeping 3s flood wait")).toBe(3);
  });

  it("returns undefined when no flood wait present", () => {
    expect(parseFloodWaitSeconds("DATA_INVALID")).toBeUndefined();
  });
});

describe("extractFloodWaitSeconds", () => {
  it("reads .seconds from FloodWaitError-like objects", () => {
    expect(extractFloodWaitSeconds({ seconds: 4, message: "flood" })).toBe(4);
    expect(extractFloodWaitSeconds(new Error("FLOOD_WAIT_9"))).toBe(9);
  });
});

describe("FloodWaitTracker", () => {
  it("backs off GetHistory and spaces successful fetches", () => {
    const tracker = new FloodWaitTracker();
    const t0 = 1_000_000;
    tracker.recordHistoryCall();
    expect(tracker.snapshot().getHistoryCalls).toBe(1);

    tracker.recordFloodWait(5, { nowMs: t0, bufferMs: 1_000 });
    expect(tracker.msUntilHistoryAllowed(t0)).toBe(6_000);
    expect(tracker.nextPollDelayMs(1_500, t0)).toBe(6_000);
    expect(tracker.snapshot().floodWaitEvents).toBe(1);
    expect(tracker.snapshot().totalFloodWaitSeconds).toBe(5);
    expect(tracker.snapshot().lastFloodWaitSeconds).toBe(5);

    // During backoff, poll delay stays elevated.
    expect(tracker.nextPollDelayMs(1_500, t0 + 2_000)).toBe(4_000);

    // After backoff expires, fall back to poll interval (until noteSuccessfulFetch).
    expect(tracker.nextPollDelayMs(1_500, t0 + 6_000)).toBe(1_500);

    tracker.noteSuccessfulFetch({ minIntervalMs: 1_500, nowMs: t0 + 6_000 });
    expect(tracker.msUntilHistoryAllowed(t0 + 6_000)).toBe(1_500);

    const pending = tracker.consumePendingFloodSleepMs();
    expect(pending).toBe(6_000);
    expect(tracker.consumePendingFloodSleepMs()).toBe(0);
  });

  it("does not hammer: repeated flood waits extend nextAllowedAt", () => {
    const tracker = new FloodWaitTracker();
    const t0 = 5_000_000;
    tracker.recordFloodWait(3, { nowMs: t0, bufferMs: 0 });
    tracker.recordFloodWait(7, { nowMs: t0 + 100, bufferMs: 0 });
    expect(tracker.msUntilHistoryAllowed(t0 + 100)).toBe(7_000);
    expect(tracker.snapshot().totalFloodWaitSeconds).toBe(10);
    expect(formatFloodStats(tracker.snapshot())).toContain("getHistory_calls=0");
    expect(formatFloodStats(tracker.snapshot())).toContain("flood_wait_seconds=10");
  });
});
