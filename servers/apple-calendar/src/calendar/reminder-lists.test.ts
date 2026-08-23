import { describe, it, expect } from "vitest";
import type { DAVCalendar } from "tsdav";
import {
  parseComponentTypes,
  supportsVTODO,
  filterReminderLists,
} from "./icloud-client.js";

const createCalendarFixture = (
  overrides: Partial<DAVCalendar>,
): DAVCalendar =>
  ({
    url: "/caldav/v2/user/calendar/default/",
    displayName: "Default Calendar",
    components: ["VEVENT"],
    resourcetype: "",
    syncToken: "sync-token",
    ...overrides,
  }) as DAVCalendar;

describe("parseComponentTypes", () => {
  it("returns empty array when no components", () => {
    const calendar = createCalendarFixture({ components: undefined });
    expect(parseComponentTypes(calendar)).toEqual([]);
  });

  it("returns empty array for non-array components", () => {
    const calendar = createCalendarFixture({
      components: "VEVENT" as unknown as string[],
    });
    expect(parseComponentTypes(calendar)).toEqual([]);
  });

  it("parses VEVENT component", () => {
    const calendar = createCalendarFixture({ components: ["VEVENT"] });
    expect(parseComponentTypes(calendar)).toEqual(["VEVENT"]);
  });

  it("parses VTODO component", () => {
    const calendar = createCalendarFixture({ components: ["VTODO"] });
    expect(parseComponentTypes(calendar)).toEqual(["VTODO"]);
  });

  it("parses mixed components", () => {
    const calendar = createCalendarFixture({
      components: ["VEVENT", "VTODO"],
    });
    expect(parseComponentTypes(calendar)).toEqual(["VEVENT", "VTODO"]);
  });

  it("normalizes component names to uppercase", () => {
    const calendar = createCalendarFixture({
      components: ["vevent", "vtodo"],
    });
    expect(parseComponentTypes(calendar)).toEqual(["VEVENT", "VTODO"]);
  });
});

describe("supportsVTODO", () => {
  it("returns true when VTODO is present", () => {
    expect(supportsVTODO(["VTODO"])).toBe(true);
    expect(supportsVTODO(["VEVENT", "VTODO"])).toBe(true);
  });

  it("returns false when VTODO is not present", () => {
    expect(supportsVTODO([])).toBe(false);
    expect(supportsVTODO(["VEVENT"])).toBe(false);
  });
});

describe("filterReminderLists", () => {
  const fixtures: DAVCalendar[] = [
    createCalendarFixture({
      url: "/caldav/v2/user/calendar/work/",
      displayName: "Work",
      components: ["VEVENT"],
    }),
    createCalendarFixture({
      url: "/caldav/v2/user/calendar/reminders/",
      displayName: "Reminders",
      components: ["VTODO"],
    }),
    createCalendarFixture({
      url: "/caldav/v2/user/calendar/tasks/",
      displayName: "Tasks",
      components: ["VTODO"],
    }),
    createCalendarFixture({
      url: "/caldav/v2/user/calendar/mixed/",
      displayName: "Mixed",
      components: ["VEVENT", "VTODO"],
    }),
    createCalendarFixture({
      url: "/caldav/v2/user/calendar/personal/",
      displayName: "Personal",
      components: ["VEVENT"],
    }),
    createCalendarFixture({
      url: "/caldav/v2/user/calendar/empty/",
      displayName: undefined as unknown as string,
      components: [],
    }),
  ];

  it("filters to only VTODO collections by default", () => {
    const result = filterReminderLists(fixtures);

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.name)).toEqual(["Reminders", "Tasks", "Mixed"]);
  });

  it("includes href for each reminder list", () => {
    const result = filterReminderLists(fixtures);

    expect(result[0].href).toBe("/caldav/v2/user/calendar/reminders/");
    expect(result[1].href).toBe("/caldav/v2/user/calendar/tasks/");
    expect(result[2].href).toBe("/caldav/v2/user/calendar/mixed/");
  });

  it("includes components for each reminder list", () => {
    const result = filterReminderLists(fixtures);

    expect(result[0].components).toEqual(["VTODO"]);
    expect(result[1].components).toEqual(["VTODO"]);
    expect(result[2].components).toEqual(["VEVENT", "VTODO"]);
  });

  it("includes calendars when include_calendars is true", () => {
    const result = filterReminderLists(fixtures, true);

    expect(result).toHaveLength(5);
    expect(result.map((r) => r.name)).toEqual([
      "Work",
      "Reminders",
      "Tasks",
      "Mixed",
      "Personal",
    ]);
  });

  it("handles undefined displayName gracefully", () => {
    const calendars = [
      createCalendarFixture({
        url: "/caldav/v2/user/calendar/unnamed/",
        displayName: undefined as unknown as string,
        components: ["VTODO"],
      }),
    ];

    const result = filterReminderLists(calendars);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Untitled");
  });

  it("returns empty array when no matching collections", () => {
    const calendars = [
      createCalendarFixture({
        url: "/caldav/v2/user/calendar/only-events/",
        displayName: "Only Events",
        components: ["VEVENT"],
      }),
    ];

    const result = filterReminderLists(calendars);

    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    const result = filterReminderLists([]);
    expect(result).toHaveLength(0);
  });
});
