import { describe, it, expect, vi, beforeEach } from "vitest";
import { planIndexWork } from "./index-plan.js";

const withGpuPod = vi.fn();

vi.mock("./runpod.js", () => ({
  withGpuPod,
}));

describe("runIndex GPU vs CPU paths", () => {
  beforeEach(() => {
    withGpuPod.mockReset();
  });

  it("folder-only dirty work uses cpu_folders plan and skips withGpuPod", () => {
    expect(planIndexWork(0, 2)).toBe("cpu_folders");
    expect(withGpuPod).not.toHaveBeenCalled();
  });

  it("file-dirty work uses gpu_vision plan", () => {
    expect(planIndexWork(2, 3)).toBe("gpu_vision");
  });
});
