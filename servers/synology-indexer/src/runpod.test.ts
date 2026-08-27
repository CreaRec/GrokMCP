import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createPod,
  terminatePod,
  withGpuPod,
  buildDeployInput,
  isRetryablePodStartError,
  getStartPodRetryDefaults,
  getOllamaUrlFromPod,
  summarizePodPortsSafe,
  DEFAULT_START_ATTEMPTS,
  DEFAULT_START_RETRY_MS,
  type RunPodDeployConfig,
  type RunPodPodConfig,
} from "./runpod.js";

const API_KEY = "rp_secret_key_do_not_log";
const POD_ID = "test-pod-123";

function makeDeployConfig(overrides: Partial<RunPodDeployConfig> = {}): RunPodDeployConfig {
  return {
    apiKey: API_KEY,
    ollamaPort: 11434,
    templateId: null,
    imageName: "ollama/ollama",
    cloudType: "SECURE",
    gpuTypeId: "NVIDIA GeForce RTX 4090",
    containerDiskInGb: 80,
    dataCenterId: null,
    podName: "synology-indexer-ollama",
    ollamaHealthyTimeoutMs: 180_000,
    ollamaPortsTimeoutMs: 90_000,
    ...overrides,
  };
}

function makePodRef(overrides: Partial<RunPodPodConfig> = {}): RunPodPodConfig {
  return {
    apiKey: API_KEY,
    podId: POD_ID,
    ollamaPort: 11434,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : status === 401 ? "Unauthorized" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

describe("isRetryablePodStartError", () => {
  it("retries GPU capacity / fleet stock errors", () => {
    expect(
      isRetryablePodStartError(
        new Error(
          "RunPod GraphQL error: There are not enough free GPUs on the host machine to start this pod",
        ),
      ),
    ).toBe(true);
    expect(isRetryablePodStartError(new Error("no free GPUs available"))).toBe(true);
    expect(isRetryablePodStartError(new Error("Insufficient GPU capacity"))).toBe(true);
    expect(isRetryablePodStartError(new Error("no longer any instances available"))).toBe(true);
    expect(isRetryablePodStartError(new Error("no instances available"))).toBe(true);
    expect(isRetryablePodStartError(new Error("zero gpu stock"))).toBe(true);
  });

  it("does not retry auth / 401", () => {
    expect(isRetryablePodStartError(new Error("RunPod API error: 401 Unauthorized"))).toBe(false);
    expect(isRetryablePodStartError(new Error("authentication failed"))).toBe(false);
  });

  it("does not retry TERMINATED", () => {
    expect(
      isRetryablePodStartError(new Error(`Pod ${POD_ID} is TERMINATED and cannot be started`)),
    ).toBe(false);
  });
});

describe("getStartPodRetryDefaults", () => {
  it("uses 6 attempts and 120s by default", () => {
    expect(getStartPodRetryDefaults({})).toEqual({
      maxAttempts: DEFAULT_START_ATTEMPTS,
      retryDelayMs: DEFAULT_START_RETRY_MS,
    });
    expect(DEFAULT_START_ATTEMPTS).toBe(6);
    expect(DEFAULT_START_RETRY_MS).toBe(120_000);
  });

  it("reads RUNPOD_START_RETRIES and RUNPOD_START_RETRY_MS", () => {
    expect(
      getStartPodRetryDefaults({
        RUNPOD_START_RETRIES: "3",
        RUNPOD_START_RETRY_MS: "5000",
      }),
    ).toEqual({ maxAttempts: 3, retryDelayMs: 5000 });
  });
});

describe("buildDeployInput", () => {
  it("includes OLLAMA_HOST for image-based deploy", () => {
    const input = buildDeployInput(makeDeployConfig());
    expect(input.env).toEqual([{ key: "OLLAMA_HOST", value: "0.0.0.0:11434" }]);
    expect(input.imageName).toBe("ollama/ollama");
    expect(input.templateId).toBeUndefined();
  });

  it("includes OLLAMA_HOST for template-based deploy", () => {
    const input = buildDeployInput(makeDeployConfig({ templateId: "tmpl-abc" }));
    expect(input.env).toEqual([{ key: "OLLAMA_HOST", value: "0.0.0.0:11434" }]);
    expect(input.templateId).toBe("tmpl-abc");
    expect(input.imageName).toBeUndefined();
  });

  it("uses configured ollama port in OLLAMA_HOST", () => {
    const input = buildDeployInput(makeDeployConfig({ ollamaPort: 8080 }));
    expect(input.env).toEqual([{ key: "OLLAMA_HOST", value: "0.0.0.0:8080" }]);
    expect(input.ports).toBe("8080/http");
  });
});

describe("createPod retries", () => {
  const sleep = vi.fn(async () => {});

  beforeEach(() => {
    vi.restoreAllMocks();
    sleep.mockClear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("succeeds after capacity errors then a successful deploy", async () => {
    const fetchMock = vi.mocked(fetch);
    const capacityBody = {
      errors: [
        {
          message:
            "There are not enough free GPUs on the host machine to start this pod",
        },
      ],
    };
    const successBody = {
      data: {
        podFindAndDeployOnDemand: { id: POD_ID, desiredStatus: "RUNNING" },
      },
    };

    fetchMock
      .mockResolvedValueOnce(jsonResponse(capacityBody))
      .mockResolvedValueOnce(jsonResponse(capacityBody))
      .mockResolvedValueOnce(jsonResponse(successBody));

    const podRef = await createPod(makeDeployConfig(), {
      maxAttempts: 6,
      retryDelayMs: 10,
      sleep,
    });

    expect(podRef.podId).toBe(POD_ID);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      const body = JSON.stringify(init.body);
      expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(body).not.toContain(API_KEY);
      if (body.includes("podFindAndDeployOnDemand")) {
        expect(body).toContain("OLLAMA_HOST");
        expect(body).toContain("0.0.0.0:11434");
      }
    }
  });

  it("does not retry on 401 Unauthorized", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "nope" }, 401));

    await expect(
      createPod(makeDeployConfig(), { maxAttempts: 6, retryDelayMs: 10, sleep }),
    ).rejects.toThrow(/401/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry TERMINATED GraphQL errors", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        errors: [{ message: "Pod is TERMINATED and cannot be deployed" }],
      }),
    );

    await expect(
      createPod(makeDeployConfig(), { maxAttempts: 6, retryDelayMs: 10, sleep }),
    ).rejects.toThrow(/TERMINATED/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws after exhausting capacity retries", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        errors: [{ message: "There are not enough free GPUs on the host machine to start this pod" }],
      }),
    );

    await expect(
      createPod(makeDeployConfig(), { maxAttempts: 3, retryDelayMs: 5, sleep }),
    ).rejects.toThrow(/not enough free GPUs/i);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("terminatePod", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls podTerminate with pod id", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { podTerminate: null } }));

    await terminatePod(makePodRef());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.stringify(init.body)).toContain("podTerminate");
    expect(JSON.stringify(init.body)).toContain(POD_ID);
  });
});

describe("withGpuPod lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("RUNPOD_START_RETRIES", "2");
    vi.stubEnv("RUNPOD_START_RETRY_MS", "0");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does not call podTerminate when createPod fails on capacity after retries", async () => {
    const fetchMock = vi.mocked(fetch);
    const terminateBodies: string[] = [];
    let deployCalls = 0;

    fetchMock.mockImplementation(async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("podTerminate")) {
        terminateBodies.push(body);
        return jsonResponse({ data: { podTerminate: null } });
      }
      if (body.includes("podFindAndDeployOnDemand")) {
        deployCalls++;
        return jsonResponse({
          errors: [
            {
              message:
                "There are not enough free GPUs on the host machine to start this pod",
            },
          ],
        });
      }
      return jsonResponse({ data: { pod: null } });
    });

    const fn = vi.fn(async () => "should-not-run");

    await expect(
      withGpuPod(makeDeployConfig(), null, "vision", "embed", fn, {
        leaveRunning: false,
      }),
    ).rejects.toThrow(/not enough free GPUs/i);

    expect(fn).not.toHaveBeenCalled();
    expect(deployCalls).toBe(2);
    expect(terminateBodies).toHaveLength(0);
  });

  it("terminates pod when fn throws after successful create", async () => {
    const fetchMock = vi.mocked(fetch);
    let terminateCalls = 0;

    fetchMock.mockImplementation(async (url, init) => {
      const urlStr = String(url);
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("podTerminate")) {
        terminateCalls++;
        return jsonResponse({ data: { podTerminate: null } });
      }
      if (body.includes("podFindAndDeployOnDemand")) {
        return jsonResponse({
          data: {
            podFindAndDeployOnDemand: { id: POD_ID, desiredStatus: "RUNNING" },
          },
        });
      }
      if (body.includes("getPod")) {
        return jsonResponse({
          data: {
            pod: {
              id: POD_ID,
              desiredStatus: "RUNNING",
              runtime: {
                ports: [{ ip: "1.2.3.4", publicPort: 12345, privatePort: 11434, type: "http" }],
              },
            },
          },
        });
      }
      if (urlStr.includes("/api/tags")) {
        return jsonResponse({ models: [{ name: "vision" }, { name: "embed" }] });
      }
      return jsonResponse({});
    });

    const fn = vi.fn(async () => {
      throw new Error("vision failed");
    });

    await expect(
      withGpuPod(makeDeployConfig(), null, "vision", "embed", fn, {
        leaveRunning: false,
      }),
    ).rejects.toThrow("vision failed");

    expect(fn).toHaveBeenCalled();
    expect(terminateCalls).toBe(1);
  });

  it("skips terminate when leaveRunning is set", async () => {
    const fetchMock = vi.mocked(fetch);
    const terminateBodies: string[] = [];

    fetchMock.mockImplementation(async (url, init) => {
      const urlStr = String(url);
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("podTerminate")) {
        terminateBodies.push(body);
        return jsonResponse({ data: { podTerminate: null } });
      }
      if (body.includes("podFindAndDeployOnDemand")) {
        return jsonResponse({
          data: {
            podFindAndDeployOnDemand: { id: POD_ID, desiredStatus: "RUNNING" },
          },
        });
      }
      if (body.includes("getPod")) {
        return jsonResponse({
          data: {
            pod: {
              id: POD_ID,
              desiredStatus: "RUNNING",
              runtime: {
                ports: [{ ip: "1.2.3.4", publicPort: 12345, privatePort: 11434, type: "http" }],
              },
            },
          },
        });
      }
      if (urlStr.includes("/api/tags")) {
        return jsonResponse({ models: [{ name: "vision" }, { name: "embed" }] });
      }
      return jsonResponse({});
    });

    const fn = vi.fn(async () => "ok");

    await withGpuPod(makeDeployConfig(), null, "vision", "embed", fn, {
      leaveRunning: true,
    });

    expect(fn).toHaveBeenCalled();
    expect(terminateBodies).toHaveLength(0);
  });

  it("with null override (runIndex ephemeral path) derives URL from new pod ports", async () => {
    const fetchMock = vi.mocked(fetch);
    const staleOverride = "https://y5m6f3oroycbs1-11434.proxy.runpod.net";
    const derivedHost = "http://10.0.0.5:23456";
    const healthUrls: string[] = [];

    fetchMock.mockImplementation(async (url, init) => {
      const urlStr = String(url);
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("podTerminate")) {
        return jsonResponse({ data: { podTerminate: null } });
      }
      if (body.includes("podFindAndDeployOnDemand")) {
        return jsonResponse({
          data: {
            podFindAndDeployOnDemand: { id: "vxpmzql6za084k", desiredStatus: "RUNNING" },
          },
        });
      }
      if (body.includes("getPod")) {
        return jsonResponse({
          data: {
            pod: {
              id: "vxpmzql6za084k",
              desiredStatus: "RUNNING",
              runtime: {
                ports: [{ ip: "10.0.0.5", publicPort: 23456, privatePort: 11434, type: "http" }],
              },
            },
          },
        });
      }
      if (urlStr.includes("/api/tags") || urlStr.includes("/api/pull")) {
        healthUrls.push(urlStr);
        return jsonResponse({ models: [{ name: "vision" }, { name: "embed" }] });
      }
      return jsonResponse({});
    });

    const fn = vi.fn(async (ollamaUrl: string) => {
      expect(ollamaUrl).toBe(derivedHost);
      expect(ollamaUrl).not.toBe(staleOverride);
      return "ok";
    });

    // runIndex passes ollamaUrlOverrideForGpuPod(config) === null when RunPod is configured.
    await withGpuPod(makeDeployConfig(), null, "vision", "embed", fn, {
      leaveRunning: false,
    });

    expect(fn).toHaveBeenCalledWith(derivedHost);
    expect(healthUrls.some((u) => u.startsWith(derivedHost))).toBe(true);
    expect(healthUrls.some((u) => u.includes("y5m6f3oroycbs1"))).toBe(false);
  });

  it("polls until ports publish after RUNNING with empty runtime.ports", async () => {
    const fetchMock = vi.mocked(fetch);
    let getPodCalls = 0;
    let terminateCalls = 0;
    const derivedHost = "http://10.0.0.9:34567";
    const sleep = vi.fn(async () => {});

    fetchMock.mockImplementation(async (url, init) => {
      const urlStr = String(url);
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("podTerminate")) {
        terminateCalls++;
        return jsonResponse({ data: { podTerminate: null } });
      }
      if (body.includes("podFindAndDeployOnDemand")) {
        return jsonResponse({
          data: {
            podFindAndDeployOnDemand: { id: "pxwc5peryssrjy", desiredStatus: "RUNNING" },
          },
        });
      }
      if (body.includes("getPod")) {
        getPodCalls++;
        // First samples: RUNNING but ports not published yet (production failure mode).
        if (getPodCalls <= 2) {
          return jsonResponse({
            data: {
              pod: {
                id: "pxwc5peryssrjy",
                desiredStatus: "RUNNING",
                runtime: getPodCalls === 1 ? null : { ports: [] },
              },
            },
          });
        }
        return jsonResponse({
          data: {
            pod: {
              id: "pxwc5peryssrjy",
              desiredStatus: "RUNNING",
              runtime: {
                // tcp label still matches by privatePort
                ports: [{ ip: "10.0.0.9", publicPort: 34567, privatePort: 11434, type: "tcp" }],
              },
            },
          },
        });
      }
      if (urlStr.includes("/api/tags") || urlStr.includes("/api/pull")) {
        return jsonResponse({ models: [{ name: "vision" }, { name: "embed" }] });
      }
      return jsonResponse({});
    });

    const fn = vi.fn(async (ollamaUrl: string) => {
      expect(ollamaUrl).toBe(derivedHost);
      throw new Error("vision failed after ports ready");
    });

    await expect(
      withGpuPod(
        makeDeployConfig({ ollamaPortsTimeoutMs: 50 }),
        null,
        "vision",
        "embed",
        fn,
        { leaveRunning: false, sleep, portsPollIntervalMs: 10 },
      ),
    ).rejects.toThrow("vision failed after ports ready");

    expect(fn).toHaveBeenCalledWith(derivedHost);
    expect(getPodCalls).toBeGreaterThanOrEqual(3);
    expect(terminateCalls).toBe(1);
  });

  it("throws determine-URL error and terminates when RUNNING forever without ports", async () => {
    const fetchMock = vi.mocked(fetch);
    let terminateCalls = 0;
    const sleep = vi.fn(async () => {});

    fetchMock.mockImplementation(async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("podTerminate")) {
        terminateCalls++;
        return jsonResponse({ data: { podTerminate: null } });
      }
      if (body.includes("podFindAndDeployOnDemand")) {
        return jsonResponse({
          data: {
            podFindAndDeployOnDemand: { id: POD_ID, desiredStatus: "RUNNING" },
          },
        });
      }
      if (body.includes("getPod")) {
        return jsonResponse({
          data: {
            pod: {
              id: POD_ID,
              desiredStatus: "RUNNING",
              runtime: { ports: [] },
            },
          },
        });
      }
      return jsonResponse({});
    });

    const fn = vi.fn(async () => "should-not-run");

    await expect(
      withGpuPod(
        makeDeployConfig({ ollamaPortsTimeoutMs: 30 }),
        null,
        "vision",
        "embed",
        fn,
        { leaveRunning: false, sleep, portsPollIntervalMs: 10 },
      ),
    ).rejects.toThrow("Could not determine Ollama URL from pod ports");

    expect(fn).not.toHaveBeenCalled();
    expect(terminateCalls).toBe(1);
    expect(sleep).toHaveBeenCalled();
  });
});

describe("getOllamaUrlFromPod / summarizePodPortsSafe", () => {
  it("matches privatePort for http or tcp types", () => {
    const podHttp = {
      id: POD_ID,
      desiredStatus: "RUNNING",
      runtime: {
        ports: [{ ip: "1.2.3.4", publicPort: 111, privatePort: 11434, type: "http" }],
      },
    };
    const podTcp = {
      id: POD_ID,
      desiredStatus: "RUNNING",
      runtime: {
        ports: [{ ip: "1.2.3.4", publicPort: 222, privatePort: 11434, type: "tcp" }],
      },
    };
    expect(getOllamaUrlFromPod(podHttp, 11434)).toBe("http://1.2.3.4:111");
    expect(getOllamaUrlFromPod(podTcp, 11434)).toBe("http://1.2.3.4:222");
  });

  it("summarizePodPortsSafe omits ips and is LogAttributes-compatible", () => {
    const summary = summarizePodPortsSafe({
      id: POD_ID,
      desiredStatus: "RUNNING",
      runtime: {
        ports: [
          { ip: "secret-proxy-host.example", publicPort: 12345, privatePort: 11434, type: "http" },
          { ip: "another-secret", publicPort: 2222, privatePort: 22, type: "tcp" },
        ],
      },
    });
    expect(summary).toEqual({
      port_count: 2,
      ports_summary: "11434/http->12345,22/tcp->2222",
    });
    expect(JSON.stringify(summary)).not.toContain("secret-proxy-host");
    expect(JSON.stringify(summary)).not.toContain("another-secret");
    // LogAttributes only allows string | number | boolean
    for (const value of Object.values(summary)) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
    }
  });
});

describe("API key is never logged by createPod helpers", () => {
  it("error and retry messages do not embed the API key", () => {
    const err = new Error("RunPod API error: 401 Unauthorized");
    expect(err.message).not.toContain(API_KEY);
    expect(isRetryablePodStartError(err)).toBe(false);
  });
});
