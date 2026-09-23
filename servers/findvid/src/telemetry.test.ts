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

describe("parseFloodAttrsFromMessage", () => {
  it("extracts getHistory/flood counters from timeout error text", async () => {
    const { parseFloodAttrsFromMessage } = await import("./telemetry.js");
    expect(
      parseFloodAttrsFromMessage(
        "Timed out … getHistory_calls=12 flood_wait_events=3 flood_wait_seconds=21 last_flood_wait_seconds=7. VIP",
      ),
    ).toEqual({
      getHistory_calls: 12,
      flood_wait_events: 3,
      flood_wait_seconds: 21,
      last_flood_wait_seconds: 7,
    });
    expect(parseFloodAttrsFromMessage("no flood stats")).toEqual({});
  });
});

describe("telemetry wrapper", () => {
  it("records success and error tool calls when OTEL endpoint is set", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    const {
      startTelemetry,
      shutdownTelemetry,
      withToolTelemetry,
      getTelemetry,
      logToolCall,
    } = await import("./telemetry.js");

    startTelemetry();
    expect(getTelemetry()).not.toBeNull();

    const ok = await withToolTelemetry("search", async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data: {} }) }],
    }));
    expect(JSON.parse(ok.content[0].text).ok).toBe(true);

    const bad = await withToolTelemetry("search", async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error:
              "Timed out. getHistory_calls=8 flood_wait_events=2 flood_wait_seconds=11 last_flood_wait_seconds=5",
          }),
        },
      ],
    }));
    expect(JSON.parse(bad.content[0].text).ok).toBe(false);

    const tel = getTelemetry()!;
    logToolCall({
      tool: "list_voiceovers",
      result: "error",
      durationMs: 126_742,
      errorType: "timeout",
      errorMessage:
        "Timed out. getHistory_calls=8 flood_wait_events=2 flood_wait_seconds=11 last_flood_wait_seconds=5",
    });
    const floodEmit = (tel.logger.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { attributes?: { getHistory_calls?: number } }).attributes?.getHistory_calls === 8,
    );
    expect(floodEmit).toBeTruthy();
    const attrs = (floodEmit![0] as { attributes: Record<string, unknown> }).attributes;
    expect(attrs.error_message).toMatch(/getHistory_calls=8/);
    expect(attrs.flood_wait_seconds).toBe(11);
    expect(attrs.last_flood_wait_seconds).toBe(5);

    await shutdownTelemetry();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });
});
