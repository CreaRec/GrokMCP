import { describe, it, expect } from "vitest";
import { planIndexWork } from "./index-plan.js";
import { classifyFileRoute, routeNeedsQwen } from "./file-route.js";
import { getDirectParentFolderPath } from "./dirty.js";

describe("planIndexWork", () => {
  it("returns none when no qwen files and no dirty folders", () => {
    expect(planIndexWork(0, 0)).toBe("none");
  });

  it("returns gpu_vision when any file needs qwen", () => {
    expect(planIndexWork(1, 0)).toBe("gpu_vision");
    expect(planIndexWork(3, 5)).toBe("gpu_vision");
  });

  it("returns cpu_folders when only folders are dirty", () => {
    expect(planIndexWork(0, 2)).toBe("cpu_folders");
  });

  it("skip-only dirty does not trigger GPU (qwen count is zero)", () => {
    const skipFiles = ["song.mp3", "clip.wav", "README"];
    const qwenCount = skipFiles.filter((name) =>
      routeNeedsQwen(classifyFileRoute(name)),
    ).length;

    expect(qwenCount).toBe(0);
    expect(planIndexWork(qwenCount, 0)).toBe("none");
  });

  it("plain-text-only dirty triggers gpu_vision (qwen-text route)", () => {
    const files = ["notes.txt", "schema.sql", "app.js"];
    const qwenCount = files.filter((name) =>
      routeNeedsQwen(classifyFileRoute(name)),
    ).length;

    expect(qwenCount).toBe(3);
    expect(planIndexWork(qwenCount, 0)).toBe("gpu_vision");
  });
});

describe("folder dirty on child change", () => {
  it("marks direct parent on file soft-delete (child disappearance)", () => {
    const parent = getDirectParentFolderPath("/Documents/Finance/report.pdf");
    expect(parent).toBe("/Documents/Finance");
  });
});
