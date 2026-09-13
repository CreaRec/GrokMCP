import { access, mkdtemp, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePrintReadyFile } from "./convert.js";
import type { RunCommand } from "./cups.js";
import type { PrintConfig } from "./config.js";
import {
  assertAllowedExtension,
  cleanupResolvedPrintFile,
  needsPdfConversion,
  resolvePrintSource,
} from "./spool.js";

function testConfig(spool: string): PrintConfig {
  return {
    cupsServer: undefined,
    defaultPrinter: "HP",
    printSpoolDir: spool,
    downloadTimeoutMs: 5_000,
    maxDownloadBytes: 1_000_000,
  };
}

describe("preparePrintReadyFile", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("passes PDF/PNG/JPG through without calling soffice", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const filePath = path.join(spool, "page.pdf");
    await writeFile(filePath, "%PDF-1.4\n");

    const run = vi.fn<RunCommand>();
    const ready = await preparePrintReadyFile(
      testConfig(spool),
      { filePath, cleanup: false },
      run,
    );

    expect(ready.filePath).toBe(filePath);
    expect(ready.cleanup).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(needsPdfConversion(filePath)).toBe(false);
    expect(needsPdfConversion(path.join(spool, "x.png"))).toBe(false);
    expect(needsPdfConversion(path.join(spool, "x.jpg"))).toBe(false);
  });

  it("converts txt/docx via soffice and cleans convert-* for path= sources", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const filePath = path.join(spool, "notes.txt");
    await writeFile(filePath, "hello from print mcp\n");

    const run: RunCommand = async (command, args) => {
      expect(command).toBe("soffice");
      expect(args).toContain("--convert-to");
      expect(args).toContain("pdf");
      const outdirIdx = args.indexOf("--outdir");
      const outDir = args[outdirIdx + 1]!;
      const pdfPath = path.join(outDir, "notes.pdf");
      await writeFile(pdfPath, "%PDF-1.4\nconverted\n");
      return { stdout: "convert notes.txt as a Writer document -> notes.pdf", stderr: "", code: 0 };
    };

    const ready = await preparePrintReadyFile(
      testConfig(spool),
      { filePath, cleanup: false },
      run,
    );

    expect(ready.filePath.endsWith("notes.pdf")).toBe(true);
    expect(ready.cleanup).toBe(true);
    expect(path.basename(ready.cleanupDir!).startsWith("convert-")).toBe(true);
    await access(ready.filePath);
    // Original path= file must remain.
    await access(filePath);

    await cleanupResolvedPrintFile(spool, ready);
    await expect(access(ready.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await access(filePath);
  });

  it("converts base64 docx inside upload-* and reuses that cleanup dir", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const config = testConfig(spool);

    const resolved = await resolvePrintSource(config, {
      contentBase64: Buffer.from("PK fake-docx").toString("base64"),
      filename: "letter.docx",
    });
    expect(needsPdfConversion(resolved.filePath)).toBe(true);

    const run: RunCommand = async (_command, args) => {
      const outDir = args[args.indexOf("--outdir") + 1]!;
      await writeFile(path.join(outDir, "letter.pdf"), "%PDF-1.4\n");
      return { stdout: "ok", stderr: "", code: 0 };
    };

    const ready = await preparePrintReadyFile(config, resolved, run);
    expect(ready.filePath.endsWith("letter.pdf")).toBe(true);
    expect(ready.cleanupDir).toBe(resolved.cleanupDir);
    expect(path.basename(ready.cleanupDir!).startsWith("upload-")).toBe(true);

    await cleanupResolvedPrintFile(spool, ready);
    await expect(access(resolved.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(ready.filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces LibreOffice failures clearly", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const filePath = path.join(spool, "broken.docx");
    await writeFile(filePath, "not-a-real-docx");

    const run: RunCommand = async () => ({
      stdout: "",
      stderr: "Error: source file could not be loaded",
      code: 1,
    });

    await expect(
      preparePrintReadyFile(testConfig(spool), { filePath, cleanup: false }, run),
    ).rejects.toThrow(/LibreOffice failed to convert/);

    // Failed path= conversion must not leave convert-* dirs behind.
    const entries = await readdir(spool);
    expect(entries.filter((e) => e.startsWith("convert-"))).toEqual([]);
  });

  it("rejects unsupported types with a helpful message", () => {
    expect(() => assertAllowedExtension("/spool/malware.exe")).toThrow(
      /Unsupported file type "\.exe"/,
    );
    expect(() => assertAllowedExtension("/spool/malware.exe")).toThrow(/docx/);
    expect(() => assertAllowedExtension("/spool/ok.docx")).not.toThrow();
    expect(() => assertAllowedExtension("/spool/ok.txt")).not.toThrow();
    expect(() => assertAllowedExtension("/spool/ok.pdf")).not.toThrow();
  });
});
