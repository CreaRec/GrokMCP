import { describe, it, expect, vi, beforeEach } from "vitest";
import { planIndexWork } from "./index-plan.js";
import { isRunPodGpuConfigured, ollamaUrlOverrideForGpuPod, type Config } from "./config.js";
import { classifyFileRoute, routeNeedsQwen } from "./file-route.js";

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
    runpodOllamaHealthyTimeoutMs: 600_000,
    runpodLeaveRunning: false,
    doclingServeUrl: "http://docling-serve:5001",
    doclingContainerName: "grok-mcp-docling-serve",
    doclingHealthyTimeoutMs: 300_000,
    doclingLeaveRunning: false,
    doclingConvertTimeoutMs: 90_000,
    doclingDocumentTimeoutSec: 90,
    doclingPageRangeEnd: 5,
    textHeadBytes: 65_536,
    qwenDocumentChars: 32_768,
    maxDescriptionChars: 500,
    dockerSocketPath: "/var/run/docker.sock",
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

  it("plain-text-only dirty work uses gpu_vision plan", () => {
    const files = ["a.txt", "b.sql", "c.js"];
    const qwenCount = files.filter((name) =>
      routeNeedsQwen(classifyFileRoute(name)),
    ).length;
    expect(qwenCount).toBe(3);
    expect(planIndexWork(qwenCount, 0)).toBe("gpu_vision");
  });

  it("qwen-routed files use gpu_vision plan", () => {
    const files = ["a.pdf", "b.jpg", "c.heic", "d.txt"];
    const qwenCount = files.filter((name) =>
      routeNeedsQwen(classifyFileRoute(name)),
    ).length;
    expect(qwenCount).toBe(4);
    expect(planIndexWork(qwenCount, 0)).toBe("gpu_vision");
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
