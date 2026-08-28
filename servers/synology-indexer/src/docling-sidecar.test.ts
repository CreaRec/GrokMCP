import { describe, it, expect, vi, beforeEach } from "vitest";
import { access } from "node:fs/promises";
import {
  withDoclingSidecar,
  startDoclingContainer,
  stopDoclingContainer,
  waitForDoclingHealthy,
  inspectDoclingContainer,
  indexRunNeedsDocling,
  checkDockerSocketAccess,
  DEFAULT_DOCLING_HEALTHY_TIMEOUT_MS,
  type DoclingSidecarConfig,
  type DoclingSidecarDeps,
} from "./docling-sidecar.js";
import { logInfo, logError } from "./telemetry.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn(actual.access),
  };
});

vi.mock("./telemetry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telemetry.js")>();
  return {
    ...actual,
    logInfo: vi.fn(actual.logInfo),
    logWarn: vi.fn(actual.logWarn),
    logError: vi.fn(actual.logError),
    logErrorWithCause: vi.fn(actual.logErrorWithCause),
  };
});

const CONTAINER = "grok-mcp-docling-serve";
const DOCLING_URL = "http://docling-serve:5001";

function makeConfig(overrides: Partial<DoclingSidecarConfig> = {}): DoclingSidecarConfig {
  return {
    containerName: CONTAINER,
    doclingServeUrl: DOCLING_URL,
    dockerSocketPath: "/var/run/docker.sock",
    healthyTimeoutMs: DEFAULT_DOCLING_HEALTHY_TIMEOUT_MS,
    ...overrides,
  };
}

function runningInspectBody(): string {
  return JSON.stringify({ State: { Running: true } });
}

function stoppedInspectBody(): string {
  return JSON.stringify({ State: { Running: false } });
}

describe("indexRunNeedsDocling", () => {
  it("is true when any route is docling", () => {
    expect(indexRunNeedsDocling([{ route: "qwen-text" }, { route: "docling" }])).toBe(true);
  });

  it("is false for qwen-only queues", () => {
    expect(indexRunNeedsDocling([{ route: "qwen-image" }, { route: "heic" }])).toBe(false);
  });
});

describe("inspectDoclingContainer", () => {
  it("reports missing container on 404", async () => {
    const dockerRequest = vi.fn().mockResolvedValue({ statusCode: 404, body: "" });
    const result = await inspectDoclingContainer(makeConfig(), { dockerRequest });
    expect(result).toEqual({ exists: false, running: false });
  });

  it("reports running state from inspect JSON", async () => {
    const dockerRequest = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: runningInspectBody(),
    });
    const result = await inspectDoclingContainer(makeConfig(), { dockerRequest });
    expect(result).toEqual({ exists: true, running: true });
  });
});

describe("checkDockerSocketAccess", () => {
  beforeEach(() => {
    vi.mocked(access).mockReset();
  });

  it("reports accessible when read/write succeeds", async () => {
    vi.mocked(access).mockResolvedValue(undefined);

    await expect(checkDockerSocketAccess("/var/run/docker.sock")).resolves.toEqual({
      accessible: true,
    });
  });

  it("reports missing when the socket path does not exist", async () => {
    vi.mocked(access).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    await expect(checkDockerSocketAccess("/var/run/docker.sock")).resolves.toEqual({
      accessible: false,
      reason: "missing",
    });
  });

  it("reports permission_denied when the socket exists but is not rw", async () => {
    vi.mocked(access)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));

    await expect(checkDockerSocketAccess("/var/run/docker.sock")).resolves.toEqual({
      accessible: false,
      reason: "permission_denied",
    });
  });
});

describe("startDoclingContainer", () => {
  it("fails fast when docker socket is missing", async () => {
    await expect(
      startDoclingContainer(makeConfig(), {
        checkSocketAccess: async () => ({ accessible: false, reason: "missing" }),
      }),
    ).rejects.toThrow("Mount /var/run/docker.sock");
  });

  it("mentions group_add and DOCKER_GID when socket exists but access is denied", async () => {
    await expect(
      startDoclingContainer(makeConfig(), {
        checkSocketAccess: async () => ({
          accessible: false,
          reason: "permission_denied",
        }),
      }),
    ).rejects.toThrow(/group_add.*DOCKER_GID/s);
  });

  it("fails clearly when container does not exist", async () => {
    const dockerRequest = vi.fn().mockResolvedValue({ statusCode: 404, body: "" });
    await expect(
      startDoclingContainer(makeConfig(), {
        checkSocketAccess: async () => ({ accessible: true }),
        dockerRequest,
      }),
    ).rejects.toThrow("not found");
    expect(dockerRequest).toHaveBeenCalledOnce();
  });

  it("starts a stopped container", async () => {
    const dockerRequest = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 200, body: stoppedInspectBody() })
      .mockResolvedValueOnce({ statusCode: 204, body: "" });

    await startDoclingContainer(makeConfig(), {
      checkSocketAccess: async () => ({ accessible: true }),
      dockerRequest,
    });

    expect(dockerRequest).toHaveBeenCalledTimes(2);
    expect(dockerRequest.mock.calls[1]?.[0]).toBe("POST");
    expect(String(dockerRequest.mock.calls[1]?.[1])).toContain("/start");
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      "docling sidecar starting",
      expect.objectContaining({ container: CONTAINER }),
    );
  });

  it("skips start when already running", async () => {
    const dockerRequest = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: runningInspectBody(),
    });

    await startDoclingContainer(makeConfig(), {
      checkSocketAccess: async () => ({ accessible: true }),
      dockerRequest,
    });

    expect(dockerRequest).toHaveBeenCalledOnce();
  });
});

describe("stopDoclingContainer", () => {
  it("stops a running container", async () => {
    const dockerRequest = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 200, body: runningInspectBody() })
      .mockResolvedValueOnce({ statusCode: 204, body: "" });

    await stopDoclingContainer(makeConfig(), { dockerRequest });

    expect(dockerRequest.mock.calls[1]?.[0]).toBe("POST");
    expect(String(dockerRequest.mock.calls[1]?.[1])).toContain("/stop");
  });
});

describe("waitForDoclingHealthy", () => {
  it("polls /ready until success", async () => {
    const fetchHealth = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await waitForDoclingHealthy(DOCLING_URL, 10_000, 1, { fetchHealth, sleep });

    expect(fetchHealth).toHaveBeenCalledWith(`${DOCLING_URL}/ready`);
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith("docling sidecar healthy");
  });

  it("throws after timeout", async () => {
    const fetchHealth = vi.fn().mockResolvedValue({ ok: false });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForDoclingHealthy(DOCLING_URL, 0, 1, { fetchHealth, sleep }),
    ).rejects.toThrow("Timeout waiting for Docling sidecar");

    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      "docling sidecar health timeout",
      expect.objectContaining({ timeout_ms: 0 }),
    );
  });
});

describe("withDoclingSidecar lifecycle", () => {
  let deps: DoclingSidecarDeps;

  beforeEach(() => {
    vi.mocked(logInfo).mockClear();
    deps = {
      checkSocketAccess: async () => ({ accessible: true }),
      dockerRequest: vi
        .fn()
        .mockResolvedValueOnce({ statusCode: 200, body: stoppedInspectBody() })
        .mockResolvedValueOnce({ statusCode: 204, body: "" })
        .mockResolvedValueOnce({ statusCode: 200, body: runningInspectBody() })
        .mockResolvedValueOnce({ statusCode: 204, body: "" }),
      fetchHealth: vi.fn().mockResolvedValue({ ok: true }),
      sleep: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("starts, waits for health, runs fn, then stops", async () => {
    const fn = vi.fn().mockResolvedValue("done");
    const onStart = vi.fn();
    const onStop = vi.fn();

    const result = await withDoclingSidecar(
      makeConfig(),
      fn,
      { onStart, onStop },
      deps,
    );

    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith("docling sidecar stopped", {
      container: CONTAINER,
    });
  });

  it("leaves container running when leaveRunning is set", async () => {
    const dockerRequest = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 200, body: stoppedInspectBody() })
      .mockResolvedValueOnce({ statusCode: 204, body: "" });

    const fn = vi.fn().mockResolvedValue(undefined);

    await withDoclingSidecar(
      makeConfig(),
      fn,
      { leaveRunning: true },
      { ...deps, dockerRequest },
    );

    expect(dockerRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
      "docling leaving sidecar running",
      expect.objectContaining({ container: CONTAINER }),
    );
  });

  it("stops container when fn throws", async () => {
    const dockerRequest = vi
      .fn()
      .mockResolvedValueOnce({ statusCode: 200, body: stoppedInspectBody() })
      .mockResolvedValueOnce({ statusCode: 204, body: "" })
      .mockResolvedValueOnce({ statusCode: 200, body: runningInspectBody() })
      .mockResolvedValueOnce({ statusCode: 204, body: "" });

    const fn = vi.fn().mockRejectedValue(new Error("qwen failed"));

    await expect(
      withDoclingSidecar(makeConfig(), fn, undefined, { ...deps, dockerRequest }),
    ).rejects.toThrow("qwen failed");

    expect(dockerRequest.mock.calls.at(-1)?.[1]).toContain("/stop");
  });
});
