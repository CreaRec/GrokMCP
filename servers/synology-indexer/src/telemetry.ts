import { initTelemetry, type TelemetryHandle } from "@crearec/otel";

const SERVICE_NAME = "synology-indexer";
const SERVICE_NAMESPACE = "mcp";

export type LogSeverity = "DEBUG" | "INFO" | "WARN" | "ERROR";

const SEVERITY_NUMBERS: Record<LogSeverity, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

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

/** One node in an error's `cause` chain for structured logs. */
export interface SerializedErrorCause {
  name?: string;
  message: string;
  code?: string;
  errno?: number;
  syscall?: string;
  stack?: string;
}

function readErrorCode(err: Error): string | undefined {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

function readErrorNumber(err: Error, key: "errno"): number | undefined {
  const value = (err as NodeJS.ErrnoException)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readErrorString(err: Error, key: "syscall"): string | undefined {
  const value = (err as NodeJS.ErrnoException)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function serializeOneError(err: unknown): SerializedErrorCause {
  if (err instanceof Error) {
    const record: SerializedErrorCause = { message: err.message };
    if (err.name && err.name !== "Error") {
      record.name = err.name;
    }
    const code = readErrorCode(err);
    if (code) {
      record.code = code;
    }
    const errno = readErrorNumber(err, "errno");
    if (errno !== undefined) {
      record.errno = errno;
    }
    const syscall = readErrorString(err, "syscall");
    if (syscall) {
      record.syscall = syscall;
    }
    if (err.stack) {
      record.stack = err.stack;
    }
    return record;
  }
  return { message: String(err) };
}

/**
 * Walk `error.cause` recursively (depth-capped) for log attributes.
 * Exported for unit tests.
 */
export function serializeErrorCauseChain(
  err: unknown,
  maxDepth = 8,
): SerializedErrorCause[] {
  const chain: SerializedErrorCause[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  for (let depth = 0; depth < maxDepth && current !== undefined && current !== null; depth++) {
    if (typeof current === "object" && seen.has(current)) {
      chain.push({ message: "[cause cycle]" });
      break;
    }
    if (typeof current === "object") {
      seen.add(current);
    }

    chain.push(serializeOneError(current));

    const next =
      current instanceof Error && current.cause !== undefined ? current.cause : undefined;
    current = next;
  }

  return chain;
}

export function formatErrorCauseChainJson(err: unknown): string {
  return JSON.stringify(serializeErrorCauseChain(err));
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

export interface LogAttributes {
  [key: string]: string | number | boolean;
}

function emitLog(
  severity: LogSeverity,
  body: string,
  attributes?: LogAttributes,
): void {
  const tel = telemetry;
  if (!tel) return;
  try {
    tel.logger.emit({
      severityNumber: SEVERITY_NUMBERS[severity],
      severityText: severity,
      body,
      attributes: attributes ?? {},
    });
  } catch {
    // Never throw from telemetry
  }
}

export function logDebug(body: string, attributes?: LogAttributes): void {
  emitLog("DEBUG", body, attributes);
}

export function logInfo(body: string, attributes?: LogAttributes): void {
  emitLog("INFO", body, attributes);
}

export function logWarn(body: string, attributes?: LogAttributes): void {
  emitLog("WARN", body, attributes);
}

export function logError(body: string, attributes?: LogAttributes): void {
  emitLog("ERROR", body, attributes);
}

export function logErrorWithCause(
  body: string,
  err: unknown,
  attributes?: LogAttributes,
): void {
  const causes = serializeErrorCauseChain(err);
  const attrs: LogAttributes = {
    ...attributes,
    error: errorMessage(err),
  };
  if (causes.length > 0) {
    attrs.error_causes = formatErrorCauseChainJson(err);
    const root = causes[0];
    const coded = causes.find((entry) => entry.code);
    if (coded?.code) {
      attrs.error_code = coded.code;
    }
    if (root.name) {
      attrs.error_name = root.name;
    }
  }
  logError(body, attrs);
}
