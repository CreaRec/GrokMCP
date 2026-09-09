import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getConfig", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses defaults when env is unset", async () => {
    vi.unstubAllEnvs();
    const { getConfig } = await import("./config.js");
    expect(getConfig()).toEqual({
      cupsServer: undefined,
      defaultPrinter: undefined,
      printSpoolDir: "/var/tmp/print-mcp",
      downloadTimeoutMs: 30_000,
      maxDownloadBytes: 50 * 1024 * 1024,
    });
  });

  it("reads CUPS_SERVER, CUPS_PRINTER, and PRINT_SPOOL_DIR", async () => {
    vi.stubEnv("CUPS_SERVER", "192.168.1.10:631");
    vi.stubEnv("CUPS_PRINTER", "HP_LaserJet_Tank_2504dw");
    vi.stubEnv("PRINT_SPOOL_DIR", "/home/crearec/print-spool");
    const { getConfig } = await import("./config.js");
    expect(getConfig()).toMatchObject({
      cupsServer: "192.168.1.10:631",
      defaultPrinter: "HP_LaserJet_Tank_2504dw",
      printSpoolDir: "/home/crearec/print-spool",
    });
  });

  it("falls back to DEFAULT_PRINTER", async () => {
    vi.stubEnv("DEFAULT_PRINTER", "Office_Printer");
    const { getConfig } = await import("./config.js");
    expect(getConfig().defaultPrinter).toBe("Office_Printer");
  });
});
