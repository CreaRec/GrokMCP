import { spawn } from "node:child_process";
import type { PrintConfig } from "./config.js";

export type DuplexMode = "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";

export interface PrintFileOptions {
  filePath: string;
  copies?: number;
  sides?: DuplexMode;
  printer?: string;
}

export interface PrintResult {
  ok: boolean;
  jobId?: string;
  printer?: string;
  error?: string;
}

export interface PrinterInfo {
  name: string;
  status: string;
  enabled: boolean;
  accepting: boolean;
}

export interface ListPrintersResult {
  ok: boolean;
  defaultPrinter?: string | null;
  printers?: PrinterInfo[];
  error?: string;
}

export type RunCommand = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export async function defaultRunCommand(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

const PRINTER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafePrinterName(name: string): string {
  const trimmed = name.trim();
  if (!PRINTER_NAME_RE.test(trimmed)) {
    throw new Error(
      "Invalid printer name (allowed: letters, digits, ., _, -; max 128 chars)",
    );
  }
  return trimmed;
}

export function buildLpArgs(options: PrintFileOptions, defaultPrinter?: string): string[] {
  const copies = options.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > 100) {
    throw new Error("copies must be an integer between 1 and 100");
  }

  const printer = options.printer?.trim() || defaultPrinter;
  if (!printer) {
    throw new Error(
      "No printer specified; set CUPS_PRINTER/DEFAULT_PRINTER or pass printer",
    );
  }
  const safePrinter = assertSafePrinterName(printer);

  const args: string[] = ["-d", safePrinter, "-n", String(copies)];

  if (options.sides) {
    const allowed: DuplexMode[] = [
      "one-sided",
      "two-sided-long-edge",
      "two-sided-short-edge",
    ];
    if (!allowed.includes(options.sides)) {
      throw new Error(`Invalid sides value: ${options.sides}`);
    }
    args.push("-o", `sides=${options.sides}`);
  }

  args.push("--", options.filePath);
  return args;
}

export function parseLpJobId(stdout: string, stderr: string): string | undefined {
  const text = `${stdout}\n${stderr}`;
  const match = text.match(/request id is\s+(\S+)/i);
  return match?.[1];
}

export function parseLpstat(output: string): {
  printers: PrinterInfo[];
  defaultPrinter: string | null;
} {
  const printers: PrinterInfo[] = [];
  let defaultPrinter: string | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const defaultMatch = line.match(/^system default destination:\s+(\S+)/i);
    if (defaultMatch) {
      defaultPrinter = defaultMatch[1];
      continue;
    }

    // lpstat -p lines: "printer NAME is idle.  enabled since ..."
    // or "printer NAME disabled since ... - reason"
    const printerMatch = line.match(/^printer\s+(\S+)\s+(.+)$/i);
    if (printerMatch) {
      const name = printerMatch[1];
      const rest = printerMatch[2];
      const enabled = !/\bdisabled\b/i.test(rest);
      const accepting = !/\bnot accepting\b/i.test(rest);
      let status = "unknown";
      if (/\bis idle\b/i.test(rest)) status = "idle";
      else if (/\bprinting\b/i.test(rest)) status = "printing";
      else if (/\bdisabled\b/i.test(rest)) status = "disabled";
      else if (/\bstopped\b/i.test(rest)) status = "stopped";
      else status = rest.slice(0, 120);
      printers.push({ name, status, enabled, accepting });
    }
  }

  return { printers, defaultPrinter };
}

function cupsEnv(config: PrintConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (config.cupsServer) {
    env.CUPS_SERVER = config.cupsServer;
  }
  return env;
}

export async function listPrinters(
  config: PrintConfig,
  run: RunCommand = defaultRunCommand,
): Promise<ListPrintersResult> {
  try {
    const { stdout, stderr, code } = await run(
      "lpstat",
      ["-p", "-d"],
      cupsEnv(config),
    );
    if (code !== 0) {
      const message = (stderr || stdout || `lpstat exited with code ${code}`).trim();
      return { ok: false, error: message };
    }
    const parsed = parseLpstat(`${stdout}\n${stderr}`);
    return {
      ok: true,
      defaultPrinter: parsed.defaultPrinter ?? config.defaultPrinter ?? null,
      printers: parsed.printers,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function printFile(
  config: PrintConfig,
  options: PrintFileOptions,
  run: RunCommand = defaultRunCommand,
): Promise<PrintResult> {
  try {
    const args = buildLpArgs(options, config.defaultPrinter);
    const printer = assertSafePrinterName(
      options.printer?.trim() || config.defaultPrinter || "",
    );
    const { stdout, stderr, code } = await run("lp", args, cupsEnv(config));
    if (code !== 0) {
      const message = (stderr || stdout || `lp exited with code ${code}`).trim();
      return { ok: false, printer, error: message };
    }
    const jobId = parseLpJobId(stdout, stderr);
    return { ok: true, jobId, printer };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
