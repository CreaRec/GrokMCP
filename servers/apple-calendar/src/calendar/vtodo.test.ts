import { describe, it, expect } from "vitest";
import {
  buildVTODOIcs,
  parseFirstVTODO,
  parseAllVTODOs,
  patchVTODOIcs,
  markVTODOCompleted,
  type VTODOStatus,
} from "./ics.js";

const CHICAGO_TZ = "America/Chicago";

describe("buildVTODOIcs", () => {
  it("builds a minimal VTODO with title only", () => {
    const ics = buildVTODOIcs({
      uid: "test-uid-123",
      title: "Buy groceries",
      timeZone: CHICAGO_TZ,
    });

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VTODO");
    expect(ics).toContain("UID:test-uid-123");
    expect(ics).toContain("SUMMARY:Buy groceries");
    expect(ics).toContain("STATUS:NEEDS-ACTION");
    expect(ics).toContain("END:VTODO");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("DUE");
    expect(ics).not.toContain("COMPLETED");
  });

  it("builds a VTODO with notes", () => {
    const ics = buildVTODOIcs({
      uid: "test-uid-456",
      title: "Call dentist",
      notes: "Schedule annual checkup",
      timeZone: CHICAGO_TZ,
    });

    expect(ics).toContain("DESCRIPTION:Schedule annual checkup");
  });

  it("builds a VTODO with date-time DUE", () => {
    const due = new Date("2026-08-25T14:00:00Z");
    const ics = buildVTODOIcs({
      uid: "test-uid-789",
      title: "Meeting prep",
      due,
      dueIsDate: false,
      timeZone: CHICAGO_TZ,
    });

    expect(ics).toMatch(/DUE;TZID=America\/Chicago:\d{8}T\d{6}/);
    expect(ics).not.toContain("VALUE=DATE");
  });

  it("builds a VTODO with date-only DUE", () => {
    const due = new Date("2026-08-25T05:00:00Z"); // Midnight CDT
    const ics = buildVTODOIcs({
      uid: "test-uid-date",
      title: "Submit report",
      due,
      dueIsDate: true,
      timeZone: CHICAGO_TZ,
    });

    expect(ics).toMatch(/DUE;VALUE=DATE:\d{8}/);
    expect(ics).toContain("20260825");
  });

  it("builds a COMPLETED VTODO with timestamp", () => {
    const completedAt = new Date("2026-08-20T10:30:00Z");
    const ics = buildVTODOIcs({
      uid: "test-uid-done",
      title: "Finished task",
      timeZone: CHICAGO_TZ,
      status: "COMPLETED",
      completedAt,
    });

    expect(ics).toContain("STATUS:COMPLETED");
    expect(ics).toMatch(/COMPLETED:\d{8}T\d{6}Z/);
  });

  it("escapes special characters in title and notes", () => {
    const ics = buildVTODOIcs({
      uid: "test-escape",
      title: "Task; with, special\\chars",
      notes: "Line1\nLine2",
      timeZone: CHICAGO_TZ,
    });

    expect(ics).toContain("SUMMARY:Task\\; with\\, special\\\\chars");
    expect(ics).toContain("DESCRIPTION:Line1\\nLine2");
  });
});

describe("parseFirstVTODO", () => {
  it("parses a minimal VTODO", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:parse-test-1
DTSTAMP:20260820T100000Z
SUMMARY:Simple task
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR`;

    const parsed = parseFirstVTODO(ics);
    expect(parsed).not.toBeNull();
    expect(parsed!.uid).toBe("parse-test-1");
    expect(parsed!.title).toBe("Simple task");
    expect(parsed!.status).toBe("NEEDS-ACTION");
    expect(parsed!.due).toBeNull();
    expect(parsed!.completedAt).toBeNull();
    expect(parsed!.isRecurring).toBe(false);
  });

  it("parses VTODO with date-time DUE", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:parse-due-datetime
DTSTAMP:20260820T100000Z
SUMMARY:Task with due time
STATUS:NEEDS-ACTION
DUE;TZID=America/Chicago:20260825T140000
END:VTODO
END:VCALENDAR`;

    const parsed = parseFirstVTODO(ics);
    expect(parsed).not.toBeNull();
    expect(parsed!.due).toBeInstanceOf(Date);
    expect(parsed!.dueIsDate).toBe(false);
    expect(parsed!.timeZone).toBe("America/Chicago");
  });

  it("parses VTODO with date-only DUE", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:parse-due-date
DTSTAMP:20260820T100000Z
SUMMARY:Date-only due
STATUS:NEEDS-ACTION
DUE;VALUE=DATE:20260825
END:VTODO
END:VCALENDAR`;

    const parsed = parseFirstVTODO(ics);
    expect(parsed).not.toBeNull();
    expect(parsed!.due).toBeInstanceOf(Date);
    expect(parsed!.dueIsDate).toBe(true);
  });

  it("parses COMPLETED status and timestamp", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:parse-completed
DTSTAMP:20260820T100000Z
SUMMARY:Completed task
STATUS:COMPLETED
COMPLETED:20260819T153000Z
END:VTODO
END:VCALENDAR`;

    const parsed = parseFirstVTODO(ics);
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe("COMPLETED");
    expect(parsed!.completedAt).toBeInstanceOf(Date);
    expect(parsed!.completedAt!.toISOString()).toBe("2026-08-19T15:30:00.000Z");
  });

  it("detects recurring VTODO with RRULE", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:parse-recurring
DTSTAMP:20260820T100000Z
SUMMARY:Recurring task
STATUS:NEEDS-ACTION
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VTODO
END:VCALENDAR`;

    const parsed = parseFirstVTODO(ics);
    expect(parsed).not.toBeNull();
    expect(parsed!.isRecurring).toBe(true);
    expect(parsed!.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  it("parses DESCRIPTION with escaped characters", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:parse-escaped
DTSTAMP:20260820T100000Z
SUMMARY:Task
STATUS:NEEDS-ACTION
DESCRIPTION:Line1\\nLine2\\, with comma
END:VTODO
END:VCALENDAR`;

    const parsed = parseFirstVTODO(ics);
    expect(parsed).not.toBeNull();
    expect(parsed!.notes).toBe("Line1\nLine2, with comma");
  });

  it("returns null for non-VTODO content", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-123
SUMMARY:Not a todo
END:VEVENT
END:VCALENDAR`;

    const parsed = parseFirstVTODO(ics);
    expect(parsed).toBeNull();
  });
});

describe("parseAllVTODOs", () => {
  it("parses multiple VTODOs from one file", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:multi-1
SUMMARY:First task
STATUS:NEEDS-ACTION
END:VTODO
BEGIN:VTODO
UID:multi-2
SUMMARY:Second task
STATUS:COMPLETED
COMPLETED:20260820T100000Z
END:VTODO
END:VCALENDAR`;

    const parsed = parseAllVTODOs(ics);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].uid).toBe("multi-1");
    expect(parsed[1].uid).toBe("multi-2");
    expect(parsed[1].status).toBe("COMPLETED");
  });
});

describe("patchVTODOIcs", () => {
  const baseIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:patch-test
DTSTAMP:20260820T100000Z
SUMMARY:Original title
DESCRIPTION:Original notes
STATUS:NEEDS-ACTION
DUE;TZID=America/Chicago:20260825T140000
END:VTODO
END:VCALENDAR`;

  it("patches title while preserving other fields", () => {
    const patched = patchVTODOIcs(baseIcs, {
      title: "Updated title",
      timeZone: CHICAGO_TZ,
    });

    const parsed = parseFirstVTODO(patched);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("Updated title");
    expect(parsed!.notes).toBe("Original notes");
    expect(parsed!.due).not.toBeNull();
  });

  it("patches notes while preserving other fields", () => {
    const patched = patchVTODOIcs(baseIcs, {
      notes: "Updated notes",
      timeZone: CHICAGO_TZ,
    });

    const parsed = parseFirstVTODO(patched);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("Original title");
    expect(parsed!.notes).toBe("Updated notes");
  });

  it("clears notes when set to null", () => {
    const patched = patchVTODOIcs(baseIcs, {
      notes: null,
      timeZone: CHICAGO_TZ,
    });

    const parsed = parseFirstVTODO(patched);
    expect(parsed).not.toBeNull();
    expect(parsed!.notes).toBeNull();
  });

  it("clears due date when set to null", () => {
    const patched = patchVTODOIcs(baseIcs, {
      due: null,
      timeZone: CHICAGO_TZ,
    });

    const parsed = parseFirstVTODO(patched);
    expect(parsed).not.toBeNull();
    expect(parsed!.due).toBeNull();
  });

  it("updates due date", () => {
    const newDue = new Date("2026-09-01T10:00:00Z");
    const patched = patchVTODOIcs(baseIcs, {
      due: newDue,
      dueIsDate: false,
      timeZone: CHICAGO_TZ,
    });

    const parsed = parseFirstVTODO(patched);
    expect(parsed).not.toBeNull();
    expect(parsed!.due).not.toBeNull();
    expect(parsed!.dueIsDate).toBe(false);
  });

  it("throws when parsing invalid ICS", () => {
    expect(() => {
      patchVTODOIcs("invalid ics content", { timeZone: CHICAGO_TZ });
    }).toThrow("Could not parse existing VTODO");
  });
});

describe("markVTODOCompleted", () => {
  it("marks a NEEDS-ACTION VTODO as completed", () => {
    const baseIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:complete-test
DTSTAMP:20260820T100000Z
SUMMARY:Task to complete
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR`;

    const completed = markVTODOCompleted(baseIcs, CHICAGO_TZ);
    const parsed = parseFirstVTODO(completed);

    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe("COMPLETED");
    expect(parsed!.completedAt).not.toBeNull();
    expect(parsed!.completedAt).toBeInstanceOf(Date);
  });

  it("preserves title and notes when completing", () => {
    const baseIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:complete-preserve
DTSTAMP:20260820T100000Z
SUMMARY:Important task
DESCRIPTION:Must not lose these notes
STATUS:NEEDS-ACTION
DUE;VALUE=DATE:20260825
END:VTODO
END:VCALENDAR`;

    const completed = markVTODOCompleted(baseIcs, CHICAGO_TZ);
    const parsed = parseFirstVTODO(completed);

    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("Important task");
    expect(parsed!.notes).toBe("Must not lose these notes");
    expect(parsed!.status).toBe("COMPLETED");
    expect(parsed!.due).not.toBeNull();
  });
});

describe("recurring VTODO detection", () => {
  it("detects various RRULE formats", () => {
    const testCases = [
      "RRULE:FREQ=DAILY",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=15",
      "RRULE:FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1",
    ];

    for (const rrule of testCases) {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:recurring-test
DTSTAMP:20260820T100000Z
SUMMARY:Recurring
STATUS:NEEDS-ACTION
${rrule}
END:VTODO
END:VCALENDAR`;

      const parsed = parseFirstVTODO(ics);
      expect(parsed?.isRecurring).toBe(true);
    }
  });

  it("non-recurring VTODO has isRecurring=false", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:not-recurring
DTSTAMP:20260820T100000Z
SUMMARY:One-time task
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR`;

    const parsed = parseFirstVTODO(ics);
    expect(parsed?.isRecurring).toBe(false);
    expect(parsed?.recurrenceRule).toBeNull();
  });
});

describe("VTODO status parsing", () => {
  const statuses: VTODOStatus[] = ["NEEDS-ACTION", "COMPLETED", "IN-PROCESS", "CANCELLED"];

  for (const status of statuses) {
    it(`parses STATUS=${status}`, () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:status-test-${status}
DTSTAMP:20260820T100000Z
SUMMARY:Task
STATUS:${status}
END:VTODO
END:VCALENDAR`;

      const parsed = parseFirstVTODO(ics);
      expect(parsed?.status).toBe(status);
    });
  }

  it("defaults to NEEDS-ACTION for unknown status", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:unknown-status
DTSTAMP:20260820T100000Z
SUMMARY:Task
STATUS:UNKNOWN
END:VTODO
END:VCALENDAR`;

    const parsed = parseFirstVTODO(ics);
    expect(parsed?.status).toBe("NEEDS-ACTION");
  });

  it("defaults to NEEDS-ACTION when STATUS is missing", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:no-status
DTSTAMP:20260820T100000Z
SUMMARY:Task
END:VTODO
END:VCALENDAR`;

    const parsed = parseFirstVTODO(ics);
    expect(parsed?.status).toBe("NEEDS-ACTION");
  });
});
