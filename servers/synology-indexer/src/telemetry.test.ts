import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const otel = vi.hoisted(() => {
  const logger = { emit: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const mcp = {
    recordToolCall: vi.fn(),
    recordError: vi.fn(),
    setUp: vi.fn(),
  };

  return {
    logger,
    mcp,
    initTelemetry: vi.fn(() => ({
      kind: "mcp" as const,
      serviceName: "synology-indexer",
      serviceNamespace: "mcp",
      mcp,
      logger,
      shutdown: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

vi.mock("@crearec/otel", () => ({
  initTelemetry: otel.initTelemetry,
}));

describe("telemetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
    otel.mcp.setUp.mockClear();
    otel.logger.emit.mockClear();
    otel.initTelemetry.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts telemetry with indexer defaults", async () => {
    const { startTelemetry, shutdownTelemetry } = await import("./telemetry.js");
    const tel = startTelemetry();
    expect(tel).not.toBeNull();
    expect(otel.initTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mcp",
        serviceName: "synology-indexer",
        serviceNamespace: "mcp",
        endpoint: "http://localhost:4318",
      }),
    );
    expect(otel.mcp.setUp).toHaveBeenCalledWith(true);
    await shutdownTelemetry();
    expect(otel.mcp.setUp).toHaveBeenCalledWith(false);
  });

  it("returns null and warns when endpoint is not set", async () => {
    vi.unstubAllEnvs();
    const { startTelemetry } = await import("./telemetry.js");
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tel = startTelemetry();
    expect(tel).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("telemetry disabled"));
    consoleSpy.mockRestore();
  });

  it("is idempotent across start calls", async () => {
    const { startTelemetry, shutdownTelemetry } = await import("./telemetry.js");
    const first = startTelemetry();
    const second = startTelemetry();
    expect(first).toBe(second);
    expect(otel.initTelemetry).toHaveBeenCalledTimes(1);
    await shutdownTelemetry();
  });

  it("log helpers no-op without crashing when telemetry is disabled", async () => {
    vi.unstubAllEnvs();
    const { startTelemetry, logInfo, logWarn, logError, logDebug } = await import("./telemetry.js");
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(startTelemetry()).toBeNull();
    expect(() => {
      logInfo("index run started", { seen: 0 });
      logWarn("mount blip", { seen: 0, previous: 100 });
      logError("vision failed", { syno_path: "/Documents/x.pdf" });
      logDebug("debug detail");
    }).not.toThrow();
    expect(otel.logger.emit).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("emits structured logs when telemetry is active", async () => {
    const { startTelemetry, logInfo, logError, shutdownTelemetry } = await import("./telemetry.js");
    startTelemetry();

    logInfo("index run complete", { processed: 3, errors: 0 });
    logError("vision error", { syno_path: "/Documents/a.pdf", error: "timeout" });

    expect(otel.logger.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severityNumber: 9,
        severityText: "INFO",
        body: "index run complete",
        attributes: expect.objectContaining({ processed: 3, errors: 0 }),
      }),
    );
    expect(otel.logger.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severityNumber: 17,
        severityText: "ERROR",
        body: "vision error",
      }),
    );
    await shutdownTelemetry();
  });
});
