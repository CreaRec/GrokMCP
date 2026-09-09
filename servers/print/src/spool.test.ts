import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAllowedExtension,
  resolvePrintSource,
  resolveSpoolPath,
} from "./spool.js";
import type { PrintConfig } from "./config.js";

describe("resolveSpoolPath", () => {
  it("accepts paths under the spool root", () => {
    expect(resolveSpoolPath("/var/tmp/print-mcp", "/var/tmp/print-mcp/a.pdf")).toBe(
      "/var/tmp/print-mcp/a.pdf",
    );
  });

  it("rejects traversal and paths outside the jail", () => {
    expect(() =>
      resolveSpoolPath("/var/tmp/print-mcp", "/var/tmp/print-mcp/../etc/passwd"),
    ).toThrow(/under PRINT_SPOOL_DIR/);
    expect(() => resolveSpoolPath("/var/tmp/print-mcp", "/etc/passwd")).toThrow(
      /under PRINT_SPOOL_DIR/,
    );
    expect(() => resolveSpoolPath("/var/tmp/print-mcp", "relative.pdf")).toThrow(
      /absolute path/,
    );
  });

  it("rejects unsupported extensions", () => {
    expect(() => assertAllowedExtension("/var/tmp/print-mcp/a.exe")).toThrow(
      /Unsupported file type/,
    );
  });
});

describe("resolvePrintSource", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("resolves an existing spool path", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const filePath = path.join(spool, "page.pdf");
    await writeFile(filePath, "%PDF-1.4\n");

    const config: PrintConfig = {
      cupsServer: undefined,
      defaultPrinter: "HP",
      printSpoolDir: spool,
      downloadTimeoutMs: 5_000,
      maxDownloadBytes: 1_000_000,
    };

    const resolved = await resolvePrintSource(config, { path: filePath });
    expect(resolved.filePath).toBe(filePath);
    expect(resolved.cleanup).toBe(false);
  });

  it("materializes base64 under the spool", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const config: PrintConfig = {
      cupsServer: undefined,
      defaultPrinter: "HP",
      printSpoolDir: spool,
      downloadTimeoutMs: 5_000,
      maxDownloadBytes: 1_000_000,
    };

    const resolved = await resolvePrintSource(config, {
      contentBase64: Buffer.from("hello").toString("base64"),
      filename: "note.png",
    });
    expect(resolved.cleanup).toBe(true);
    expect(resolved.filePath.startsWith(spool)).toBe(true);
    expect(resolved.filePath.endsWith("note.png")).toBe(true);
  });

  it("requires exactly one source", async () => {
    const config: PrintConfig = {
      cupsServer: undefined,
      defaultPrinter: "HP",
      printSpoolDir: "/var/tmp/print-mcp",
      downloadTimeoutMs: 5_000,
      maxDownloadBytes: 1_000_000,
    };
    await expect(resolvePrintSource(config, {})).rejects.toThrow(/exactly one/);
  });
});
