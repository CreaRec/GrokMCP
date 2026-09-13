import { access, mkdtemp, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

/** Minimal ZIP-like office payload for mocked soffice tests (passes PK preflight). */
function fakeZipOffice(tag = "fake"): Buffer {
  return Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from(tag.padEnd(64, "x"))]);
}

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

  it("passes a unique -env:UserInstallation profile under the job outdir", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const filePath = path.join(spool, "memo.docx");
    await writeFile(filePath, fakeZipOffice());

    let capturedArgs: string[] | undefined;
    const run: RunCommand = async (_command, args) => {
      capturedArgs = args;
      const outDir = args[args.indexOf("--outdir") + 1]!;
      await writeFile(path.join(outDir, "memo.pdf"), "%PDF-1.4\n");
      return { stdout: "ok", stderr: "", code: 0 };
    };

    await preparePrintReadyFile(testConfig(spool), { filePath, cleanup: false }, run);

    expect(capturedArgs).toBeDefined();
    const envArg = capturedArgs!.find((a) => a.startsWith("-env:UserInstallation="));
    expect(envArg).toBeDefined();
    expect(envArg!.startsWith("-env:UserInstallation=file://")).toBe(true);
    expect(capturedArgs![0]).toBe(envArg);

    const outDir = capturedArgs![capturedArgs!.indexOf("--outdir") + 1]!;
    const expectedProfile = pathToFileURL(path.join(outDir, "lo-profile")).href;
    expect(envArg).toBe(`-env:UserInstallation=${expectedProfile}`);
  });

  it("polls for the PDF after soffice exits 0 before the file appears", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const filePath = path.join(spool, "delayed.docx");
    await writeFile(filePath, fakeZipOffice());

    const run: RunCommand = async (_command, args) => {
      const outDir = args[args.indexOf("--outdir") + 1]!;
      const pdfPath = path.join(outDir, "delayed.pdf");
      // Simulate LibreOffice exiting before the PDF is flushed to disk.
      void (async () => {
        await new Promise((r) => setTimeout(r, 120));
        await writeFile(pdfPath, "%PDF-1.4\nlate\n");
      })();
      return { stdout: "convert done", stderr: "", code: 0 };
    };

    const ready = await preparePrintReadyFile(
      testConfig(spool),
      { filePath, cleanup: false },
      run,
    );

    expect(ready.filePath.endsWith("delayed.pdf")).toBe(true);
    await access(ready.filePath);
  });

  it("includes truncated soffice stdout/stderr when exit 0 but no PDF appears", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const filePath = path.join(spool, "lezione1-rimma.docx");
    await writeFile(filePath, fakeZipOffice());

    const prevWait = process.env.PRINT_CONVERT_PDF_WAIT_MS;
    const prevPoll = process.env.PRINT_CONVERT_PDF_POLL_MS;
    process.env.PRINT_CONVERT_PDF_WAIT_MS = "200";
    process.env.PRINT_CONVERT_PDF_POLL_MS = "40";

    const run: RunCommand = async () => ({
      stdout: "Warn: something odd happened during export",
      stderr: "javaldx failed: profile lock contention",
      code: 0,
    });

    try {
      await expect(
        preparePrintReadyFile(testConfig(spool), { filePath, cleanup: false }, run),
      ).rejects.toThrow(
        /LibreOffice reported success but no PDF was produced for "lezione1-rimma\.docx".*stdout:.*something odd.*stderr:.*javaldx failed/,
      );
    } finally {
      if (prevWait === undefined) delete process.env.PRINT_CONVERT_PDF_WAIT_MS;
      else process.env.PRINT_CONVERT_PDF_WAIT_MS = prevWait;
      if (prevPoll === undefined) delete process.env.PRINT_CONVERT_PDF_POLL_MS;
      else process.env.PRINT_CONVERT_PDF_POLL_MS = prevPoll;
    }
  });

  it("converts base64 docx inside upload-* and reuses that cleanup dir", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const config = testConfig(spool);

    const resolved = await resolvePrintSource(config, {
      contentBase64: fakeZipOffice("docx").toString("base64"),
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

  it("rejects truncated/non-ZIP docx before calling soffice", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const filePath = path.join(spool, "lezione1-rimma.docx");
    await writeFile(filePath, "not-a-real-docx");

    const run = vi.fn<RunCommand>();
    await expect(
      preparePrintReadyFile(testConfig(spool), { filePath, cleanup: false }, run),
    ).rejects.toThrow(/contentBase64 looks truncated or invalid/);
    expect(run).not.toHaveBeenCalled();

    const entries = await readdir(spool);
    expect(entries.filter((e) => e.startsWith("convert-"))).toEqual([]);
  });

  it("surfaces LibreOffice failures clearly for non-ZIP convertible types", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const filePath = path.join(spool, "broken.rtf");
    await writeFile(filePath, "not-rtf-but-large-enough");

    const run: RunCommand = async () => ({
      stdout: "",
      stderr: "Error: source file could not be loaded",
      code: 1,
    });

    await expect(
      preparePrintReadyFile(testConfig(spool), { filePath, cleanup: false }, run),
    ).rejects.toThrow(/LibreOffice failed to convert|LibreOffice failed|failed to convert/i);

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

  it("rejects tiny docx payloads as truncated contentBase64", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-spool-"));
    dirs.push(spool);
    const filePath = path.join(spool, "tiny.docx");
    await writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04])); // PK only, 4 bytes

    const runCmd = vi.fn<RunCommand>();
    await expect(
      preparePrintReadyFile(testConfig(spool), { filePath, cleanup: false }, runCmd),
    ).rejects.toThrow(/contentBase64 looks truncated or invalid.*got 4 bytes/);
    expect(runCmd).not.toHaveBeenCalled();
  });

});
