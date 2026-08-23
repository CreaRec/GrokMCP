import { createDAVClient, type DAVCalendar, type DAVObject } from "tsdav";
import {
  buildVEventIcs,
  buildVTODOIcs,
  defaultEventEnd,
  markVTODOCompleted,
  parseAllVEvents,
  parseAllVTODOs,
  parseFirstVEvent,
  parseFirstVTODO,
  patchVTODOIcs,
  replaceValarmsInIcs,
  resolveAlarmMinutes,
  type BuildVTODOInput,
  type ParsedCalendarEvent,
  type ParsedReminder,
  type VTODOStatus,
} from "./ics.js";
import { mergeEventDescription } from "./event-description.js";

export interface ReminderList {
  name: string;
  href: string;
  components: string[];
}

export interface ListReminderListsResult {
  lists: ReminderList[];
}

export function parseComponentTypes(calendar: DAVCalendar): string[] {
  const components: string[] = [];
  const supportedComponents = calendar.components;
  if (supportedComponents && Array.isArray(supportedComponents)) {
    for (const comp of supportedComponents) {
      if (typeof comp === "string") {
        components.push(comp.toUpperCase());
      }
    }
  }
  return components;
}

export function supportsVTODO(components: string[]): boolean {
  return components.includes("VTODO");
}

export function filterReminderLists(
  calendars: DAVCalendar[],
  includeCalendars: boolean = false,
): ReminderList[] {
  const lists: ReminderList[] = [];

  for (const calendar of calendars) {
    const components = parseComponentTypes(calendar);
    const hasVTODO = supportsVTODO(components);
    const hasVEVENT = components.includes("VEVENT");

    if (hasVTODO || (includeCalendars && hasVEVENT)) {
      const name =
        typeof calendar.displayName === "string"
          ? calendar.displayName
          : "Untitled";
      lists.push({
        name,
        href: calendar.url,
        components,
      });
    }
  }

  return lists;
}

export type CalendarClientResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface CalendarEventInput {
  uid: string;
  title: string;
  start: Date;
  end?: Date;
  description?: string;
  location?: string;
  geo?: { lat: number; lon: number };
  timeZone: string;
  /**
   * Minutes before start for DISPLAY VALARMs.
   * Create: omitted → defaults. Update: omitted → preserve from CalDAV.
   * Pass `[]` for no alarms.
   */
  alarmMinutesBefore?: number[];
  /**
   * RFC 5545 RRULE body without the "RRULE:" prefix.
   * Example: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8"
   * Omitted → no recurrence. Empty string or null → explicitly no recurrence.
   */
  recurrenceRule?: string | null;
}

/**
 * Partial update. Omitted fields are preserved from the existing CalDAV object.
 * Alarm-only patches surgically replace VALARMs without rewriting DTSTART/DTEND.
 */
export interface CalendarEventPatch {
  uid: string;
  timeZone: string;
  title?: string;
  start?: Date;
  end?: Date;
  description?: string;
  /**
   * When set (including null), merge into DESCRIPTION: keep existing free-text
   * notes (unless `description` is also set) and ensure this Maps URL is present.
   */
  mapsUrl?: string | null;
  location?: string;
  geo?: { lat: number; lon: number };
  alarmMinutesBefore?: number[];
  /**
   * RFC 5545 RRULE body without the "RRULE:" prefix.
   * Omitted → preserve existing RRULE from CalDAV.
   * Non-empty string → set/replace RRULE.
   * Empty string or null → clear RRULE (make non-recurring).
   */
  recurrenceRule?: string | null;
}

export interface CalendarEventListItem {
  uid: string;
  href: string;
  title: string;
  start: string | null;
  end: string | null;
  notes: string | null;
  location: string | null;
  geo: { lat: number; lon: number } | null;
  recurrenceId: string;
  recurrenceRule: string | null;
  isAllDay: boolean;
  cancelled: boolean;
  sourceUpdatedAt: string | null;
  alarmMinutesBefore: number[];
  timeZone: string | null;
}

export interface CalendarRemoteEvent extends CalendarEventListItem {
  /** Raw ICS object data when available. */
  rawIcs?: string;
}

export interface ICloudCalendarClient {
  createEvent(
    input: CalendarEventInput,
  ): Promise<CalendarClientResult<{ uid: string; href: string; end: Date }>>;
  listEvents(opts: {
    from: Date;
    to: Date;
    limit?: number;
  }): Promise<CalendarClientResult<{ events: CalendarEventListItem[] }>>;
  /** Full calendar snapshot (no timeRange, no limit). */
  fetchAllEvents(): Promise<
    CalendarClientResult<{ events: CalendarRemoteEvent[]; complete: boolean }>
  >;
  updateEvent(
    href: string,
    patch: CalendarEventPatch,
  ): Promise<CalendarClientResult<{ uid: string; href: string; end: Date }>>;
  deleteEvent(href: string): Promise<CalendarClientResult<{ deleted: true }>>;
  /** Resolve an event by UID (list + find) when href is unknown. */
  findEventByUid(
    uid: string,
  ): Promise<CalendarClientResult<{ event: CalendarRemoteEvent } | null>>;
}

function joinHref(calendarUrl: string, filename: string): string {
  const base = calendarUrl.endsWith("/") ? calendarUrl : `${calendarUrl}/`;
  return new URL(filename, base).href;
}

type DavSession = Awaited<ReturnType<typeof createDAVClient>>;

function toIcsInput(
  input: {
    uid: string;
    title: string;
    start: Date;
    description?: string;
    location?: string;
    geo?: { lat: number; lon: number };
    timeZone: string;
    recurrenceRule?: string | null;
  },
  end: Date,
  alarmMinutesBefore: number[],
) {
  return {
    uid: input.uid,
    title: input.title,
    start: input.start,
    end,
    description: input.description,
    location: input.location,
    geo: input.geo,
    timeZone: input.timeZone,
    alarmMinutesBefore,
    recurrenceRule: input.recurrenceRule,
  };
}

function isAlarmsOnlyPatch(patch: CalendarEventPatch): boolean {
  return (
    patch.alarmMinutesBefore !== undefined &&
    patch.title === undefined &&
    patch.start === undefined &&
    patch.end === undefined &&
    patch.description === undefined &&
    patch.mapsUrl === undefined &&
    patch.location === undefined &&
    patch.geo === undefined &&
    patch.recurrenceRule === undefined
  );
}

export class TsdavICloudCalendarClient implements ICloudCalendarClient {
  private client: DavSession | null = null;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly calendarUrl: string,
  ) {}

  private async getClient(): Promise<DavSession> {
    if (this.client) return this.client;
    const client = await createDAVClient({
      serverUrl: "https://caldav.icloud.com",
      credentials: {
        username: this.username,
        password: this.password,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    this.client = client;
    return client;
  }

  private calendarRef() {
    return { url: this.calendarUrl };
  }

  private async fetchExistingObject(
    href: string,
  ): Promise<{ raw: string; parsed: ParsedCalendarEvent } | null> {
    try {
      const client = await this.getClient();
      const objects = await client.fetchCalendarObjects({
        calendar: this.calendarRef(),
        objectUrls: [href],
      });
      const raw = (objects as DAVObject[])[0]?.data;
      if (typeof raw !== "string" || !raw.trim()) return null;
      const parsed = parseFirstVEvent(raw);
      if (!parsed) return null;
      return { raw, parsed };
    } catch {
      return null;
    }
  }

  private toListItem(
    href: string,
    parsed: ParsedCalendarEvent,
    rawIcs?: string,
  ): CalendarRemoteEvent {
    return {
      uid: parsed.uid,
      href,
      title: parsed.title,
      start: parsed.start?.toISOString() ?? null,
      end: parsed.end?.toISOString() ?? null,
      notes: parsed.notes,
      location: parsed.location,
      geo: parsed.geo,
      recurrenceId: parsed.recurrenceId,
      recurrenceRule: parsed.recurrenceRule,
      isAllDay: parsed.isAllDay,
      cancelled: parsed.cancelled,
      sourceUpdatedAt: parsed.sourceUpdatedAt?.toISOString() ?? null,
      alarmMinutesBefore: parsed.alarmMinutesBefore,
      timeZone: parsed.timeZone,
      ...(rawIcs !== undefined ? { rawIcs } : {}),
    };
  }

  async createEvent(
    input: CalendarEventInput,
  ): Promise<CalendarClientResult<{ uid: string; href: string; end: Date }>> {
    try {
      const end = defaultEventEnd(input.start, input.end);
      const alarms = resolveAlarmMinutes(input.alarmMinutesBefore);
      const iCalString = buildVEventIcs(toIcsInput(input, end, alarms));
      const filename = `${input.uid}.ics`;
      const client = await this.getClient();
      await client.createCalendarObject({
        calendar: this.calendarRef(),
        filename,
        iCalString,
      });
      return {
        ok: true,
        data: {
          uid: input.uid,
          href: joinHref(this.calendarUrl, filename),
          end,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listEvents(opts: {
    from: Date;
    to: Date;
    limit?: number;
  }): Promise<CalendarClientResult<{ events: CalendarEventListItem[] }>> {
    try {
      const client = await this.getClient();
      const objects = await client.fetchCalendarObjects({
        calendar: this.calendarRef(),
        timeRange: {
          start: opts.from.toISOString(),
          end: opts.to.toISOString(),
        },
      });
      const limit = opts.limit ?? 50;
      const events: CalendarEventListItem[] = [];
      for (const obj of objects as DAVObject[]) {
        if (events.length >= limit) break;
        const raw = obj.data;
        if (typeof raw !== "string" || !raw.trim()) continue;
        const parsed = parseFirstVEvent(raw);
        if (!parsed || parsed.cancelled) continue;
        events.push(this.toListItem(obj.url, parsed));
      }
      return { ok: true, data: { events } };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async fetchAllEvents(): Promise<
    CalendarClientResult<{ events: CalendarRemoteEvent[]; complete: boolean }>
  > {
    try {
      const client = await this.getClient();
      const objects = await client.fetchCalendarObjects({
        calendar: this.calendarRef(),
      });
      const events: CalendarRemoteEvent[] = [];
      let parseFailures = 0;
      for (const obj of objects as DAVObject[]) {
        const raw = obj.data;
        if (typeof raw !== "string" || !raw.trim()) {
          parseFailures += 1;
          continue;
        }
        const parsedList = parseAllVEvents(raw);
        if (parsedList.length === 0) {
          parseFailures += 1;
          continue;
        }
        for (const parsed of parsedList) {
          events.push(this.toListItem(obj.url, parsed, raw));
        }
      }
      const complete = parseFailures === 0;
      return { ok: true, data: { events, complete } };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async updateEvent(
    href: string,
    patch: CalendarEventPatch,
  ): Promise<CalendarClientResult<{ uid: string; href: string; end: Date }>> {
    try {
      const existing = await this.fetchExistingObject(href);

      if (isAlarmsOnlyPatch(patch)) {
        if (!existing) {
          return {
            ok: false,
            error: "Could not fetch existing calendar event to update alarms",
          };
        }
        const iCalString = replaceValarmsInIcs(
          existing.raw,
          patch.alarmMinutesBefore!,
        );
        const client = await this.getClient();
        await client.updateCalendarObject({
          calendarObject: { url: href, data: iCalString },
        });
        const end =
          existing.parsed.end ??
          (existing.parsed.start
            ? defaultEventEnd(existing.parsed.start)
            : new Date());
        return { ok: true, data: { uid: patch.uid, href, end } };
      }

      const title = patch.title ?? existing?.parsed.title;
      const start = patch.start ?? existing?.parsed.start ?? undefined;
      if (!title || !start) {
        return {
          ok: false,
          error: "Calendar update requires title and start",
        };
      }

      let end: Date;
      if (patch.end) {
        end = patch.end;
      } else if (
        existing?.parsed.start &&
        existing.parsed.end &&
        existing.parsed.end.getTime() > existing.parsed.start.getTime()
      ) {
        const durationMs =
          existing.parsed.end.getTime() - existing.parsed.start.getTime();
        end = new Date(
          (patch.start ?? existing.parsed.start).getTime() + durationMs,
        );
      } else {
        end = defaultEventEnd(start, patch.end);
      }

      const description =
        patch.description !== undefined
          ? patch.description
          : patch.mapsUrl !== undefined
            ? mergeEventDescription({
                existingDescription: existing?.parsed.notes,
                mapsUrl: patch.mapsUrl,
              })
            : (existing?.parsed.notes ?? undefined);
      const location =
        patch.location !== undefined
          ? patch.location
          : (existing?.parsed.location ?? undefined);
      const geo =
        patch.geo !== undefined
          ? patch.geo
          : (existing?.parsed.geo ?? undefined);

      const alarms = resolveAlarmMinutes(
        patch.alarmMinutesBefore,
        existing?.parsed.alarmMinutesBefore ?? null,
      );

      let recurrenceRule: string | null | undefined;
      if (patch.recurrenceRule !== undefined) {
        recurrenceRule = patch.recurrenceRule;
      } else {
        recurrenceRule = existing?.parsed.recurrenceRule ?? undefined;
      }

      const iCalString = buildVEventIcs(
        toIcsInput(
          {
            uid: patch.uid,
            title,
            start,
            description: description || undefined,
            location: location || undefined,
            geo: geo || undefined,
            timeZone: patch.timeZone,
            recurrenceRule,
          },
          end,
          alarms,
        ),
      );
      const client = await this.getClient();
      await client.updateCalendarObject({
        calendarObject: {
          url: href,
          data: iCalString,
        },
      });
      return { ok: true, data: { uid: patch.uid, href, end } };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async deleteEvent(
    href: string,
  ): Promise<CalendarClientResult<{ deleted: true }>> {
    try {
      const client = await this.getClient();
      await client.deleteCalendarObject({
        calendarObject: { url: href },
      });
      return { ok: true, data: { deleted: true } };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async findEventByUid(
    uid: string,
  ): Promise<CalendarClientResult<{ event: CalendarRemoteEvent } | null>> {
    try {
      const result = await this.fetchAllEvents();
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      const event = result.data.events.find(
        (e) => e.uid === uid && !e.cancelled,
      );
      if (!event) {
        return { ok: true, data: null };
      }
      return { ok: true, data: { event } };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async fetchReminderLists(
    includeCalendars: boolean = false,
  ): Promise<CalendarClientResult<ListReminderListsResult>> {
    try {
      const client = await this.getClient();
      const calendars = await client.fetchCalendars();
      const lists = filterReminderLists(calendars, includeCalendars);
      return { ok: true, data: { lists } };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// --------------------------------------------------------------------------
// Reminders (VTODO) Client
// --------------------------------------------------------------------------

export interface ReminderListItem {
  uid: string;
  href: string;
  title: string;
  notes: string | null;
  due_iso: string | null;
  due_is_date: boolean;
  status: VTODOStatus;
  completed_at_iso: string | null;
  is_recurring: boolean;
}

export interface ReminderRemoteItem extends ReminderListItem {
  rawIcs?: string;
  recurrenceRule: string | null;
}

export interface ReminderInput {
  uid: string;
  title: string;
  notes?: string;
  due?: Date;
  dueIsDate?: boolean;
  timeZone: string;
}

export interface ReminderPatch {
  title?: string;
  notes?: string | null;
  due?: Date | null;
  dueIsDate?: boolean;
  timeZone: string;
}

export class TsdavICloudRemindersClient {
  private client: Awaited<ReturnType<typeof createDAVClient>> | null = null;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly remindersUrl: string,
  ) {}

  private async getClient() {
    if (this.client) return this.client;
    const client = await createDAVClient({
      serverUrl: "https://caldav.icloud.com",
      credentials: {
        username: this.username,
        password: this.password,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    this.client = client;
    return client;
  }

  private collectionRef() {
    return { url: this.remindersUrl };
  }

  private joinHref(filename: string): string {
    const base = this.remindersUrl.endsWith("/")
      ? this.remindersUrl
      : `${this.remindersUrl}/`;
    return new URL(filename, base).href;
  }

  private toListItem(href: string, parsed: ParsedReminder, rawIcs?: string): ReminderRemoteItem {
    return {
      uid: parsed.uid,
      href,
      title: parsed.title,
      notes: parsed.notes,
      due_iso: parsed.due?.toISOString() ?? null,
      due_is_date: parsed.dueIsDate,
      status: parsed.status,
      completed_at_iso: parsed.completedAt?.toISOString() ?? null,
      is_recurring: parsed.isRecurring,
      recurrenceRule: parsed.recurrenceRule,
      ...(rawIcs !== undefined ? { rawIcs } : {}),
    };
  }

  private async fetchExistingObject(
    href: string,
  ): Promise<{ raw: string; parsed: ParsedReminder } | null> {
    try {
      const client = await this.getClient();
      const objects = await client.fetchCalendarObjects({
        calendar: this.collectionRef(),
        objectUrls: [href],
      });
      const raw = (objects as DAVObject[])[0]?.data;
      if (typeof raw !== "string" || !raw.trim()) return null;
      const parsed = parseFirstVTODO(raw);
      if (!parsed) return null;
      return { raw, parsed };
    } catch {
      return null;
    }
  }

  /**
   * List reminders from the configured collection.
   * By default, returns only incomplete reminders (STATUS != COMPLETED).
   */
  async listReminders(opts?: {
    includeCompleted?: boolean;
    limit?: number;
  }): Promise<CalendarClientResult<{ reminders: ReminderListItem[] }>> {
    try {
      const client = await this.getClient();
      const objects = await client.fetchCalendarObjects({
        calendar: this.collectionRef(),
      });
      const limit = opts?.limit ?? 50;
      const includeCompleted = opts?.includeCompleted ?? false;
      const reminders: ReminderListItem[] = [];

      for (const obj of objects as DAVObject[]) {
        if (reminders.length >= limit) break;
        const raw = obj.data;
        if (typeof raw !== "string" || !raw.trim()) continue;
        const parsed = parseFirstVTODO(raw);
        if (!parsed) continue;
        if (!includeCompleted && parsed.status === "COMPLETED") continue;
        if (parsed.status === "CANCELLED") continue;
        reminders.push(this.toListItem(obj.url, parsed));
      }

      return { ok: true, data: { reminders } };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Fetch all reminders (including completed/cancelled) with raw ICS.
   */
  async fetchAllReminders(): Promise<
    CalendarClientResult<{ reminders: ReminderRemoteItem[]; complete: boolean }>
  > {
    try {
      const client = await this.getClient();
      const objects = await client.fetchCalendarObjects({
        calendar: this.collectionRef(),
      });
      const reminders: ReminderRemoteItem[] = [];
      let parseFailures = 0;

      for (const obj of objects as DAVObject[]) {
        const raw = obj.data;
        if (typeof raw !== "string" || !raw.trim()) {
          parseFailures += 1;
          continue;
        }
        const parsedList = parseAllVTODOs(raw);
        if (parsedList.length === 0) {
          parseFailures += 1;
          continue;
        }
        for (const parsed of parsedList) {
          reminders.push(this.toListItem(obj.url, parsed, raw));
        }
      }

      return { ok: true, data: { reminders, complete: parseFailures === 0 } };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Create a new reminder.
   */
  async createReminder(
    input: ReminderInput,
  ): Promise<CalendarClientResult<{ uid: string; href: string }>> {
    try {
      const vtodoInput: BuildVTODOInput = {
        uid: input.uid,
        title: input.title,
        notes: input.notes,
        due: input.due,
        dueIsDate: input.dueIsDate,
        timeZone: input.timeZone,
        status: "NEEDS-ACTION",
      };

      const iCalString = buildVTODOIcs(vtodoInput);
      const filename = `${input.uid}.ics`;
      const client = await this.getClient();

      await client.createCalendarObject({
        calendar: this.collectionRef(),
        filename,
        iCalString,
      });

      return {
        ok: true,
        data: {
          uid: input.uid,
          href: this.joinHref(filename),
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Mark a reminder as completed.
   * Refuses if the reminder is recurring (has RRULE).
   */
  async completeReminder(
    href: string,
    timeZone: string,
  ): Promise<CalendarClientResult<{ uid: string; href: string; completedAt: Date }>> {
    try {
      const existing = await this.fetchExistingObject(href);
      if (!existing) {
        return { ok: false, error: "Reminder not found" };
      }

      if (existing.parsed.isRecurring) {
        return {
          ok: false,
          error:
            "Cannot complete a recurring reminder via CalDAV. Recurring VTODOs (with RRULE) are not supported in v1. Use a native Reminders app to manage recurring tasks.",
        };
      }

      const iCalString = markVTODOCompleted(existing.raw, timeZone);
      const client = await this.getClient();

      await client.updateCalendarObject({
        calendarObject: { url: href, data: iCalString },
      });

      return {
        ok: true,
        data: {
          uid: existing.parsed.uid,
          href,
          completedAt: new Date(),
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Update a reminder's title, notes, or due date.
   * Refuses if the reminder is recurring (has RRULE).
   */
  async updateReminder(
    href: string,
    patch: ReminderPatch,
  ): Promise<CalendarClientResult<{ uid: string; href: string }>> {
    try {
      const existing = await this.fetchExistingObject(href);
      if (!existing) {
        return { ok: false, error: "Reminder not found" };
      }

      if (existing.parsed.isRecurring) {
        return {
          ok: false,
          error:
            "Cannot update a recurring reminder via CalDAV. Recurring VTODOs (with RRULE) are not supported in v1. Use a native Reminders app to manage recurring tasks.",
        };
      }

      const iCalString = patchVTODOIcs(existing.raw, {
        title: patch.title,
        notes: patch.notes,
        due: patch.due,
        dueIsDate: patch.dueIsDate,
        timeZone: patch.timeZone,
      });

      const client = await this.getClient();
      await client.updateCalendarObject({
        calendarObject: { url: href, data: iCalString },
      });

      return {
        ok: true,
        data: {
          uid: existing.parsed.uid,
          href,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Delete a reminder.
   * Refuses if the reminder is recurring (has RRULE).
   */
  async deleteReminder(
    href: string,
  ): Promise<CalendarClientResult<{ deleted: true }>> {
    try {
      const existing = await this.fetchExistingObject(href);
      if (existing?.parsed.isRecurring) {
        return {
          ok: false,
          error:
            "Cannot delete a recurring reminder via CalDAV. Recurring VTODOs (with RRULE) are not supported in v1. Use a native Reminders app to manage recurring tasks.",
        };
      }

      const client = await this.getClient();
      await client.deleteCalendarObject({
        calendarObject: { url: href },
      });

      return { ok: true, data: { deleted: true } };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Find a reminder by UID.
   */
  async findReminderByUid(
    uid: string,
  ): Promise<CalendarClientResult<{ reminder: ReminderRemoteItem } | null>> {
    try {
      const result = await this.fetchAllReminders();
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      const reminder = result.data.reminders.find(
        (r) => r.uid === uid && r.status !== "CANCELLED",
      );
      if (!reminder) {
        return { ok: true, data: null };
      }
      return { ok: true, data: { reminder } };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
