import { describe, expect, it } from "vitest";
import {
  dayEndUtc,
  dayStartUtc,
  formatLocal,
  localDateString,
  parseLocalDate,
  parseZonedDateTime,
  zonedLocalToUtc,
  zonedParts,
} from "./index.js";

describe("zonedParts", () => {
  it("extracts parts for IANA timezone", () => {
    const date = new Date("2024-06-15T20:30:00.000Z");
    const parts = zonedParts(date, "America/Chicago");
    expect(parts.year).toBe(2024);
    expect(parts.month).toBe(6);
    expect(parts.day).toBe(15);
    expect(parts.hour).toBe(15);
    expect(parts.minute).toBe(30);
  });

  it("extracts parts for fixed offset GMT-0500", () => {
    const date = new Date("2024-06-15T20:30:00.000Z");
    const parts = zonedParts(date, "GMT-0500");
    expect(parts.hour).toBe(15);
    expect(parts.minute).toBe(30);
  });
});

describe("zonedLocalToUtc", () => {
  it("converts local time to UTC for IANA timezone", () => {
    const utc = zonedLocalToUtc("America/Chicago", 2024, 6, 15, 15, 30, 0);
    expect(utc.toISOString()).toBe("2024-06-15T20:30:00.000Z");
  });

  it("converts local time to UTC for fixed offset", () => {
    const utc = zonedLocalToUtc("GMT-0500", 2024, 6, 15, 15, 30, 0);
    expect(utc.toISOString()).toBe("2024-06-15T20:30:00.000Z");
  });
});

describe("parseZonedDateTime", () => {
  it("parses naive datetime as local wall time", () => {
    const result = parseZonedDateTime("2024-06-15T15:30:00", "America/Chicago");
    expect(result?.toISOString()).toBe("2024-06-15T20:30:00.000Z");
  });

  it("parses datetime with Z as UTC", () => {
    const result = parseZonedDateTime(
      "2024-06-15T15:30:00Z",
      "America/Chicago",
    );
    expect(result?.toISOString()).toBe("2024-06-15T15:30:00.000Z");
  });

  it("parses datetime with offset", () => {
    const result = parseZonedDateTime(
      "2024-06-15T15:30:00-05:00",
      "America/Chicago",
    );
    expect(result?.toISOString()).toBe("2024-06-15T20:30:00.000Z");
  });
});

describe("localDateString", () => {
  it("formats date as YYYY-MM-DD in timezone", () => {
    const date = new Date("2024-06-15T20:30:00.000Z");
    expect(localDateString(date, "America/Chicago")).toBe("2024-06-15");
  });
});

describe("formatLocal", () => {
  it("formats date in locale string for timezone", () => {
    const date = new Date("2024-06-15T20:30:00.000Z");
    const formatted = formatLocal(date, "America/Chicago");
    expect(formatted).toContain("6/15/2024");
    expect(formatted).toContain("3:30:00 PM");
  });
});

describe("parseLocalDate", () => {
  it("parses valid YYYY-MM-DD", () => {
    const result = parseLocalDate("2024-06-15");
    expect(result).toEqual({ year: 2024, month: 6, day: 15 });
  });

  it("rejects invalid dates", () => {
    expect(parseLocalDate("2024-02-30")).toBeNull();
    expect(parseLocalDate("invalid")).toBeNull();
  });
});

describe("dayStartUtc / dayEndUtc", () => {
  it("returns midnight boundaries in timezone", () => {
    const start = dayStartUtc("2024-06-15", "America/Chicago");
    const end = dayEndUtc("2024-06-15", "America/Chicago");
    expect(start.toISOString()).toBe("2024-06-15T05:00:00.000Z");
    expect(end.toISOString()).toBe("2024-06-16T05:00:00.000Z");
  });
});
