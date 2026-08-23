#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  startTelemetry,
  shutdownTelemetry,
  withToolTelemetry,
} from "./telemetry.js";
import {
  TsdavICloudCalendarClient,
  type CalendarEventInput,
  type CalendarEventPatch,
  type CalendarRemoteEvent,
} from "./calendar/icloud-client.js";
import {
  DEFAULT_ALARM_MINUTES_BEFORE,
  DEFAULT_EVENT_DURATION_MS,
  validateRRule,
} from "./calendar/ics.js";
import { assembleEventDescription } from "./calendar/event-description.js";
import {
  dayEndUtc,
  dayStartUtc,
  formatLocal,
  localDateString,
  parseZonedDateTime,
} from "./utils/time/index.js";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function getConfig() {
  const username = process.env.ICLOUD_CALDAV_USERNAME;
  const password = process.env.ICLOUD_CALDAV_PASSWORD;
  const calendarUrl = process.env.ICLOUD_CALDAV_CALENDAR_URL;
  const timeZone = process.env.USER_TIMEZONE ?? "America/Chicago";

  if (!username || !password || !calendarUrl) {
    throw new Error(
      "Missing required env vars: ICLOUD_CALDAV_USERNAME, ICLOUD_CALDAV_PASSWORD, ICLOUD_CALDAV_CALENDAR_URL",
    );
  }

  return { username, password, calendarUrl, timeZone };
}

function parseIso(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseToolDateTime(iso: string, timeZone: string): Date | null {
  return parseZonedDateTime(iso, timeZone);
}

function resolveCalendarListRange(opts: {
  from?: string;
  to?: string;
  timeZone: string;
  now?: Date;
}): { ok: true; from: Date; to: Date } | { ok: false; error: string } {
  const now = opts.now ?? new Date();
  const tz = opts.timeZone;

  const parseBound = (
    raw: string | undefined,
    role: "from" | "to",
  ): Date | null => {
    if (!raw) {
      return role === "from"
        ? now
        : new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    }
    const trimmed = raw.trim();
    if (DATE_ONLY_RE.test(trimmed)) {
      return role === "from"
        ? dayStartUtc(trimmed, tz)
        : dayEndUtc(trimmed, tz);
    }
    return parseIso(trimmed);
  };

  let from = parseBound(opts.from, "from");
  let to = parseBound(opts.to, "to");
  if (!from || !to) {
    return { ok: false, error: "Invalid from/to ISO timestamp" };
  }

  if (to.getTime() <= from.getTime()) {
    const day = localDateString(from, tz);
    from = dayStartUtc(day, tz);
    to = dayEndUtc(day, tz);
  }

  if (to.getTime() <= from.getTime()) {
    return {
      ok: false,
      error: "invalid timeRange: start must be before end",
    };
  }
  return { ok: true, from, to };
}

function publicDateTimes(
  start: Date,
  end: Date,
  timeZone: string,
): {
  start_iso: string;
  end_iso: string;
  start_local: string;
  end_local: string;
} {
  return {
    start_iso: start.toISOString(),
    end_iso: end.toISOString(),
    start_local: formatLocal(start, timeZone),
    end_local: formatLocal(end, timeZone),
  };
}

function publicOptionalDateTimes(
  start: Date | null | undefined,
  end: Date | null | undefined,
  timeZone: string,
): {
  start_iso: string | null;
  end_iso: string | null;
  start_local: string | null;
  end_local: string | null;
} {
  return {
    start_iso: start ? start.toISOString() : null,
    end_iso: end ? end.toISOString() : null,
    start_local: start ? formatLocal(start, timeZone) : null,
    end_local: end ? formatLocal(end, timeZone) : null,
  };
}

function icsLocationFromFields(opts: {
  locationName?: string | null;
  locationAddress?: string | null;
}): string | undefined {
  const address = opts.locationAddress?.trim();
  if (address) return address;
  const name = opts.locationName?.trim();
  return name || undefined;
}

function geoFromFields(opts: {
  locationLat?: number | null;
  locationLon?: number | null;
}): { lat: number; lon: number } | undefined {
  const lat = opts.locationLat;
  const lon = opts.locationLon;
  if (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    typeof lon === "number" &&
    Number.isFinite(lon)
  ) {
    return { lat, lon };
  }
  return undefined;
}

function alarmMinutesFromToolParam(
  value: number[] | null | undefined,
): number[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [...DEFAULT_ALARM_MINUTES_BEFORE];
  return value;
}

function createServer(config: ReturnType<typeof getConfig>) {
  const client = new TsdavICloudCalendarClient(
    config.username,
    config.password,
    config.calendarUrl,
  );
  const tz = () => config.timeZone;

  const server = new McpServer(
    { name: "apple-calendar", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "calendar_list",
    {
      description:
        "List Apple Calendar events in a time range. Default: now to +2 days. Use YYYY-MM-DD for a whole local day (from and to may be the same date). Each event includes start_iso/end_iso (machine) and start_local/end_local (human-readable). Recurring events include recurrence_rule (RFC 5545 RRULE body for masters) and recurrence_id (non-empty for exceptions/instances).",
      inputSchema: {
        from: z.string().optional().describe("ISO datetime or YYYY-MM-DD (local day start, inclusive). Default: now."),
        to: z.string().optional().describe("ISO datetime or YYYY-MM-DD (local day end, exclusive next midnight). Same date as from = that full day. Default: now + 2 days."),
        limit: z.number().int().min(1).max(100).optional().describe("Max events to return. Default: 30."),
      },
    },
    async ({ from, to, limit }) => {
      return withToolTelemetry("calendar_list", async () => {
        const timeZone = tz();
        const range = resolveCalendarListRange({ from, to, timeZone });
        if (!range.ok) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: range.error }) }] };
        }
        const { from: fromDate, to: toDate } = range;
        const maxResults = limit ?? 30;
        const listed = await client.listEvents({ from: fromDate, to: toDate, limit: maxResults });
        if (!listed.ok) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: listed.error }) }] };
        }
        const events = listed.data.events.map((e) => {
          const start = e.start ? parseIso(e.start) : null;
          const end = e.end ? parseIso(e.end) : null;
          return {
            uid: e.uid,
            href: e.href,
            title: e.title,
            notes: e.notes,
            location: e.location,
            geo: e.geo,
            recurrence_rule: e.recurrenceRule,
            recurrence_id: e.recurrenceId || null,
            is_recurring_master: Boolean(e.recurrenceRule && !e.recurrenceId),
            ...publicOptionalDateTimes(start, end, timeZone),
          };
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, data: { events, count: events.length } }) }],
        };
      });
    },
  );

  server.registerTool(
    "calendar_create_event",
    {
      description:
        "Create an Apple Calendar event, optionally recurring. start/end are user-local wall times: prefer naive ISO (2026-08-26T16:00:00) or numeric offset; Z = UTC. Default duration 30 minutes; default alarms at 1h and 15m before start. For recurring events, use rrule (RFC 5545 RRULE body) or the structured recurrence fields.",
      inputSchema: {
        title: z.string().min(1).describe("Event title"),
        start: z.string().min(1).describe("Event start. Naive YYYY-MM-DDTHH:MM is USER_TIMEZONE wall time. Z/offset is an absolute instant."),
        end: z.string().optional().describe("Optional end (same rules as start); default start + 30 minutes"),
        notes: z.string().optional().describe("Optional event notes"),
        alarm_minutes_before: z.array(z.number().int().nonnegative().max(10080)).nullable().optional().describe("Minutes before start for Apple Calendar alerts. Omit for default [60, 15]. Pass [] for no alerts."),
        rrule: z.string().optional().describe("RFC 5545 RRULE body without 'RRULE:' prefix. E.g. 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8'. Mutually exclusive with structured recurrence fields."),
        recurrence_freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).optional().describe("Recurrence frequency. Use with other recurrence_* fields instead of rrule."),
        recurrence_interval: z.number().int().min(1).optional().describe("Repeat every N freq periods. Default: 1."),
        recurrence_count: z.number().int().min(1).optional().describe("Number of occurrences. Mutually exclusive with recurrence_until."),
        recurrence_until: z.string().optional().describe("End date in YYYYMMDD or YYYYMMDDTHHMMSSZ format. Mutually exclusive with recurrence_count."),
        recurrence_byday: z.array(z.string()).optional().describe("Days of week for WEEKLY/MONTHLY/YEARLY: SU, MO, TU, WE, TH, FR, SA."),
        location_name: z.string().min(1).nullable().optional().describe("Place name"),
        location_address: z.string().min(1).nullable().optional().describe("Address for Apple Calendar LOCATION"),
        location_maps_url: z.string().url().nullable().optional().describe("Maps URL to include in event description"),
        location_lat: z.number().finite().nullable().optional(),
        location_lon: z.number().finite().nullable().optional(),
      },
    },
    async (args) => {
      return withToolTelemetry("calendar_create_event", async () => {
        const hasRrule = args.rrule !== undefined;
      const hasStructuredRecurrence =
        args.recurrence_freq !== undefined ||
        args.recurrence_interval !== undefined ||
        args.recurrence_count !== undefined ||
        args.recurrence_until !== undefined ||
        args.recurrence_byday !== undefined;

      if (hasRrule && hasStructuredRecurrence) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "Cannot use both 'rrule' and structured recurrence fields (recurrence_freq, etc.). Use one or the other.",
            }),
          }],
        };
      }

      let recurrenceRule: string | undefined;

      if (hasRrule) {
        const validation = validateRRule(args.rrule!);
        if (!validation.valid) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ ok: false, error: `Invalid RRULE: ${validation.error}` }),
            }],
          };
        }
        recurrenceRule = validation.normalized;
      } else if (hasStructuredRecurrence) {
        if (!args.recurrence_freq) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "recurrence_freq is required when using structured recurrence fields",
              }),
            }],
          };
        }
        if (args.recurrence_count !== undefined && args.recurrence_until !== undefined) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "Cannot use both recurrence_count and recurrence_until",
              }),
            }],
          };
        }

        const parts: string[] = [`FREQ=${args.recurrence_freq}`];
        if (args.recurrence_interval !== undefined) {
          parts.push(`INTERVAL=${args.recurrence_interval}`);
        }
        if (args.recurrence_count !== undefined) {
          parts.push(`COUNT=${args.recurrence_count}`);
        }
        if (args.recurrence_until !== undefined) {
          parts.push(`UNTIL=${args.recurrence_until}`);
        }
        if (args.recurrence_byday !== undefined && args.recurrence_byday.length > 0) {
          parts.push(`BYDAY=${args.recurrence_byday.join(",").toUpperCase()}`);
        }

        const builtRrule = parts.join(";");
        const validation = validateRRule(builtRrule);
        if (!validation.valid) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ ok: false, error: `Invalid recurrence: ${validation.error}` }),
            }],
          };
        }
        recurrenceRule = validation.normalized;
      }

      const timeZone = tz();
      const start = parseToolDateTime(args.start, timeZone);
      if (!start) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Invalid start ISO timestamp" }) }] };
      }
      let end: Date;
      if (args.end) {
        const e = parseToolDateTime(args.end, timeZone);
        if (!e) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Invalid end ISO timestamp" }) }] };
        }
        if (e.getTime() <= start.getTime()) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "end must be after start" }) }] };
        }
        end = e;
      } else {
        end = new Date(start.getTime() + DEFAULT_EVENT_DURATION_MS);
      }

      const loc = {
        locationName: args.location_name ?? null,
        locationAddress: args.location_address ?? null,
        locationMapsUrl: args.location_maps_url ?? null,
        locationLat: args.location_lat ?? null,
        locationLon: args.location_lon ?? null,
      };

      const alarms = alarmMinutesFromToolParam(args.alarm_minutes_before);
      const resolvedAlarms = alarms === undefined ? [...DEFAULT_ALARM_MINUTES_BEFORE] : alarms;

      const uid = randomUUID();
      const input: CalendarEventInput = {
        uid,
        title: args.title,
        start,
        end,
        timeZone,
        location: icsLocationFromFields(loc),
        geo: geoFromFields(loc),
        description: assembleEventDescription({
          notes: args.notes,
          mapsUrl: loc.locationMapsUrl,
        }),
        alarmMinutesBefore: resolvedAlarms,
        recurrenceRule,
      };

      const created = await client.createEvent(input);
      if (!created.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: created.error }) }] };
      }

      const times = publicDateTimes(start, created.data.end, timeZone);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            data: {
              uid: created.data.uid,
              href: created.data.href,
              title: args.title,
              notes: args.notes ?? null,
              location: icsLocationFromFields(loc) ?? null,
              ...times,
            },
          }),
        }],
      };
      });
    },
  );

  server.registerTool(
    "calendar_update_event",
    {
      description:
        "Update an Apple Calendar event by uid or href. Only pass fields you want to change — omitted fields (including duration and recurrence rule) are preserved. Omit alarm_minutes_before to keep existing alerts; pass [] to clear, null to restore default 1h+15m. For recurring events: updates the entire series (master). Updating a single occurrence is not supported — if the target has a recurrence_id (is an instance), this returns an error.",
      inputSchema: {
        uid: z.string().min(1).optional().describe("Event UID (will lookup href via CalDAV if needed)"),
        href: z.string().min(1).optional().describe("Event href (CalDAV URL) - preferred if known"),
        title: z.string().min(1).optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        notes: z.string().optional(),
        alarm_minutes_before: z.array(z.number().int().nonnegative().max(10080)).nullable().optional().describe("Minutes before start for alerts. Omit to preserve existing. [] clears. null restores default [60, 15]."),
        rrule: z.string().nullable().optional().describe("RFC 5545 RRULE body to set/replace recurrence. Omit to preserve existing RRULE. Pass empty string or null to clear (make non-recurring)."),
        clear_recurrence: z.boolean().optional().describe("Set to true to remove recurrence and make the event non-recurring. Equivalent to rrule=''."),
        location_name: z.string().min(1).nullable().optional(),
        location_address: z.string().min(1).nullable().optional(),
        location_maps_url: z.string().url().nullable().optional(),
        location_lat: z.number().finite().nullable().optional(),
        location_lon: z.number().finite().nullable().optional(),
      },
    },
    async (args) => {
      return withToolTelemetry("calendar_update_event", async () => {
        if (!args.uid && !args.href) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Provide uid or href" }) }] };
        }

      let href = args.href;
      let eventUid = args.uid;
      let existingEvent: CalendarRemoteEvent | null = null;

      if (!href && eventUid) {
        const found = await client.findEventByUid(eventUid);
        if (!found.ok) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: found.error }) }] };
        }
        if (!found.data) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Event not found by UID" }) }] };
        }
        href = found.data.event.href;
        existingEvent = found.data.event;
        eventUid = found.data.event.uid;
      }

      if (!href) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Provide uid or href" }) }] };
      }

      if (existingEvent?.recurrenceId) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "Cannot update a single recurrence instance. The target event has a recurrence_id, meaning it is an exception to a recurring series. To update the entire series, use the master event's UID (without recurrence_id). Updating individual instances is not supported.",
            }),
          }],
        };
      }

      const timeZone = tz();
      const patch: CalendarEventPatch = { uid: eventUid ?? "", timeZone };

      if (args.clear_recurrence === true) {
        patch.recurrenceRule = null;
      } else if (args.rrule !== undefined) {
        if (args.rrule === null || args.rrule === "") {
          patch.recurrenceRule = null;
        } else {
          const validation = validateRRule(args.rrule);
          if (!validation.valid) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ ok: false, error: `Invalid RRULE: ${validation.error}` }),
              }],
            };
          }
          patch.recurrenceRule = validation.normalized;
        }
      }

      if (args.title !== undefined) {
        patch.title = args.title;
      }

      if (args.start !== undefined) {
        const d = parseToolDateTime(args.start, timeZone);
        if (!d) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Invalid start" }) }] };
        }
        patch.start = d;
      }

      if (args.end !== undefined) {
        const d = parseToolDateTime(args.end, timeZone);
        if (!d) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Invalid end" }) }] };
        }
        patch.end = d;
      }

      if (args.notes !== undefined) {
        patch.description = assembleEventDescription({
          notes: args.notes,
          mapsUrl: args.location_maps_url ?? null,
        });
      }

      const locationInputProvided =
        args.location_name !== undefined ||
        args.location_address !== undefined ||
        args.location_maps_url !== undefined ||
        args.location_lat !== undefined ||
        args.location_lon !== undefined;

      if (locationInputProvided) {
        const loc = {
          locationName: args.location_name ?? null,
          locationAddress: args.location_address ?? null,
          locationLat: args.location_lat ?? null,
          locationLon: args.location_lon ?? null,
        };
        patch.location = icsLocationFromFields(loc);
        const geo = geoFromFields(loc);
        if (geo) patch.geo = geo;
        if (args.notes === undefined && args.location_maps_url !== undefined) {
          patch.mapsUrl = args.location_maps_url ?? null;
        }
      }

      if (args.alarm_minutes_before !== undefined) {
        patch.alarmMinutesBefore = alarmMinutesFromToolParam(args.alarm_minutes_before);
      }

      const updated = await client.updateEvent(href, patch);
      if (!updated.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: updated.error }) }] };
      }

      const resultStart = patch.start ?? (existingEvent?.start ? parseIso(existingEvent.start) : null);
      const times = resultStart
        ? publicDateTimes(resultStart, updated.data.end, timeZone)
        : {
            start_iso: existingEvent?.start ?? null,
            end_iso: updated.data.end.toISOString(),
            start_local: existingEvent?.start ? formatLocal(parseIso(existingEvent.start)!, timeZone) : null,
            end_local: formatLocal(updated.data.end, timeZone),
          };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            data: { uid: updated.data.uid, href: updated.data.href, ...times },
          }),
        }],
      };
      });
    },
  );

  server.registerTool(
    "calendar_delete_event",
    {
      description:
        "Delete an Apple Calendar event by uid or href. For recurring events: deletes the entire series (the .ics object). Deleting a single occurrence is not supported — if the target has a recurrence_id (is an instance) and you want to delete just that instance, this returns an error with instructions.",
      inputSchema: {
        uid: z.string().min(1).optional().describe("Event UID (will lookup href via CalDAV if needed)"),
        href: z.string().min(1).optional().describe("Event href (CalDAV URL) - preferred if known"),
      },
    },
    async (args) => {
      return withToolTelemetry("calendar_delete_event", async () => {
        if (!args.uid && !args.href) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Provide uid or href" }) }] };
        }

      let href = args.href;
      let eventUid = args.uid;
      let existingEvent: CalendarRemoteEvent | null = null;

      if (!href && eventUid) {
        const found = await client.findEventByUid(eventUid);
        if (!found.ok) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: found.error }) }] };
        }
        if (!found.data) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Event not found by UID" }) }] };
        }
        href = found.data.event.href;
        eventUid = found.data.event.uid;
        existingEvent = found.data.event;
      }

      if (!href) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Provide uid or href" }) }] };
      }

      if (existingEvent?.recurrenceId) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "Cannot delete a single recurrence instance. The target event has a recurrence_id, meaning it is an exception to a recurring series. Deleting the master event will delete the entire series. To delete individual instances, use a calendar app directly or cancel the instance. Instance-only deletion via CalDAV is not supported.",
            }),
          }],
        };
      }

      const deleted = await client.deleteEvent(href);
      if (!deleted.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: deleted.error }) }] };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, data: { deleted: true, uid: eventUid, href } }),
        }],
      };
      });
    },
  );

  return server;
}

async function main() {
  startTelemetry();

  const config = getConfig();
  const PORT = parseInt(process.env.PORT ?? "8792", 10);
  const HOST = process.env.HOST ?? "0.0.0.0";

  const app = createMcpExpressApp({ host: HOST });

  const transports: Map<string, StreamableHTTPServerTransport> = new Map();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "apple-calendar-mcp", version: "0.1.0" });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        const server = createServer(config);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  app.listen(PORT, HOST, () => {
    console.error(`Apple Calendar MCP server listening on http://${HOST}:${PORT}`);
    console.error(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
    console.error(`Health check: http://${HOST}:${PORT}/health`);
  });

  process.on("SIGINT", async () => {
    console.error("Shutting down...");
    await shutdownTelemetry();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.error("Shutting down...");
    await shutdownTelemetry();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
