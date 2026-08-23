import { describe, expect, it } from "vitest";
import {
  buildVEventIcs,
  DEFAULT_ALARM_MINUTES_BEFORE,
  defaultEventEnd,
  escapeIcsText,
  formatAlarmTrigger,
  formatIcsLocalDateTime,
  parseAlarmTriggerMinutes,
  parseAllVEvents,
  parseFirstVEvent,
  parseIcsDateOnly,
  replaceValarmsInIcs,
  resolveAlarmMinutes,
  validateRRule,
} from "./ics.js";

describe("escapeIcsText", () => {
  it("escapes special characters", () => {
    expect(escapeIcsText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
  });
});

describe("defaultEventEnd", () => {
  it("defaults to start + 30 minutes", () => {
    const start = new Date("2024-06-01T15:00:00.000Z");
    expect(defaultEventEnd(start).toISOString()).toBe(
      "2024-06-01T15:30:00.000Z",
    );
  });

  it("keeps explicit end when after start", () => {
    const start = new Date("2024-06-01T15:00:00.000Z");
    const end = new Date("2024-06-01T16:00:00.000Z");
    expect(defaultEventEnd(start, end)).toBe(end);
  });
});

describe("formatAlarmTrigger / parseAlarmTriggerMinutes", () => {
  it("formats common offsets", () => {
    expect(formatAlarmTrigger(15)).toBe("-PT15M");
    expect(formatAlarmTrigger(60)).toBe("-PT1H");
    expect(formatAlarmTrigger(90)).toBe("-PT1H30M");
  });

  it("parses relative before-start triggers", () => {
    expect(parseAlarmTriggerMinutes("-PT15M")).toBe(15);
    expect(parseAlarmTriggerMinutes("-PT1H")).toBe(60);
    expect(parseAlarmTriggerMinutes("-PT1H30M")).toBe(90);
    expect(parseAlarmTriggerMinutes("-P1DT2H")).toBe(1560);
  });

  it("rejects absolute and positive triggers", () => {
    expect(parseAlarmTriggerMinutes("20240601T150000Z")).toBeNull();
    expect(parseAlarmTriggerMinutes("PT15M")).toBeNull();
    expect(parseAlarmTriggerMinutes("+PT15M")).toBeNull();
  });
});

describe("resolveAlarmMinutes", () => {
  it("prefers explicit, then existing, then defaults", () => {
    expect(resolveAlarmMinutes([30])).toEqual([30]);
    expect(resolveAlarmMinutes([])).toEqual([]);
    expect(resolveAlarmMinutes(undefined, [5])).toEqual([5]);
    expect(resolveAlarmMinutes(undefined, null)).toEqual([
      ...DEFAULT_ALARM_MINUTES_BEFORE,
    ]);
    expect(resolveAlarmMinutes(undefined)).toEqual([
      ...DEFAULT_ALARM_MINUTES_BEFORE,
    ]);
  });
});

describe("buildVEventIcs", () => {
  it("includes UID, TZID times, summary escape, and both VALARMs", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const ics = buildVEventIcs({
      uid: "evt-1",
      title: "Meet; now",
      start,
      end,
      description: "note",
      timeZone: "America/Chicago",
    });
    expect(ics).toContain("UID:evt-1");
    expect(ics).toContain("SUMMARY:Meet\\; now");
    expect(ics).toContain("DESCRIPTION:note");
    expect(ics).toContain("TRIGGER:-PT1H");
    expect(ics).toContain("TRIGGER:-PT15M");
    expect(ics).toContain("DTSTART;TZID=America/Chicago:");
    expect(ics).toContain("DTEND;TZID=America/Chicago:");
    const localStart = formatIcsLocalDateTime(start, "America/Chicago");
    expect(ics).toContain(`DTSTART;TZID=America/Chicago:${localStart}`);
  });

  it("includes LOCATION and GEO when provided", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const ics = buildVEventIcs({
      uid: "evt-2",
      title: "Coffee",
      start,
      end: defaultEventEnd(start),
      description: "https://maps.google.com/?cid=1",
      location: "123 Lamar Blvd, Austin, TX",
      geo: { lat: 30.27, lon: -97.74 },
      timeZone: "America/Chicago",
    });
    expect(ics).toContain("LOCATION:123 Lamar Blvd\\, Austin\\, TX");
    expect(ics).toContain("GEO:30.27;-97.74");
    expect(ics).toContain("DESCRIPTION:https://maps.google.com/?cid=1");
  });

  it("uses custom alarm minutes", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const ics = buildVEventIcs({
      uid: "evt-3",
      title: "Custom",
      start,
      end: defaultEventEnd(start),
      timeZone: "America/Chicago",
      alarmMinutesBefore: [30, 120],
    });
    expect(ics).toContain("TRIGGER:-PT30M");
    expect(ics).toContain("TRIGGER:-PT2H");
    expect(ics).not.toContain("TRIGGER:-PT15M");
  });

  it("omits VALARMs when alarm list is empty", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const ics = buildVEventIcs({
      uid: "evt-4",
      title: "Silent",
      start,
      end: defaultEventEnd(start),
      timeZone: "America/Chicago",
      alarmMinutesBefore: [],
    });
    expect(ics).not.toContain("BEGIN:VALARM");
    expect(ics).not.toContain("TRIGGER:");
  });
});

describe("parseFirstVEvent", () => {
  it("parses UID summary and TZID datetimes as zone-local instants", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:abc",
      "SUMMARY:Hello\\, world",
      "DTSTART;TZID=America/Chicago:20240601T150000",
      "DTEND;TZID=America/Chicago:20240601T153000",
      "DESCRIPTION:x",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = parseFirstVEvent(ics);
    expect(parsed?.uid).toBe("abc");
    expect(parsed?.title).toBe("Hello, world");
    expect(parsed?.notes).toBe("x");
    expect(parsed?.location).toBeNull();
    expect(parsed?.geo).toBeNull();
    expect(parsed?.alarmMinutesBefore).toEqual([]);
    // 15:00 CDT = 20:00 UTC
    expect(parsed?.start?.toISOString()).toBe("2024-06-01T20:00:00.000Z");
    expect(parsed?.end?.toISOString()).toBe("2024-06-01T20:30:00.000Z");
  });

  it("parses quoted TZID params", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:quoted",
      "SUMMARY:Q",
      'DTSTART;TZID="America/Chicago":20240601T090000',
      'DTEND;TZID="America/Chicago":20240601T094500',
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = parseFirstVEvent(ics);
    expect(parsed?.start?.toISOString()).toBe("2024-06-01T14:00:00.000Z");
    expect(parsed?.end?.toISOString()).toBe("2024-06-01T14:45:00.000Z");
  });

  it("parses Apple fixed-offset TZID GMT-0500", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:gmt-offset",
      "SUMMARY:Legacy",
      "DTSTART;TZID=GMT-0500:20240601T150000",
      "DTEND;TZID=GMT-0500:20240601T153000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = parseFirstVEvent(ics);
    expect(parsed?.timeZone).toBe("GMT-0500");
    expect(parsed?.start?.toISOString()).toBe("2024-06-01T20:00:00.000Z");
    expect(parsed?.end?.toISOString()).toBe("2024-06-01T20:30:00.000Z");
  });

  it("parses LOCATION and GEO", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:loc-1",
      "SUMMARY:Coffee",
      "DTSTART;TZID=America/Chicago:20240601T150000",
      "DTEND;TZID=America/Chicago:20240601T153000",
      "LOCATION:123 Lamar Blvd\\, Austin\\, TX",
      "GEO:30.27;-97.74",
      "DESCRIPTION:https://maps.google.com/?cid=1",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = parseFirstVEvent(ics);
    expect(parsed?.location).toBe("123 Lamar Blvd, Austin, TX");
    expect(parsed?.geo).toEqual({ lat: 30.27, lon: -97.74 });
    expect(parsed?.notes).toBe("https://maps.google.com/?cid=1");
  });

  it("parses VALARM trigger minutes and skips RELATED=END", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:alarm-1",
      "SUMMARY:Meet",
      "DTSTART;TZID=America/Chicago:20240601T150000",
      "DTEND;TZID=America/Chicago:20240601T153000",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Reminder",
      "TRIGGER:-PT30M",
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Reminder",
      "TRIGGER:-PT2H",
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER;RELATED=END:-PT5M",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = parseFirstVEvent(ics);
    expect(parsed?.alarmMinutesBefore).toEqual([30, 120]);
  });

  it("round-trips custom alarms through build and parse", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const ics = buildVEventIcs({
      uid: "round",
      title: "Round",
      start,
      end: defaultEventEnd(start),
      timeZone: "America/Chicago",
      alarmMinutesBefore: [5, 90],
    });
    expect(parseFirstVEvent(ics)?.alarmMinutesBefore).toEqual([5, 90]);
  });

  it("round-trips TZID start/end through build → parse → rebuild (location update)", () => {
    const start = new Date("2026-08-24T14:00:00.000Z"); // 09:00 Chicago
    const end = new Date("2026-08-24T14:30:00.000Z");
    const tz = "America/Chicago";
    const created = buildVEventIcs({
      uid: "ukol",
      title: "Укол",
      start,
      end,
      timeZone: tz,
      alarmMinutesBefore: [],
    });
    const parsed = parseFirstVEvent(created);
    expect(parsed?.start?.toISOString()).toBe(start.toISOString());
    expect(parsed?.end?.toISOString()).toBe(end.toISOString());

    // Location-only rewrite must not shift wall times.
    const rewritten = buildVEventIcs({
      uid: "ukol",
      title: "Укол",
      start: parsed!.start!,
      end: parsed!.end!,
      location: "Frontier Allergy",
      timeZone: tz,
      alarmMinutesBefore: [],
    });
    expect(rewritten).toContain(
      `DTSTART;TZID=${tz}:${formatIcsLocalDateTime(start, tz)}`,
    );
    expect(rewritten).toContain(
      `DTEND;TZID=${tz}:${formatIcsLocalDateTime(end, tz)}`,
    );

    // Duration-only end change (45m) keeps start.
    const end45 = new Date("2026-08-24T14:45:00.000Z");
    const afterDuration = buildVEventIcs({
      uid: "ukol",
      title: "Укол",
      start: parseFirstVEvent(rewritten)!.start!,
      end: end45,
      location: "Frontier Allergy",
      timeZone: tz,
      alarmMinutesBefore: [],
    });
    expect(afterDuration).toContain(`DTSTART;TZID=${tz}:20260824T090000`);
    expect(afterDuration).toContain(`DTEND;TZID=${tz}:20260824T094500`);
  });
});

describe("replaceValarmsInIcs", () => {
  it("replaces alarms without touching DTSTART/DTEND", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = new Date("2024-06-01T22:00:00.000Z");
    const ics = buildVEventIcs({
      uid: "dur",
      title: "Long",
      start,
      end,
      timeZone: "America/Chicago",
      alarmMinutesBefore: [60, 15],
    });
    const next = replaceValarmsInIcs(ics, [30]);
    expect(next).toContain("TRIGGER:-PT30M");
    expect(next).not.toContain("TRIGGER:-PT1H");
    expect(next).not.toContain("TRIGGER:-PT15M");
    const startLine = ics.match(/^DTSTART.*$/m)?.[0];
    const endLine = ics.match(/^DTEND.*$/m)?.[0];
    expect(startLine).toBeTruthy();
    expect(endLine).toBeTruthy();
    expect(next).toContain(startLine!);
    expect(next).toContain(endLine!);
  });

  it("removes all VALARMs when given empty list", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const ics = buildVEventIcs({
      uid: "silent",
      title: "Silent",
      start,
      end: defaultEventEnd(start),
      timeZone: "America/Chicago",
    });
    const next = replaceValarmsInIcs(ics, []);
    expect(next).not.toContain("BEGIN:VALARM");
    expect(next).toContain("END:VEVENT");
  });
});

describe("parseAllVEvents / all-day / recurrence", () => {
  it("parses VALUE=DATE all-day events as exclusive end", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:allday-1",
      "DTSTART;VALUE=DATE:20240601",
      "DTEND;VALUE=DATE:20240602",
      "SUMMARY:Holiday",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const events = parseAllVEvents(ics);
    expect(events).toHaveLength(1);
    expect(events[0]?.isAllDay).toBe(true);
    expect(events[0]?.start?.toISOString()).toBe(
      parseIcsDateOnly("20240601")?.toISOString(),
    );
    expect(events[0]?.end?.toISOString()).toBe(
      parseIcsDateOnly("20240602")?.toISOString(),
    );
  });

  it("parses RRULE master and RECURRENCE-ID exception", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:series-1",
      "DTSTART;TZID=America/Chicago:20240601T100000",
      "DTEND;TZID=America/Chicago:20240601T110000",
      "RRULE:FREQ=WEEKLY;COUNT=4",
      "SUMMARY:Standup",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:series-1",
      "RECURRENCE-ID;TZID=America/Chicago:20240608T100000",
      "DTSTART;TZID=America/Chicago:20240608T110000",
      "DTEND;TZID=America/Chicago:20240608T120000",
      "SUMMARY:Standup moved",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const events = parseAllVEvents(ics);
    expect(events).toHaveLength(2);
    expect(events[0]?.recurrenceRule).toBe("FREQ=WEEKLY;COUNT=4");
    expect(events[0]?.recurrenceId).toBe("");
    expect(events[1]?.recurrenceId.length).toBeGreaterThan(0);
    expect(events[1]?.title).toBe("Standup moved");
  });

  it("marks STATUS:CANCELLED", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:cancelled-1",
      "DTSTART:20240601T150000Z",
      "DTEND:20240601T160000Z",
      "STATUS:CANCELLED",
      "SUMMARY:Nope",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseFirstVEvent(ics)?.cancelled).toBe(true);
  });
});

describe("validateRRule", () => {
  it("validates basic FREQ rules", () => {
    expect(validateRRule("FREQ=DAILY")).toEqual({
      valid: true,
      normalized: "FREQ=DAILY",
    });
    expect(validateRRule("FREQ=WEEKLY")).toEqual({
      valid: true,
      normalized: "FREQ=WEEKLY",
    });
    expect(validateRRule("FREQ=MONTHLY")).toEqual({
      valid: true,
      normalized: "FREQ=MONTHLY",
    });
    expect(validateRRule("FREQ=YEARLY")).toEqual({
      valid: true,
      normalized: "FREQ=YEARLY",
    });
  });

  it("validates FREQ with INTERVAL", () => {
    expect(validateRRule("FREQ=WEEKLY;INTERVAL=2")).toEqual({
      valid: true,
      normalized: "FREQ=WEEKLY;INTERVAL=2",
    });
  });

  it("validates FREQ with COUNT", () => {
    expect(validateRRule("FREQ=DAILY;COUNT=10")).toEqual({
      valid: true,
      normalized: "FREQ=DAILY;COUNT=10",
    });
  });

  it("validates FREQ with UNTIL (date only)", () => {
    expect(validateRRule("FREQ=DAILY;UNTIL=20260901")).toEqual({
      valid: true,
      normalized: "FREQ=DAILY;UNTIL=20260901",
    });
  });

  it("validates FREQ with UNTIL (datetime UTC)", () => {
    expect(validateRRule("FREQ=DAILY;UNTIL=20260901T000000Z")).toEqual({
      valid: true,
      normalized: "FREQ=DAILY;UNTIL=20260901T000000Z",
    });
  });

  it("validates FREQ with BYDAY", () => {
    expect(validateRRule("FREQ=WEEKLY;BYDAY=MO,WE,FR")).toEqual({
      valid: true,
      normalized: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    });
  });

  it("validates BYDAY with ordinals for MONTHLY", () => {
    expect(validateRRule("FREQ=MONTHLY;BYDAY=1MO")).toEqual({
      valid: true,
      normalized: "FREQ=MONTHLY;BYDAY=1MO",
    });
    expect(validateRRule("FREQ=MONTHLY;BYDAY=-1FR")).toEqual({
      valid: true,
      normalized: "FREQ=MONTHLY;BYDAY=-1FR",
    });
  });

  it("validates BYMONTH", () => {
    expect(validateRRule("FREQ=YEARLY;BYMONTH=1,6,12")).toEqual({
      valid: true,
      normalized: "FREQ=YEARLY;BYMONTH=1,6,12",
    });
  });

  it("validates BYMONTHDAY", () => {
    expect(validateRRule("FREQ=MONTHLY;BYMONTHDAY=15")).toEqual({
      valid: true,
      normalized: "FREQ=MONTHLY;BYMONTHDAY=15",
    });
    expect(validateRRule("FREQ=MONTHLY;BYMONTHDAY=-1")).toEqual({
      valid: true,
      normalized: "FREQ=MONTHLY;BYMONTHDAY=-1",
    });
  });

  it("validates BYSETPOS", () => {
    expect(validateRRule("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1")).toEqual({
      valid: true,
      normalized: "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1",
    });
  });

  it("validates WKST", () => {
    expect(validateRRule("FREQ=WEEKLY;WKST=SU")).toEqual({
      valid: true,
      normalized: "FREQ=WEEKLY;WKST=SU",
    });
  });

  it("validates complex rule", () => {
    expect(
      validateRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=8"),
    ).toEqual({
      valid: true,
      normalized: "FREQ=WEEKLY;INTERVAL=2;COUNT=8;BYDAY=MO,WE",
    });
  });

  it("rejects empty RRULE", () => {
    expect(validateRRule("")).toEqual({
      valid: false,
      error: "RRULE is empty",
    });
    expect(validateRRule("   ")).toEqual({
      valid: false,
      error: "RRULE is empty",
    });
  });

  it("rejects missing FREQ", () => {
    expect(validateRRule("INTERVAL=2")).toEqual({
      valid: false,
      error: "RRULE must have FREQ",
    });
  });

  it("rejects invalid FREQ", () => {
    expect(validateRRule("FREQ=BIWEEKLY")).toEqual({
      valid: false,
      error: "Invalid FREQ value: BIWEEKLY",
    });
  });

  it("rejects both COUNT and UNTIL", () => {
    expect(validateRRule("FREQ=DAILY;COUNT=10;UNTIL=20260901")).toEqual({
      valid: false,
      error: "RRULE cannot have both COUNT and UNTIL",
    });
  });

  it("rejects invalid COUNT", () => {
    expect(validateRRule("FREQ=DAILY;COUNT=0")).toEqual({
      valid: false,
      error: "Invalid COUNT value: 0",
    });
    expect(validateRRule("FREQ=DAILY;COUNT=-5")).toEqual({
      valid: false,
      error: "Invalid COUNT value: -5",
    });
    expect(validateRRule("FREQ=DAILY;COUNT=abc")).toEqual({
      valid: false,
      error: "Invalid COUNT value: abc",
    });
  });

  it("rejects invalid INTERVAL", () => {
    expect(validateRRule("FREQ=DAILY;INTERVAL=0")).toEqual({
      valid: false,
      error: "Invalid INTERVAL value: 0",
    });
  });

  it("rejects invalid BYDAY", () => {
    expect(validateRRule("FREQ=WEEKLY;BYDAY=XX")).toEqual({
      valid: false,
      error: "Invalid BYDAY value: XX",
    });
  });

  it("rejects invalid BYMONTH", () => {
    expect(validateRRule("FREQ=YEARLY;BYMONTH=13")).toEqual({
      valid: false,
      error: "Invalid BYMONTH value: 13",
    });
    expect(validateRRule("FREQ=YEARLY;BYMONTH=0")).toEqual({
      valid: false,
      error: "Invalid BYMONTH value: 0",
    });
  });

  it("rejects invalid UNTIL format", () => {
    expect(validateRRule("FREQ=DAILY;UNTIL=2026-09-01")).toEqual({
      valid: false,
      error: "Invalid UNTIL value: 2026-09-01",
    });
  });

  it("rejects duplicate keys", () => {
    expect(validateRRule("FREQ=DAILY;FREQ=WEEKLY")).toEqual({
      valid: false,
      error: "Duplicate RRULE key: FREQ",
    });
  });

  it("rejects malformed parts", () => {
    expect(validateRRule("FREQ=DAILY;GARBAGE")).toEqual({
      valid: false,
      error: 'Invalid RRULE part (no "="): GARBAGE',
    });
  });
});

describe("buildVEventIcs with RRULE", () => {
  it("emits RRULE when recurrenceRule is set", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const ics = buildVEventIcs({
      uid: "recurring-1",
      title: "Weekly Standup",
      start,
      end,
      timeZone: "America/Chicago",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12",
    });
    expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12");
  });

  it("omits RRULE when recurrenceRule is undefined", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const ics = buildVEventIcs({
      uid: "single-1",
      title: "One-time Event",
      start,
      end,
      timeZone: "America/Chicago",
    });
    expect(ics).not.toContain("RRULE:");
  });

  it("omits RRULE when recurrenceRule is null", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const ics = buildVEventIcs({
      uid: "cleared-1",
      title: "Was Recurring",
      start,
      end,
      timeZone: "America/Chicago",
      recurrenceRule: null,
    });
    expect(ics).not.toContain("RRULE:");
  });

  it("omits RRULE when recurrenceRule is empty string", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const ics = buildVEventIcs({
      uid: "cleared-2",
      title: "Was Recurring",
      start,
      end,
      timeZone: "America/Chicago",
      recurrenceRule: "",
    });
    expect(ics).not.toContain("RRULE:");
  });
});

describe("RRULE round-trip (build → parse)", () => {
  it("round-trips RRULE through build and parse", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const rrule = "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8";
    const ics = buildVEventIcs({
      uid: "round-trip-1",
      title: "Recurring",
      start,
      end,
      timeZone: "America/Chicago",
      recurrenceRule: rrule,
    });
    const parsed = parseFirstVEvent(ics);
    expect(parsed?.recurrenceRule).toBe(rrule);
    expect(parsed?.recurrenceId).toBe("");
  });

  it("round-trips DAILY with UNTIL", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const rrule = "FREQ=DAILY;UNTIL=20260901T000000Z";
    const ics = buildVEventIcs({
      uid: "round-trip-2",
      title: "Daily Until",
      start,
      end,
      timeZone: "America/Chicago",
      recurrenceRule: rrule,
    });
    const parsed = parseFirstVEvent(ics);
    expect(parsed?.recurrenceRule).toBe(rrule);
  });

  it("round-trips MONTHLY with BYMONTHDAY", () => {
    const start = new Date("2024-06-15T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const rrule = "FREQ=MONTHLY;BYMONTHDAY=15";
    const ics = buildVEventIcs({
      uid: "round-trip-3",
      title: "Monthly 15th",
      start,
      end,
      timeZone: "America/Chicago",
      recurrenceRule: rrule,
    });
    const parsed = parseFirstVEvent(ics);
    expect(parsed?.recurrenceRule).toBe(rrule);
  });

  it("round-trips YEARLY with BYMONTH", () => {
    const start = new Date("2024-01-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const rrule = "FREQ=YEARLY;BYMONTH=1";
    const ics = buildVEventIcs({
      uid: "round-trip-4",
      title: "New Year",
      start,
      end,
      timeZone: "America/Chicago",
      recurrenceRule: rrule,
    });
    const parsed = parseFirstVEvent(ics);
    expect(parsed?.recurrenceRule).toBe(rrule);
  });
});

describe("replaceValarmsInIcs preserves RRULE", () => {
  it("preserves RRULE when replacing alarms", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const rrule = "FREQ=WEEKLY;BYDAY=MO;COUNT=4";
    const ics = buildVEventIcs({
      uid: "alarm-rrule-1",
      title: "Weekly with Alarms",
      start,
      end,
      timeZone: "America/Chicago",
      recurrenceRule: rrule,
      alarmMinutesBefore: [60, 15],
    });

    expect(ics).toContain(`RRULE:${rrule}`);
    expect(ics).toContain("TRIGGER:-PT1H");
    expect(ics).toContain("TRIGGER:-PT15M");

    const updated = replaceValarmsInIcs(ics, [30]);
    expect(updated).toContain(`RRULE:${rrule}`);
    expect(updated).toContain("TRIGGER:-PT30M");
    expect(updated).not.toContain("TRIGGER:-PT1H");
    expect(updated).not.toContain("TRIGGER:-PT15M");
  });

  it("preserves RRULE when removing all alarms", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const rrule = "FREQ=DAILY;COUNT=5";
    const ics = buildVEventIcs({
      uid: "alarm-rrule-2",
      title: "Daily with Alarms",
      start,
      end,
      timeZone: "America/Chicago",
      recurrenceRule: rrule,
    });

    const updated = replaceValarmsInIcs(ics, []);
    expect(updated).toContain(`RRULE:${rrule}`);
    expect(updated).not.toContain("BEGIN:VALARM");
  });

  it("preserves RRULE with complex rules", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const rrule = "FREQ=MONTHLY;BYDAY=1MO;COUNT=6";
    const ics = buildVEventIcs({
      uid: "alarm-rrule-3",
      title: "First Monday",
      start,
      end,
      timeZone: "America/Chicago",
      recurrenceRule: rrule,
    });

    const updated = replaceValarmsInIcs(ics, [5, 10, 1440]);
    expect(updated).toContain(`RRULE:${rrule}`);
    expect(updated).toContain("TRIGGER:-PT5M");
    expect(updated).toContain("TRIGGER:-PT10M");
    expect(updated).toContain("TRIGGER:-PT24H");
  });
});

describe("update title without losing RRULE (simulation)", () => {
  it("simulates updating title while preserving RRULE", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const rrule = "FREQ=WEEKLY;BYDAY=TU,TH;COUNT=10";

    const original = buildVEventIcs({
      uid: "update-sim-1",
      title: "Original Title",
      start,
      end,
      timeZone: "America/Chicago",
      recurrenceRule: rrule,
    });
    expect(original).toContain("SUMMARY:Original Title");
    expect(original).toContain(`RRULE:${rrule}`);

    const parsed = parseFirstVEvent(original);
    expect(parsed?.recurrenceRule).toBe(rrule);

    const updated = buildVEventIcs({
      uid: "update-sim-1",
      title: "Updated Title",
      start: parsed!.start!,
      end: parsed!.end!,
      timeZone: "America/Chicago",
      recurrenceRule: parsed!.recurrenceRule ?? undefined,
    });

    expect(updated).toContain("SUMMARY:Updated Title");
    expect(updated).toContain(`RRULE:${rrule}`);
    expect(parseFirstVEvent(updated)?.recurrenceRule).toBe(rrule);
  });

  it("simulates clearing RRULE", () => {
    const start = new Date("2024-06-01T20:00:00.000Z");
    const end = defaultEventEnd(start);
    const rrule = "FREQ=DAILY;COUNT=5";

    const original = buildVEventIcs({
      uid: "clear-rrule-1",
      title: "Was Recurring",
      start,
      end,
      timeZone: "America/Chicago",
      recurrenceRule: rrule,
    });
    expect(original).toContain(`RRULE:${rrule}`);

    const parsed = parseFirstVEvent(original);

    const cleared = buildVEventIcs({
      uid: "clear-rrule-1",
      title: "Now Single",
      start: parsed!.start!,
      end: parsed!.end!,
      timeZone: "America/Chicago",
      recurrenceRule: null,
    });

    expect(cleared).not.toContain("RRULE:");
    expect(parseFirstVEvent(cleared)?.recurrenceRule).toBeNull();
  });
});
