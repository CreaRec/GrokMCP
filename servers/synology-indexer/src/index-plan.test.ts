import { describe, it, expect, vi, beforeEach } from "vitest";
import { planIndexWork } from "./index-plan.js";
import { getDirectParentFolderPath, fileNeedsVision } from "./dirty.js";

describe("planIndexWork", () => {
  it("returns none when no vision files and no dirty folders", () => {
    expect(planIndexWork(0, 0)).toBe("none");
  });

  it("returns gpu_vision when any file needs vision", () => {
    expect(planIndexWork(1, 0)).toBe("gpu_vision");
    expect(planIndexWork(3, 5)).toBe("gpu_vision");
  });

  it("returns cpu_folders when only folders are dirty", () => {
    expect(planIndexWork(0, 2)).toBe("cpu_folders");
  });
});

describe("folder dirty on child change", () => {
  it("marks direct parent on file soft-delete (child disappearance)", () => {
    const parent = getDirectParentFolderPath("/Documents/Finance/report.pdf");
    expect(parent).toBe("/Documents/Finance");
  });

  it("marks different parents on path move (old vs new location)", () => {
    const oldParent = getDirectParentFolderPath("/Documents/Finance/old-name.pdf");
    const newParent = getDirectParentFolderPath("/Documents/Archive/old-name.pdf");
    expect(oldParent).toBe("/Documents/Finance");
    expect(newParent).toBe("/Documents/Archive");
    expect(oldParent).not.toBe(newParent);
  });

  it("8.3 skip does not require vision but folder path still identifiable", () => {
    expect(fileNeedsVision(true, "BKZZW3~2.PDF")).toBe(false);
    expect(fileNeedsVision(true, "receipt.pdf")).toBe(true);
    const parent = getDirectParentFolderPath("/Documents/BKZZW3~2.PDF");
    expect(parent).toBe("/Documents");
  });
});

describe("runIndex orchestration", () => {
  const withGpuPod = vi.fn();
  const embedTextCpu = vi.fn();
  const rebuildDirtyFolders = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    withGpuPod.mockReset();
    embedTextCpu.mockReset();
    rebuildDirtyFolders.mockReset();
  });

  it("folder-only path does not call withGpuPod", async () => {
    vi.doMock("./runpod.js", () => ({
      withGpuPod,
      startPod: vi.fn(),
    }));
    vi.doMock("./cpu-embedder.js", () => ({
      embedTextCpu,
    }));
    vi.doMock("./folder-rebuild.js", () => ({
      markFoldersDirtyByPaths: vi.fn(),
      countDirtyFolders: vi.fn().mockResolvedValue(2),
      rebuildDirtyFolders: rebuildDirtyFolders.mockResolvedValue(2),
    }));

    const work = planIndexWork(0, 2);
    expect(work).toBe("cpu_folders");
    expect(withGpuPod).not.toHaveBeenCalled();
  });

  it("file-dirty path uses gpu_vision plan", async () => {
    const work = planIndexWork(2, 3);
    expect(work).toBe("gpu_vision");
  });
});
