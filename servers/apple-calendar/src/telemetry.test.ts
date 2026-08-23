import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const otel = vi.hoisted(() => {
  const toolCallsTotal = { add: vi.fn() };
  const toolDuration = { record: vi.fn() };
  const errorsTotal = { add: vi.fn() };
  const upGauge = { set: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const mcp = {
    recordToolCall: vi.fn(),
    recordError: vi.fn(),
    setUp: vi.fn(),
  };

  return {
    toolCallsTotal,
    toolDuration,
    errorsTotal,
    upGauge,
    logger,
    mcp,
    initTelemetry: vi.fn(() => ({
      kind: "mcp" as const,
      serviceName: "apple-calendar",
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
    otel.logger.info.mockClear();
    otel.logger.warn.mockClear();
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
        serviceName: "apple-calendar",
        serviceNamespace: "mcp",
      }),
    );
    expect(otel.mcp.setUp).toHaveBeenCalledWith(true);
    await shutdownTelemetry();
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
});

describe("classifyError", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("classifies timeout errors", async () => {
    const { classifyError } = await import("./telemetry.js");
    expect(classifyError(new Error("ETIMEDOUT"))).toBe("timeout");
    expect(classifyError(new Error("Request timeout"))).toBe("timeout");

    const timeoutError = new Error("timed out");
    (timeoutError as unknown as { name: string }).name = "TimeoutError";
    expect(classifyError(timeoutError)).toBe("timeout");
  });

  it("classifies CalDAV errors", async () => {
    const { classifyError } = await import("./telemetry.js");
    expect(classifyError(new Error("CalDAV server error"))).toBe("caldav");
    expect(classifyError(new Error("PROPFIND failed"))).toBe("caldav");
    expect(classifyError(new Error("PUT request failed"))).toBe("caldav");
  });

  it("classifies auth errors", async () => {
    const { classifyError } = await import("./telemetry.js");
    expect(classifyError(new Error("401 Unauthorized"))).toBe("auth");
    expect(classifyError(new Error("403 Forbidden"))).toBe("auth");
    expect(classifyError(new Error("Authentication failed"))).toBe("auth");
  });

  it("classifies network errors", async () => {
    const { classifyError } = await import("./telemetry.js");
    expect(classifyError(new Error("ECONNREFUSED"))).toBe("network");
    expect(classifyError(new Error("ENOTFOUND"))).toBe("network");
    expect(classifyError(new Error("fetch failed"))).toBe("network");
  });

  it("returns unknown for other errors", async () => {
    const { classifyError } = await import("./telemetry.js");
    expect(classifyError(new Error("something weird"))).toBe("unknown");
    expect(classifyError("string error")).toBe("unknown");
    expect(classifyError(null)).toBe("unknown");
  });
});

describe("withToolTelemetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
    otel.mcp.recordToolCall.mockClear();
    otel.mcp.recordError.mockClear();
    otel.logger.info.mockClear();
    otel.logger.warn.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records success for successful tool call", async () => {
    const { startTelemetry, withToolTelemetry, shutdownTelemetry } = await import("./telemetry.js");
    startTelemetry();

    const result = await withToolTelemetry("calendar_list", async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, data: { events: [] } }) }],
    }));

    expect(result.content[0].text).toContain('"ok":true');
    expect(otel.mcp.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "calendar_list",
        result: "success",
      }),
    );
    expect(otel.mcp.recordError).not.toHaveBeenCalled();
    await shutdownTelemetry();
  });

  it("records error for error response", async () => {
    const { startTelemetry, withToolTelemetry, shutdownTelemetry } = await import("./telemetry.js");
    startTelemetry();

    const result = await withToolTelemetry("calendar_create_event", async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: "CalDAV error" }) }],
    }));

    expect(result.content[0].text).toContain('"ok":false');
    expect(otel.mcp.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "calendar_create_event",
        result: "error",
      }),
    );
    expect(otel.mcp.recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "calendar_create_event",
        errorType: "caldav",
      }),
    );
    await shutdownTelemetry();
  });

  it("records error when handler throws", async () => {
    const { startTelemetry, withToolTelemetry, shutdownTelemetry } = await import("./telemetry.js");
    startTelemetry();

    await expect(
      withToolTelemetry("calendar_delete_event", async () => {
        throw new Error("ECONNREFUSED");
      }),
    ).rejects.toThrow("ECONNREFUSED");

    expect(otel.mcp.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "calendar_delete_event",
        result: "error",
      }),
    );
    expect(otel.mcp.recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "calendar_delete_event",
        errorType: "network",
      }),
    );
    await shutdownTelemetry();
  });

  it("logs tool calls", async () => {
    const { startTelemetry, withToolTelemetry, shutdownTelemetry } = await import("./telemetry.js");
    startTelemetry();

    await withToolTelemetry("calendar_list", async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, data: {} }) }],
    }));

    expect(otel.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("calendar_list"),
      expect.objectContaining({
        tool: "calendar_list",
        result: "success",
      }),
    );
    await shutdownTelemetry();
  });

  it("logs errors with warn level", async () => {
    const { startTelemetry, withToolTelemetry, shutdownTelemetry } = await import("./telemetry.js");
    startTelemetry();

    await withToolTelemetry("calendar_update_event", async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: "auth failed" }) }],
    }));

    expect(otel.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("calendar_update_event"),
      expect.objectContaining({
        tool: "calendar_update_event",
        result: "error",
        error_type: "auth",
      }),
    );
    await shutdownTelemetry();
  });
});

describe("isErrorResponse and extractErrorType", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("detects error responses", async () => {
    const { isErrorResponse } = await import("./telemetry.js");

    expect(isErrorResponse({ content: [{ type: "text", text: '{"ok":false,"error":"x"}' }] })).toBe(true);
    expect(isErrorResponse({ content: [{ type: "text", text: '{"ok":true,"data":{}}' }] })).toBe(false);
    expect(isErrorResponse({ content: [] })).toBe(false);
  });

  it("extracts error type from response", async () => {
    const { extractErrorType } = await import("./telemetry.js");

    expect(
      extractErrorType({ content: [{ type: "text", text: '{"ok":false,"error":"CalDAV failed"}' }] }),
    ).toBe("caldav");
    expect(
      extractErrorType({ content: [{ type: "text", text: '{"ok":false,"error":"401 unauthorized"}' }] }),
    ).toBe("auth");
    expect(
      extractErrorType({ content: [{ type: "text", text: '{"ok":false,"error":"unknown issue"}' }] }),
    ).toBe("unknown");
  });
});
