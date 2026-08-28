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
      serviceName: "utilities",
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
    otel.mcp.recordToolCall.mockClear();
    otel.mcp.recordError.mockClear();
    otel.mcp.setUp.mockClear();
    otel.logger.emit.mockClear();
    otel.initTelemetry.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts MCP telemetry with contract defaults", async () => {
    const { startTelemetry, shutdownTelemetry } = await import("./telemetry.js");
    const tel = startTelemetry();
    expect(tel).not.toBeNull();
    expect(otel.initTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mcp",
        serviceName: "utilities",
        serviceNamespace: "mcp",
      }),
    );
    await shutdownTelemetry();
  });
});

describe("classifyError", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("classifies dashboard and network errors", async () => {
    const { classifyError } = await import("./telemetry.js");
    expect(classifyError(new Error("CreaDashboard API returned invalid JSON"))).toBe("dashboard");
    expect(classifyError(new Error("ECONNREFUSED"))).toBe("network");
    expect(classifyError(new Error("Request timeout"))).toBe("timeout");
  });
});
