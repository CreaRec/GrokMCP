import { describe, expect, it } from "vitest";
import {
  DateRangeError,
  MAX_TRANSACTION_RANGE_DAYS,
  calendarDayDiff,
  resolveTransactionDateBounds,
  unixToIsoOrNull,
  zonedMidnightUnix,
} from "./dates.js";

describe("resolveTransactionDateBounds", () => {
  it("accepts a 90-day range and maps Chicago midnights to Unix", () => {
    const bounds = resolveTransactionDateBounds("2026-01-01", "2026-04-01");
    expect(bounds.rangeDays).toBe(90);
    expect(bounds.startDateUnix).toBe(zonedMidnightUnix("2026-01-01"));
    expect(bounds.endDateUnix).toBe(zonedMidnightUnix("2026-04-01"));
    // CST (UTC-6) in January
    expect(bounds.startDateUnix).toBe(Date.UTC(2026, 0, 1, 6, 0, 0) / 1000);
  });

  it("rejects ranges longer than 90 days", () => {
    expect(() =>
      resolveTransactionDateBounds("2026-01-01", "2026-04-02"),
    ).toThrow(DateRangeError);
    expect(() =>
      resolveTransactionDateBounds("2026-01-01", "2026-04-02"),
    ).toThrow(/90 days/);
    expect(calendarDayDiff("2026-01-01", "2026-04-02")).toBe(91);
    expect(MAX_TRANSACTION_RANGE_DAYS).toBe(90);
  });

  it("rejects inverted ranges and bad formats", () => {
    expect(() => resolveTransactionDateBounds("2026-02-01", "2026-01-01")).toThrow(
      /on or before/,
    );
    expect(() => resolveTransactionDateBounds("2026-1-1", "2026-01-02")).toThrow(
      DateRangeError,
    );
  });
});

describe("unixToIsoOrNull", () => {
  it("returns null for pending/zero posted timestamps", () => {
    expect(unixToIsoOrNull(0)).toBeNull();
    expect(unixToIsoOrNull(null)).toBeNull();
    expect(unixToIsoOrNull(1_700_000_000)).toBe(
      new Date(1_700_000_000 * 1000).toISOString(),
    );
  });
});
