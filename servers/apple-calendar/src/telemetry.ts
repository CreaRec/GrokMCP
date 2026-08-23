import { initTelemetry, type TelemetryHandle } from "@crearec/otel";

const SERVICE_NAME = "apple-calendar";
const SERVICE_NAMESPACE = "mcp";

export type ToolResult = "success" | "error";

export type McpErrorType = "caldav" | "auth" | "timeout" | "network" | "unknown";

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
  const message = errorMessage(err);
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout/i.test(message)) return "timeout";
  if (/caldav|calendar|dav|propfind|put|delete/i.test(message)) return "caldav";
  if (/unauthorized|auth|401|403|forbidden/i.test(message)) return "auth";
  if (/ECONNREFUSED|ENOTFOUND|network|fetch failed/i.test(message)) return "network";
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

export type ToolHandler<TArgs, TResult> = (args: TArgs) => Promise<TResult>;

export function wrapToolHandler<TArgs, TResult>(
  toolName: string,
  handler: ToolHandler<TArgs, TResult>,
): ToolHandler<TArgs, TResult> {
  return async (args: TArgs): Promise<TResult> => {
    const startTime = performance.now();
    let result: ToolResult = "success";
    let errorType: McpErrorType | undefined;

    try {
      const response = await handler(args);
      return response;
    } catch (err) {
      result = "error";
      errorType = classifyError(err);
      throw err;
    } finally {
      const durationMs = performance.now() - startTime;
      const durationSeconds = durationMs / 1000;
      recordToolCall({ tool: toolName, result, durationSeconds, errorType });
      logToolCall({ tool: toolName, result, durationMs, errorType });
    }
  };
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
    recordToolCall({ tool: toolName, result: "error", durationSeconds, errorType });
    logToolCall({ tool: toolName, result: "error", durationMs, errorType });
    throw err;
  }

  const durationMs = performance.now() - startTime;
  const durationSeconds = durationMs / 1000;
  const isError = isErrorResponse(response);
  const result: ToolResult = isError ? "error" : "success";
  const errorType = isError ? extractErrorType(response, caughtError) : undefined;

  recordToolCall({ tool: toolName, result, durationSeconds, errorType });
  logToolCall({ tool: toolName, result, durationMs, errorType });

  return response;
}
