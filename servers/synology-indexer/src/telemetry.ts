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
  logError(body, {
    ...attributes,
    error: errorMessage(err),
  });
}
