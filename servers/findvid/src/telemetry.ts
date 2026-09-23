import { initTelemetry, type TelemetryHandle } from "@crearec/otel";

const SERVICE_NAME = "findvid";
const SERVICE_NAMESPACE = "mcp";

export type ToolResult = "success" | "error";

export type McpErrorType =
  | "telegram"
  | "auth"
  | "timeout"
  | "network"
  | "validation"
  | "findvid"
  | "unknown";

let telemetry: TelemetryHandle | null = null;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function classifyError(err: unknown): McpErrorType {
  if (err && typeof err === "object" && "name" in err && err.name === "TimeoutError") {
    return "timeout";
  }
  if (err && typeof err === "object" && "name" in err) {
    const name = String(err.name);
    if (name === "ConfigError" || name === "ValidationError") {
      return "validation";
    }
    if (name === "FindvidError") {
      return "findvid";
    }
    if (name === "TelegramError") {
      return "telegram";
    }
  }
  const message = errorMessage(err);
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout|timed out/i.test(message)) return "timeout";
  if (/TELEGRAM_|FINDVID_|DOWNLOADER_|settings|session|required/i.test(message)) {
    return "validation";
  }
  if (/FLOOD|VIP|rate.?limit|button|inline|Findvid/i.test(message)) {
    return "findvid";
  }
  if (/unauthorized|auth|401|403|forbidden|AUTH_/i.test(message)) return "auth";
  if (/ECONNREFUSED|ENOTFOUND|network|fetch failed|unreachable|RPC/i.test(message)) {
    return "network";
  }
  if (/Telegram|GramJS|PEER|USER_/i.test(message)) return "telegram";
  return "unknown";
}

export function startTelemetry(): TelemetryHandle | null {
  if (telemetry) return telemetry;

  const endpoint = readEnv("OTEL_EXPORTER_OTLP_ENDPOINT");
  if (!endpoint) {
    console.warn(
      "[telemetry] OTEL_EXPORTER_OTLP_ENDPOINT not set; telemetry disabled (default: http://127.0.0.1:4318)",
    );
    return null;
  }

  try {
    const tel = initTelemetry({
      kind: "mcp",
      serviceName: readEnv("OTEL_SERVICE_NAME") ?? SERVICE_NAME,
      serviceNamespace: readEnv("OTEL_SERVICE_NAMESPACE") ?? SERVICE_NAMESPACE,
      deploymentEnvironment: readEnv("DEPLOY_ENV") ?? "local",
      serviceVersion: readEnv("OTEL_SERVICE_VERSION"),
      endpoint,
    });

    tel.mcp?.setUp(true);
    telemetry = tel;
    return tel;
  } catch (err) {
    console.warn("[telemetry] failed to initialize:", errorMessage(err));
    return null;
  }
}

export function getTelemetry(): TelemetryHandle | null {
  return telemetry;
}

export async function shutdownTelemetry(): Promise<void> {
  if (!telemetry) return;
  try {
    telemetry.mcp?.setUp(false);
    await telemetry.shutdown();
  } catch {
    // Ignore shutdown errors
  }
  telemetry = null;
}

export interface ToolCallRecord {
  tool: string;
  result: ToolResult;
  durationSeconds: number;
  errorType?: McpErrorType;
}

export function recordToolCall(record: ToolCallRecord): void {
  const tel = telemetry;
  if (!tel) return;
  try {
    tel.mcp?.recordToolCall({
      tool: record.tool,
      result: record.result,
      durationSeconds: record.durationSeconds,
    });
    if (record.result === "error" && record.errorType) {
      tel.mcp?.recordError({
        tool: record.tool,
        errorType: record.errorType,
      });
    }
  } catch {
    // Never throw from telemetry
  }
}

export function logToolCall(opts: {
  tool: string;
  result: ToolResult;
  durationMs: number;
  errorType?: McpErrorType;
  errorMessage?: string;
  flood?: {
    getHistoryCalls?: number;
    floodWaitSeconds?: number;
    floodWaitEvents?: number;
    lastFloodWaitSeconds?: number;
  };
}): void {
  const tel = telemetry;
  if (!tel) return;
  try {
    const attrs: Record<string, string | number> = {
      tool: opts.tool,
      result: opts.result,
      duration_ms: opts.durationMs,
    };
    if (opts.errorType) {
      attrs.error_type = opts.errorType;
    }
    if (opts.errorMessage) {
      attrs.error_message = opts.errorMessage.slice(0, 500);
      const parsed = parseFloodAttrsFromMessage(opts.errorMessage);
      Object.assign(attrs, parsed);
    }
    if (opts.flood) {
      if (opts.flood.getHistoryCalls !== undefined) {
        attrs.getHistory_calls = opts.flood.getHistoryCalls;
      }
      if (opts.flood.floodWaitSeconds !== undefined) {
        attrs.flood_wait_seconds = opts.flood.floodWaitSeconds;
      }
      if (opts.flood.floodWaitEvents !== undefined) {
        attrs.flood_wait_events = opts.flood.floodWaitEvents;
      }
      if (opts.flood.lastFloodWaitSeconds !== undefined) {
        attrs.last_flood_wait_seconds = opts.flood.lastFloodWaitSeconds;
      }
    }
    tel.logger.emit({
      severityNumber: opts.result === "error" ? 17 : 9,
      severityText: opts.result === "error" ? "ERROR" : "INFO",
      body: opts.result === "error" ? `Tool ${opts.tool} failed` : `Tool ${opts.tool} completed`,
      attributes: attrs,
    });
  } catch {
    // Never throw from telemetry
  }
}

/** Pull flood/history counters out of FindvidError timeout messages. */
export function parseFloodAttrsFromMessage(message: string): Record<string, number> {
  const attrs: Record<string, number> = {};
  const calls = message.match(/getHistory_calls=(\d+)/);
  const events = message.match(/flood_wait_events=(\d+)/);
  const seconds = message.match(/flood_wait_seconds=(\d+)/);
  const last = message.match(/last_flood_wait_seconds=(\d+)/);
  if (calls) attrs.getHistory_calls = Number(calls[1]);
  if (events) attrs.flood_wait_events = Number(events[1]);
  if (seconds) attrs.flood_wait_seconds = Number(seconds[1]);
  if (last) attrs.last_flood_wait_seconds = Number(last[1]);
  return attrs;
}

export interface McpToolResponse {
  content: Array<{ type: "text"; text: string }>;
}

export function isErrorResponse(response: McpToolResponse): boolean {
  if (response.content.length === 0) return false;
  const first = response.content[0];
  if (first.type !== "text") return false;
  try {
    const parsed = JSON.parse(first.text);
    return parsed.ok === false;
  } catch {
    return false;
  }
}

export function extractErrorType(response: McpToolResponse, caughtError?: unknown): McpErrorType {
  if (caughtError) {
    return classifyError(caughtError);
  }
  if (response.content.length === 0) return "unknown";
  const first = response.content[0];
  if (first.type !== "text") return "unknown";
  try {
    const parsed = JSON.parse(first.text);
    if (typeof parsed.error === "string") {
      return classifyError(new Error(parsed.error));
    }
  } catch {
    // Not JSON
  }
  return "unknown";
}

export async function withToolTelemetry<T extends McpToolResponse>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startTime = performance.now();
  let response: T;
  let caughtError: unknown;

  try {
    response = await fn();
  } catch (err) {
    caughtError = err;
    const durationMs = performance.now() - startTime;
    const durationSeconds = durationMs / 1000;
    const errorType = classifyError(err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    recordToolCall({ tool: toolName, result: "error", durationSeconds, errorType });
    logToolCall({
      tool: toolName,
      result: "error",
      durationMs,
      errorType,
      errorMessage,
    });
    throw err;
  }

  const durationMs = performance.now() - startTime;
  const durationSeconds = durationMs / 1000;
  const isError = isErrorResponse(response);
  const result: ToolResult = isError ? "error" : "success";
  const errorType = isError ? extractErrorType(response, caughtError) : undefined;
  const errorMessage = isError ? extractErrorMessage(response) : undefined;

  recordToolCall({ tool: toolName, result, durationSeconds, errorType });
  logToolCall({
    tool: toolName,
    result,
    durationMs,
    errorType,
    errorMessage,
  });

  return response;
}

function extractErrorMessage(response: McpToolResponse): string | undefined {
  if (response.content.length === 0) return undefined;
  const first = response.content[0];
  if (first.type !== "text") return undefined;
  try {
    const parsed = JSON.parse(first.text) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}
