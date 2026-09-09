export interface PrintConfig {
  cupsServer: string | undefined;
  defaultPrinter: string | undefined;
  printSpoolDir: string;
  downloadTimeoutMs: number;
  maxDownloadBytes: number;
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) return fallback;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function getConfig(): PrintConfig {
  const cupsServer = process.env.CUPS_SERVER?.trim() || undefined;
  const defaultPrinter =
    process.env.CUPS_PRINTER?.trim() ||
    process.env.DEFAULT_PRINTER?.trim() ||
    undefined;
  const printSpoolDir =
    process.env.PRINT_SPOOL_DIR?.trim() || "/var/tmp/print-mcp";

  return {
    cupsServer,
    defaultPrinter,
    printSpoolDir,
    downloadTimeoutMs: positiveInt(
      process.env.PRINT_DOWNLOAD_TIMEOUT_MS,
      30_000,
      "PRINT_DOWNLOAD_TIMEOUT_MS",
    ),
    maxDownloadBytes: positiveInt(
      process.env.PRINT_MAX_DOWNLOAD_BYTES,
      50 * 1024 * 1024,
      "PRINT_MAX_DOWNLOAD_BYTES",
    ),
  };
}
