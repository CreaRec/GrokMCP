import { describe, expect, it, vi } from "vitest";
import {
  assertSafePrinterName,
  buildLpArgs,
  listPrinters,
  parseLpJobId,
  parseLpstat,
  printFile,
} from "./cups.js";
import type { PrintConfig } from "./config.js";

const baseConfig: PrintConfig = {
  cupsServer: "host.docker.internal:631",
  defaultPrinter: "HP_LaserJet_Tank_2504dw",
  printSpoolDir: "/var/tmp/print-mcp",
  downloadTimeoutMs: 30_000,
  maxDownloadBytes: 50 * 1024 * 1024,
};

describe("buildLpArgs", () => {
  it("builds safe argv without a shell", () => {
    expect(
      buildLpArgs(
        {
          filePath: "/var/tmp/print-mcp/doc.pdf",
          copies: 2,
          sides: "two-sided-long-edge",
        },
        "HP_LaserJet_Tank_2504dw",
      ),
    ).toEqual([
      "-d",
      "HP_LaserJet_Tank_2504dw",
      "-n",
      "2",
      "-o",
      "sides=two-sided-long-edge",
      "--",
      "/var/tmp/print-mcp/doc.pdf",
    ]);
  });

  it("rejects shell metacharacters in printer names", () => {
    expect(() => assertSafePrinterName("evil;rm -rf /")).toThrow(/Invalid printer/);
    expect(() =>
      buildLpArgs({ filePath: "/var/tmp/print-mcp/a.pdf", printer: "x$(reboot)" }, undefined),
    ).toThrow(/Invalid printer/);
  });

  it("requires a printer", () => {
    expect(() =>
      buildLpArgs({ filePath: "/var/tmp/print-mcp/a.pdf" }, undefined),
    ).toThrow(/No printer specified/);
  });

  it("rejects invalid copies", () => {
    expect(() =>
      buildLpArgs(
        { filePath: "/var/tmp/print-mcp/a.pdf", copies: 0 },
        "HP_LaserJet_Tank_2504dw",
      ),
    ).toThrow(/copies/);
  });
});

describe("parseLpJobId / parseLpstat", () => {
  it("parses lp job id", () => {
    expect(
      parseLpJobId("request id is HP_LaserJet_Tank_2504dw-42 (1 file(s))\n", ""),
    ).toBe("HP_LaserJet_Tank_2504dw-42");
  });

  it("parses lpstat -p -d output", () => {
    const output = `
printer HP_LaserJet_Tank_2504dw is idle.  enabled since Mon 01 Jan 2026 12:00:00 AM CST
printer Other_Queue disabled since Mon 01 Jan 2026 12:00:00 AM CST -
system default destination: HP_LaserJet_Tank_2504dw
`;
    const parsed = parseLpstat(output);
    expect(parsed.defaultPrinter).toBe("HP_LaserJet_Tank_2504dw");
    expect(parsed.printers).toEqual([
      {
        name: "HP_LaserJet_Tank_2504dw",
        status: "idle",
        enabled: true,
        accepting: true,
      },
      {
        name: "Other_Queue",
        status: "disabled",
        enabled: false,
        accepting: true,
      },
    ]);
  });
});

describe("printFile / listPrinters with mocked commands", () => {
  it("calls lp with built args and returns jobId", async () => {
    const run = vi.fn(async () => ({
      stdout: "request id is HP_LaserJet_Tank_2504dw-7 (1 file(s))\n",
      stderr: "",
      code: 0,
    }));

    const result = await printFile(
      baseConfig,
      {
        filePath: "/var/tmp/print-mcp/invoice.pdf",
        copies: 1,
        sides: "one-sided",
      },
      run,
    );

    expect(result).toEqual({
      ok: true,
      jobId: "HP_LaserJet_Tank_2504dw-7",
      printer: "HP_LaserJet_Tank_2504dw",
    });
    expect(run).toHaveBeenCalledWith(
      "lp",
      [
        "-d",
        "HP_LaserJet_Tank_2504dw",
        "-n",
        "1",
        "-o",
        "sides=one-sided",
        "--",
        "/var/tmp/print-mcp/invoice.pdf",
      ],
      expect.objectContaining({ CUPS_SERVER: "host.docker.internal:631" }),
    );
  });

  it("returns ok:false when lp fails", async () => {
    const run = vi.fn(async () => ({
      stdout: "",
      stderr: "lp: The printer is not responding.",
      code: 1,
    }));
    const result = await printFile(
      baseConfig,
      { filePath: "/var/tmp/print-mcp/a.pdf" },
      run,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not responding/);
  });

  it("lists printers via lpstat", async () => {
    const run = vi.fn(async () => ({
      stdout:
        "printer HP_LaserJet_Tank_2504dw is idle.  enabled since Mon 01 Jan 2026\nsystem default destination: HP_LaserJet_Tank_2504dw\n",
      stderr: "",
      code: 0,
    }));
    const result = await listPrinters(baseConfig, run);
    expect(result.ok).toBe(true);
    expect(result.defaultPrinter).toBe("HP_LaserJet_Tank_2504dw");
    expect(result.printers?.[0]?.name).toBe("HP_LaserJet_Tank_2504dw");
    expect(run).toHaveBeenCalledWith(
      "lpstat",
      ["-p", "-d"],
      expect.objectContaining({ CUPS_SERVER: "host.docker.internal:631" }),
    );
  });
});
