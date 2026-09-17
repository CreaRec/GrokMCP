import { describe, expect, it, vi } from "vitest";

vi.mock("@crearec/otel", () => {
  const handle = {
    mcp: {
      setUp: vi.fn(),
      recordToolCall: vi.fn(),
      recordError: vi.fn(),
    },
    logger: { emit: vi.fn() },
    shutdown: vi.fn(async () => undefined),
  };
  return {
    initTelemetry: vi.fn(() => handle),
  };
});

describe("telemetry wrapper", () => {
  it("records success and error tool calls when OTEL endpoint is set", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    const {
      startTelemetry,
      shutdownTelemetry,
      withToolTelemetry,
      getTelemetry,
    } = await import("./telemetry.js");

    startTelemetry();
    expect(getTelemetry()).not.toBeNull();

    const ok = await withToolTelemetry("search", async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data: {} }) }],
    }));
    expect(JSON.parse(ok.content[0].text).ok).toBe(true);

    const bad = await withToolTelemetry("search", async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "boom" }) }],
    }));
    expect(JSON.parse(bad.content[0].text).ok).toBe(false);

    await shutdownTelemetry();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });
});
