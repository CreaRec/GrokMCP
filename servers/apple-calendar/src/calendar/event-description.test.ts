import { describe, expect, it } from "vitest";
import {
  assembleEventDescription,
  mergeEventDescription,
  stripMapsUrlsFromDescription,
} from "./event-description.js";

describe("assembleEventDescription", () => {
  it("joins notes and maps URL", () => {
    expect(
      assembleEventDescription({
        notes: "bring ID",
        mapsUrl: "https://maps.google.com/?cid=1",
      }),
    ).toBe("bring ID\nhttps://maps.google.com/?cid=1");
  });

  it("returns maps-only when notes empty", () => {
    expect(
      assembleEventDescription({
        mapsUrl: "https://maps.google.com/?cid=1",
      }),
    ).toBe("https://maps.google.com/?cid=1");
  });
});

describe("stripMapsUrlsFromDescription", () => {
  it("removes Google Maps lines and keeps free text", () => {
    expect(
      stripMapsUrlsFromDescription(
        "bring ID\nhttps://maps.google.com/?cid=1&g_mp=x",
      ),
    ).toBe("bring ID");
  });
});

describe("mergeEventDescription", () => {
  it("appends maps URL to existing free-text notes", () => {
    expect(
      mergeEventDescription({
        existingDescription: "bring ID",
        mapsUrl: "https://maps.google.com/?cid=1",
      }),
    ).toBe("bring ID\nhttps://maps.google.com/?cid=1");
  });

  it("replaces a prior maps URL without dropping notes", () => {
    expect(
      mergeEventDescription({
        existingDescription: "note\nhttps://maps.google.com/?cid=old",
        mapsUrl: "https://maps.google.com/?cid=new",
      }),
    ).toBe("note\nhttps://maps.google.com/?cid=new");
  });

  it("adds maps URL when existing description was empty", () => {
    expect(
      mergeEventDescription({
        existingDescription: null,
        mapsUrl: "https://maps.google.com/?cid=1",
      }),
    ).toBe("https://maps.google.com/?cid=1");
  });

  it("uses explicitNotes when provided", () => {
    expect(
      mergeEventDescription({
        existingDescription: "old",
        explicitNotes: "new notes",
        mapsUrl: "https://maps.google.com/?cid=1",
      }),
    ).toBe("new notes\nhttps://maps.google.com/?cid=1");
  });
});
