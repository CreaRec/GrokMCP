import { describe, it, expect, vi, beforeEach } from "vitest";
import { planIndexWork } from "./index-plan.js";
import { isRunPodGpuConfigured, ollamaUrlOverrideForGpuPod, type Config } from "./config.js";

const withGpuPod = vi.fn();

vi.mock("./runpod.js", () => ({
  withGpuPod,
}));

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: "postgresql://test",
    mountRoot: "/mnt/test",
    indexDailyAt: "21:00",
    timezone: "America/Chicago",
    runOnce: false,
    ollamaBaseUrl: null,
    visionModel: "vision",
    embedModel: "embed",
    dsmHost: null,
    dsmShareUser: null,
    dsmSharePassword: null,
    runpodApiKey: null,
    runpodPodId: null,
    runpodTemplateId: null,
    runpodImage: "ollama/ollama",
    runpodCloudType: "SECURE",
    runpodGpuTypeId: "NVIDIA GeForce RTX 4090",
    runpodContainerDiskGb: 80,
    runpodDataCenterId: null,
    runpodOllamaPort: 11434,
    runpodOllamaHealthyTimeoutMs: 180_000,
    runpodLeaveRunning: false,
    ...overrides,
  };
}

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

  it("gpu_vision + RunPod ignores OLLAMA_BASE_URL (stale sticky-pod proxy)", () => {
    const staleProxy = "https://y5m6f3oroycbs1-11434.proxy.runpod.net";
    const config = makeConfig({
      runpodApiKey: "rp_test_key",
      runpodImage: "ollama/ollama",
      ollamaBaseUrl: staleProxy,
    });

    expect(isRunPodGpuConfigured(config)).toBe(true);
    expect(planIndexWork(1, 0)).toBe("gpu_vision");
    // Same value runIndex passes to withGpuPod after the fix.
    expect(ollamaUrlOverrideForGpuPod(config)).toBeNull();
    expect(ollamaUrlOverrideForGpuPod(config)).not.toBe(staleProxy);
  });

  it("direct Ollama path still uses OLLAMA_BASE_URL when RunPod is not configured", () => {
    const config = makeConfig({
      runpodApiKey: null,
      ollamaBaseUrl: "http://localhost:11434",
    });

    expect(isRunPodGpuConfigured(config)).toBe(false);
    expect(ollamaUrlOverrideForGpuPod(config)).toBe("http://localhost:11434");
  });
});
