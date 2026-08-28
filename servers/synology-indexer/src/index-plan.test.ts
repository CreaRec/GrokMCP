import { describe, it, expect } from "vitest";
import { planIndexWork } from "./index-plan.js";
import { classifyFileRoute, routeNeedsQwen } from "./file-route.js";
import { getDirectParentFolderPath } from "./dirty.js";

describe("planIndexWork", () => {
  it("returns none when no qwen, text-embed, or dirty folders", () => {
    expect(planIndexWork(0, 0, 0)).toBe("none");
  });

  it("returns gpu_vision when any file needs qwen (docling or images)", () => {
    expect(planIndexWork(1, 0, 0)).toBe("gpu_vision");
    expect(planIndexWork(3, 5, 2)).toBe("gpu_vision");
  });

  it("returns cpu_embed when only text-embed files are dirty", () => {
    expect(planIndexWork(0, 4, 0)).toBe("cpu_embed");
    expect(planIndexWork(0, 1, 3)).toBe("cpu_embed");
  });

  it("returns cpu_folders when only folders are dirty", () => {
    expect(planIndexWork(0, 0, 2)).toBe("cpu_folders");
  });

  it("skip-only dirty does not trigger GPU (qwen count is zero)", () => {
    const skipFiles = ["song.mp3", "clip.wav", "README"];
    const qwenCount = skipFiles.filter((name) =>
      routeNeedsQwen(classifyFileRoute(name)),
    ).length;
    const textCount = skipFiles.filter(
      (name) => classifyFileRoute(name) === "text-embed",
    ).length;

    expect(qwenCount).toBe(0);
    expect(textCount).toBe(0);
    expect(planIndexWork(qwenCount, textCount, 0)).toBe("none");
  });

  it("text-only dirty uses cpu_embed without GPU", () => {
    const files = ["notes.txt", "schema.sql", "app.js"];
    const qwenCount = files.filter((name) =>
      routeNeedsQwen(classifyFileRoute(name)),
    ).length;
    const textCount = files.filter(
      (name) => classifyFileRoute(name) === "text-embed",
    ).length;

    expect(qwenCount).toBe(0);
    expect(textCount).toBe(3);
    expect(planIndexWork(qwenCount, textCount, 0)).toBe("cpu_embed");
  });
});

describe("folder dirty on child change", () => {
  it("marks direct parent on file soft-delete (child disappearance)", () => {
    const parent = getDirectParentFolderPath("/Documents/Finance/report.pdf");
    expect(parent).toBe("/Documents/Finance");
  });
});
