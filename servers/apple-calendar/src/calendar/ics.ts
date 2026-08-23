import { zonedLocalToUtc, zonedParts } from "../utils/time/index.js";

const DEFAULT_DURATION_MS = 30 * 60 * 1000;

export const DEFAULT_EVENT_DURATION_MS = DEFAULT_DURATION_MS;

/** Default Apple Calendar DISPLAY alarms: 1h and 15m before start. */
export const DEFAULT_ALARM_MINUTES_BEFORE = [60, 15] as const;

export interface BuildVEventInput {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  description?: string;
  location?: string;
  geo?: { lat: number; lon: number };
  timeZone: string;
  /** Minutes before start. Omitted → defaults; `[]` → no VALARMs. */
  alarmMinutesBefore?: number[];
}

/** Escape text per RFC 5545 TEXT. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format instant as floating local date-time for TZID (YYYYMMDDTHHMMSS). */
export function formatIcsLocalDateTime(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}${pad2(p.month)}${pad2(p.day)}T${pad2(p.hour)}${pad2(p.minute)}${pad2(p.second)}`;
}

function formatIcsUtcStamp(date: Date): string {
  return (
    date.getUTCFullYear().toString() +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    "T" +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    "Z"
  );
}

function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let remaining = line;
  chunks.push(remaining.slice(0, 75));
  remaining = remaining.slice(75);
  while (remaining.length > 0) {
    chunks.push(" " + remaining.slice(0, 74));
    remaining = remaining.slice(74);
  }
  return chunks.join("\r\n");
}

export function defaultEventEnd(start: Date, end?: Date): Date {
  if (end && end.getTime() > start.getTime()) return end;
  return new Date(start.getTime() + DEFAULT_DURATION_MS);
}

/** Format minutes-before-start as an ICS TRIGGER duration (e.g. -PT1H15M). */
export function formatAlarmTrigger(minutesBefore: number): string {
  const total = Math.max(0, Math.floor(minutesBefore));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours > 0 && minutes > 0) return `-PT${hours}H${minutes}M`;
  if (hours > 0) return `-PT${hours}H`;
  return `-PT${minutes}M`;
}

/**
 * Parse a relative TRIGGER duration into minutes before start.
 * Absolute datetimes and non-negative durations return null.
 */
export function parseAlarmTriggerMinutes(trigger: string): number | null {
  const v = trigger.trim();
  if (!v.startsWith("-P")) return null;
  const body = v.slice(2);
  const m =
    /^(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(
      body,
    );
  if (!m) return null;
  const weeks = m[1] ? Number(m[1]) : 0;
  const days = m[2] ? Number(m[2]) : 0;
  const hours = m[3] ? Number(m[3]) : 0;
  const minutes = m[4] ? Number(m[4]) : 0;
  const seconds = m[5] ? Number(m[5]) : 0;
  if (![weeks, days, hours, minutes, seconds].every(Number.isFinite)) {
    return null;
  }
  return (
    weeks * 7 * 24 * 60 +
    days * 24 * 60 +
    hours * 60 +
    minutes +
    Math.floor(seconds / 60)
  );
}

/**
 * Resolve alarm offsets: explicit wins; else existing from CalDAV; else defaults.
 */
export function resolveAlarmMinutes(
  explicit: number[] | undefined,
  existing?: number[] | null,
): number[] {
  if (explicit !== undefined) return explicit;
  if (existing !== undefined && existing !== null) return existing;
  return [...DEFAULT_ALARM_MINUTES_BEFORE];
}

function parseAlarmMinutesFromVEvent(block: string): number[] {
  const alarms: number[] = [];
  const re = /BEGIN:VALARM([\s\S]*?)END:VALARM/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) {
    const alarmBlock = match[1] ?? "";
    const triggerLine = /(?:^|\n)TRIGGER([^:\n]*):([^\n]*)/i.exec(alarmBlock);
    if (!triggerLine) continue;
    const params = triggerLine[1] ?? "";
    if (/RELATED=END/i.test(params)) continue;
    const minutes = parseAlarmTriggerMinutes(triggerLine[2] ?? "");
    if (minutes !== null) alarms.push(minutes);
  }
  return alarms;
}

function valarmBlocks(alarmMinutesBefore: number[]): string[] {
  const lines: string[] = [];
  for (const minutes of alarmMinutesBefore) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Reminder",
      `TRIGGER:${formatAlarmTrigger(minutes)}`,
      "END:VALARM",
    );
  }
  return lines;
}

/**
 * Replace VALARM blocks in an existing ICS payload without touching other
 * properties (DTSTART/DTEND/SUMMARY/…). Empty list removes all alarms.
 */
export function replaceValarmsInIcs(
  ics: string,
  alarmMinutesBefore: number[],
): string {
  const nl = ics.includes("\r\n") ? "\r\n" : "\n";
  const stripped = ics.replace(
    /BEGIN:VALARM\r?\n[\s\S]*?END:VALARM\r?\n?/gi,
    "",
  );
  const blocks = valarmBlocks(alarmMinutesBefore);
  if (blocks.length === 0) {
    return stripped.replace(/\r?\nEND:VEVENT/i, `${nl}END:VEVENT`);
  }
  const insertion = blocks.join(nl) + nl;
  if (!/END:VEVENT/i.test(stripped)) {
    return stripped;
  }
  return stripped.replace(/END:VEVENT/i, `${insertion}END:VEVENT`);
}

/** Build a single-event VCALENDAR with DISPLAY alarms (default -1h and -15m). */
export function buildVEventIcs(input: BuildVEventInput): string {
  const startLocal = formatIcsLocalDateTime(input.start, input.timeZone);
  const endLocal = formatIcsLocalDateTime(input.end, input.timeZone);
  const stamp = formatIcsUtcStamp(new Date());
  const summary = escapeIcsText(input.title);
  const description =
    input.description !== undefined && input.description.length > 0
      ? escapeIcsText(input.description)
      : null;
  const location =
    input.location !== undefined && input.location.length > 0
      ? escapeIcsText(input.location)
      : null;
  const geo =
    input.geo &&
    Number.isFinite(input.geo.lat) &&
    Number.isFinite(input.geo.lon)
      ? `${input.geo.lat};${input.geo.lon}`
      : null;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GrokMCP//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=${input.timeZone}:${startLocal}`,
    `DTEND;TZID=${input.timeZone}:${endLocal}`,
    `SUMMARY:${summary}`,
  ];
  if (description) {
    lines.push(`DESCRIPTION:${description}`);
  }
  if (location) {
    lines.push(`LOCATION:${location}`);
  }
  if (geo) {
    lines.push(`GEO:${geo}`);
  }
  const alarms = resolveAlarmMinutes(input.alarmMinutesBefore);
  lines.push(...valarmBlocks(alarms));
  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

export interface ParsedCalendarEvent {
  uid: string;
  title: string;
  start: Date | null;
  end: Date | null;
  notes: string | null;
  location: string | null;
  geo: { lat: number; lon: number } | null;
  /** Relative before-start VALARM offsets in minutes (empty if none). */
  alarmMinutesBefore: number[];
  /** Empty string for master / non-recurring. */
  recurrenceId: string;
  recurrenceRule: string | null;
  isAllDay: boolean;
  cancelled: boolean;
  sourceUpdatedAt: Date | null;
  /** TZID from DTSTART, or null for UTC / floating / all-day. */
  timeZone: string | null;
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function unfoldIcs(raw: string): string {
  return raw.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function parseIcsDateTime(
  value: string,
  timeZone?: string | null,
): Date | null {
  const v = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const year = +y!;
  const month = +mo!;
  const day = +d!;
  const hour = +h!;
  const minute = +mi!;
  const second = +s!;
  if (z) {
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  }
  if (timeZone) {
    return zonedLocalToUtc(timeZone, year, month, day, hour, minute, second);
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

/** All-day VALUE=DATE → UTC midnight of civil date (end is exclusive in ICS). */
export function parseIcsDateOnly(
  value: string,
  timeZone?: string | null,
): Date | null {
  const v = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (!m) return null;
  const year = +m[1]!;
  const month = +m[2]!;
  const day = +m[3]!;
  if (timeZone) {
    return zonedLocalToUtc(timeZone, year, month, day, 0, 0, 0);
  }
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
}

function propField(
  block: string,
  name: string,
): { params: string; value: string } | null {
  const re = new RegExp(`(?:^|\\n)${name}((?:;[^:\\n]*)?):([^\\n]*)`, "i");
  const m = re.exec(block);
  if (!m) return null;
  return { params: m[1] ?? "", value: (m[2] ?? "").trim() };
}

function propValue(block: string, name: string): string | null {
  return propField(block, name)?.value ?? null;
}

/** Extract TZID=… from ICS property params (supports quoted values). */
export function tzidFromParams(params: string): string | null {
  const m = /;TZID=("([^"]+)"|([^;:]+))/i.exec(params);
  if (!m) return null;
  const tz = (m[2] ?? m[3] ?? "").trim();
  return tz || null;
}

function parseGeo(raw: string | null): { lat: number; lon: number } | null {
  if (!raw) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*;\s*(-?\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function parseDtField(
  field: { params: string; value: string } | null,
  fallbackTz: string | null,
): { date: Date | null; isAllDay: boolean; timeZone: string | null } {
  if (!field) return { date: null, isAllDay: false, timeZone: null };
  const tz = tzidFromParams(field.params) ?? fallbackTz;
  const valueDate =
    /;VALUE=DATE(?:;|$)/i.test(field.params) ||
    (!field.value.includes("T") && /^\d{8}$/.test(field.value));
  if (valueDate) {
    return {
      date: parseIcsDateOnly(field.value, tz),
      isAllDay: true,
      timeZone: tz,
    };
  }
  return {
    date: parseIcsDateTime(field.value, tz),
    isAllDay: false,
    timeZone: tz,
  };
}

function parseSourceUpdatedAt(block: string): Date | null {
  const lastMod = propField(block, "LAST-MODIFIED");
  if (lastMod) {
    const d = parseIcsDateTime(lastMod.value, tzidFromParams(lastMod.params));
    if (d) return d;
  }
  const stamp = propField(block, "DTSTAMP");
  if (stamp) {
    return parseIcsDateTime(stamp.value, tzidFromParams(stamp.params));
  }
  return null;
}

function parseVEventBlock(block: string): ParsedCalendarEvent | null {
  const uid = propValue(block, "UID");
  if (!uid) return null;
  const summary = propValue(block, "SUMMARY");
  const description = propValue(block, "DESCRIPTION");
  const location = propValue(block, "LOCATION");
  const dtStart = propField(block, "DTSTART");
  const dtEnd = propField(block, "DTEND");
  const recurrenceIdField = propField(block, "RECURRENCE-ID");
  const rrule = propValue(block, "RRULE");
  const status = propValue(block, "STATUS");

  const startParsed = parseDtField(dtStart, null);
  const endParsed = parseDtField(dtEnd, startParsed.timeZone);
  let end = endParsed.date;
  const isAllDay = startParsed.isAllDay;
  if (isAllDay && startParsed.date && !end) {
    end = new Date(startParsed.date.getTime() + 24 * 60 * 60 * 1000);
  }

  let recurrenceId = "";
  if (recurrenceIdField) {
    const rid = parseDtField(recurrenceIdField, startParsed.timeZone);
    if (rid.isAllDay && rid.date) {
      const y = rid.date.getUTCFullYear();
      const mo = String(rid.date.getUTCMonth() + 1).padStart(2, "0");
      const d = String(rid.date.getUTCDate()).padStart(2, "0");
      recurrenceId = `${y}${mo}${d}`;
    } else if (rid.date) {
      recurrenceId = rid.date.toISOString();
    } else {
      recurrenceId = recurrenceIdField.value.trim();
    }
  }

  return {
    uid,
    title: summary ? unescapeIcsText(summary) : "",
    start: startParsed.date,
    end,
    notes: description ? unescapeIcsText(description) : null,
    location: location ? unescapeIcsText(location) : null,
    geo: parseGeo(propValue(block, "GEO")),
    alarmMinutesBefore: parseAlarmMinutesFromVEvent(block),
    recurrenceId,
    recurrenceRule: rrule?.trim() || null,
    isAllDay,
    cancelled: (status ?? "").toUpperCase() === "CANCELLED",
    sourceUpdatedAt: parseSourceUpdatedAt(block),
    timeZone: startParsed.timeZone,
  };
}

/** Extract all VEVENT components from an iCalendar payload. */
export function parseAllVEvents(ics: string): ParsedCalendarEvent[] {
  const unfolded = unfoldIcs(ics.replace(/\r\n/g, "\n"));
  const events: ParsedCalendarEvent[] = [];
  const re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(unfolded)) !== null) {
    const parsed = parseVEventBlock(match[1] ?? "");
    if (parsed) events.push(parsed);
  }
  return events;
}

/** Extract the first VEVENT from an iCalendar payload. */
export function parseFirstVEvent(ics: string): ParsedCalendarEvent | null {
  return parseAllVEvents(ics)[0] ?? null;
}
