/** Wall-clock parts of an instant in a specific IANA timezone. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);

  // hourCycle h23 can still report "24" for midnight in some engines; normalize.
  let hour = get("hour");
  if (hour === 24) {
    hour = 0;
  }

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Offset (ms) such that: wallClockAsUtcMs = instant.getTime() + offset.
 * I.e. how far ahead of UTC the zone's wall clock is at `instant`.
 */
function getTimeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = getZonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - instant.getTime();
}

/**
 * Convert a wall-clock date/time in `timeZone` to a UTC Date.
 * Handles DST by refining the UTC guess against the zone offset twice.
 */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  let utcMs = wallAsUtc - getTimeZoneOffsetMs(new Date(wallAsUtc), timeZone);
  const offset2 = getTimeZoneOffsetMs(new Date(utcMs), timeZone);
  utcMs = wallAsUtc - offset2;

  return new Date(utcMs);
}

function addCalendarDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  // Use UTC noon to avoid DST edge cases when stepping calendar days.
  const d = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/**
 * Milliseconds until the next occurrence of `hour`:`minute` in `timeZone`.
 * Independent of process TZ (works whether TZ=America/Chicago or UTC).
 *
 * If `now` is exactly the target, returns time until the *next* day's run
 * (i.e. a run that just fired schedules tomorrow).
 */
export function msUntilNextRun(
  hour: number,
  minute: number,
  timeZone: string,
  now: Date = new Date(),
): number {
  const parts = getZonedParts(now, timeZone);
  let target = zonedWallTimeToUtc(
    parts.year,
    parts.month,
    parts.day,
    hour,
    minute,
    timeZone,
  );

  if (target.getTime() <= now.getTime()) {
    const next = addCalendarDays(parts.year, parts.month, parts.day, 1);
    target = zonedWallTimeToUtc(
      next.year,
      next.month,
      next.day,
      hour,
      minute,
      timeZone,
    );
  }

  return target.getTime() - now.getTime();
}
