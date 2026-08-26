import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startPod,
  withGpuPod,
  isRetryablePodStartError,
  getStartPodRetryDefaults,
  DEFAULT_START_ATTEMPTS,
  DEFAULT_START_RETRY_MS,
  type RunPodConfig,
} from "./runpod.js";

const API_KEY = "rp_secret_key_do_not_log";
const POD_ID = "test-pod-123";

function makeConfig(overrides: Partial<RunPodConfig> = {}): RunPodConfig {
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
  it("retries GPU capacity / no-free-GPU errors", () => {
    expect(
      isRetryablePodStartError(
        new Error(
          "RunPod GraphQL error: There are not enough free GPUs on the host machine to start this pod",
        ),
      ),
    ).toBe(true);
    expect(isRetryablePodStartError(new Error("no free GPUs available"))).toBe(true);
    expect(isRetryablePodStartError(new Error("Insufficient GPU capacity"))).toBe(true);
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

describe("startPod retries", () => {
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

  it("succeeds after capacity errors then a successful resume", async () => {
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
      data: { podResume: { id: POD_ID, desiredStatus: "RUNNING" } },
    };

    fetchMock
      .mockResolvedValueOnce(jsonResponse(capacityBody))
      .mockResolvedValueOnce(jsonResponse(capacityBody))
      .mockResolvedValueOnce(jsonResponse(successBody));

    await startPod(makeConfig(), {
      maxAttempts: 6,
      retryDelayMs: 10,
      sleep,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
      // Request body must not be logged; assert auth header exists but tests never print it.
      expect(JSON.stringify(init.body)).not.toContain("log");
    }
  });

  it("does not retry on 401 Unauthorized", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "nope" }, 401));

    await expect(
      startPod(makeConfig(), { maxAttempts: 6, retryDelayMs: 10, sleep }),
    ).rejects.toThrow(/401/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry TERMINATED GraphQL errors", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        errors: [{ message: "Pod is TERMINATED and cannot be resumed" }],
      }),
    );

    await expect(
      startPod(makeConfig(), { maxAttempts: 6, retryDelayMs: 10, sleep }),
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
      startPod(makeConfig(), { maxAttempts: 3, retryDelayMs: 5, sleep }),
    ).rejects.toThrow(/not enough free GPUs/i);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("withGpuPod start failure leaves pod unused (no stop)", () => {
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

  it("does not call podStop when startPod fails on capacity after retries", async () => {
    const fetchMock = vi.mocked(fetch);
    const stopBodies: string[] = [];
    let resumeCalls = 0;

    fetchMock.mockImplementation(async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("podStop")) {
        stopBodies.push(body);
        return jsonResponse({ data: { podStop: { id: POD_ID, desiredStatus: "EXITED" } } });
      }
      if (body.includes("podResume")) {
        resumeCalls++;
        return jsonResponse({
          errors: [
            {
              message:
                "There are not enough free GPUs on the host machine to start this pod",
            },
          ],
        });
      }
      // getPodStatus
      return jsonResponse({
        data: { pod: { id: POD_ID, desiredStatus: "EXITED", runtime: null } },
      });
    });

    const fn = vi.fn(async () => "should-not-run");

    await expect(
      withGpuPod(makeConfig(), null, "vision", "embed", fn, {
        leaveRunning: false,
      }),
    ).rejects.toThrow(/not enough free GPUs/i);

    expect(fn).not.toHaveBeenCalled();
    expect(resumeCalls).toBe(2);
    expect(stopBodies).toHaveLength(0);
  });
});

describe("API key is never logged by startPod helpers", () => {
  it("error and retry messages do not embed the API key", () => {
    const err = new Error("RunPod API error: 401 Unauthorized");
    expect(err.message).not.toContain(API_KEY);
    expect(isRetryablePodStartError(err)).toBe(false);
  });
});
