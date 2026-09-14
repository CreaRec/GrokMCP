import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrintConfig } from "./config.js";
import type { PrintResult } from "./cups.js";
import type { ResolvedPrintFile } from "./spool.js";
import {
  assertUploadAuthorized,
  handlePrintUpload,
  parseUploadPrintOptions,
  receiveMultipartUpload,
  receiveRawUpload,
  submitUploadedPrintJob,
  UploadHttpError,
} from "./upload.js";

function testConfig(spool: string, overrides: Partial<PrintConfig> = {}): PrintConfig {
  return {
    cupsServer: undefined,
    defaultPrinter: "HP_Test",
    printSpoolDir: spool,
    downloadTimeoutMs: 5_000,
    maxDownloadBytes: 1_000_000,
    maxUploadBytes: 1_000_000,
    uploadToken: undefined,
    ...overrides,
  };
}

function fakeZipOffice(tag = "fake"): Buffer {
  return Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from(tag.padEnd(64, "x"))]);
}

function mockRes() {
  const state: {
    statusCode: number;
    body: unknown;
    headersSent: boolean;
  } = { statusCode: 200, body: undefined, headersSent: false };

  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      state.headersSent = true;
      return res;
    },
  };
  return { res: res as unknown as import("express").Response, state };
}

describe("upload auth and options", () => {
  it("allows requests when PRINT_UPLOAD_TOKEN is unset", () => {
    expect(() =>
      assertUploadAuthorized(
        { headers: {} } as unknown as import("node:http").IncomingMessage,
        undefined,
      ),
    ).not.toThrow();
  });

  it("requires Bearer or X-Print-Token when token is configured", () => {
    const token = "secret-token";
    const asReq = (headers: Record<string, string>) =>
      ({ headers }) as unknown as import("node:http").IncomingMessage;

    expect(() => assertUploadAuthorized(asReq({}), token)).toThrow(UploadHttpError);

    expect(() =>
      assertUploadAuthorized(asReq({ authorization: "Bearer secret-token" }), token),
    ).not.toThrow();

    expect(() =>
      assertUploadAuthorized(asReq({ "x-print-token": "secret-token" }), token),
    ).not.toThrow();

    expect(() =>
      assertUploadAuthorized(asReq({ authorization: "Bearer wrong" }), token),
    ).toThrow(/Unauthorized/);
  });

  it("parses printer/copies/sides from query and form fields", () => {
    expect(
      parseUploadPrintOptions(
        { printer: "HP_A", copies: "2", duplex: "two-sided-long-edge" },
        { sides: "one-sided" },
      ),
    ).toEqual({
      printer: "HP_A",
      copies: 2,
      sides: "one-sided",
      filename: undefined,
    });
  });
});

describe("receiveRawUpload / receiveMultipartUpload", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("streams a raw PUT body into upload-* under the spool", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-upload-"));
    dirs.push(spool);
    const body = Buffer.from("%PDF-1.4\nraw-upload\n");
    const req = Readable.from([body]) as import("node:http").IncomingMessage;
    req.headers = {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
    };
    req.method = "PUT";

    const { resolved, options } = await receiveRawUpload(
      req,
      testConfig(spool),
      { filename: "page.pdf", copies: 1 },
    );

    expect(options.filename).toBe("page.pdf");
    expect(resolved.cleanup).toBe(true);
    expect(path.basename(resolved.cleanupDir!).startsWith("upload-")).toBe(true);
    expect(await readFile(resolved.filePath)).toEqual(body);
  });

  it("rejects oversize uploads via content-length", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-upload-"));
    dirs.push(spool);
    const req = Readable.from([Buffer.from("x")]) as import("node:http").IncomingMessage;
    req.headers = {
      "content-type": "application/octet-stream",
      "content-length": "9999",
    };

    await expect(
      receiveRawUpload(req, testConfig(spool, { maxUploadBytes: 8 }), {
        filename: "page.pdf",
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it("parses multipart, writes spool file, and reads print options", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-upload-"));
    dirs.push(spool);

    const pdf = Buffer.from("%PDF-1.4\nmultipart\n");
    const boundary = "----PrintBoundary7MA4YWxkTrZu0gW";
    const parts = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="printer"\r\n\r\n` +
          `HP_Queue\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="copies"\r\n\r\n` +
          `3\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="sides"\r\n\r\n` +
          `two-sided-long-edge\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="notes.pdf"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const req = Readable.from([parts]) as import("node:http").IncomingMessage;
    req.headers = {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(parts.length),
    };
    req.method = "POST";

    const { resolved, options } = await receiveMultipartUpload(
      req,
      testConfig(spool),
      {},
    );

    expect(options).toMatchObject({
      printer: "HP_Queue",
      copies: 3,
      sides: "two-sided-long-edge",
    });
    expect(resolved.filePath.endsWith("notes.pdf")).toBe(true);
    expect(await readFile(resolved.filePath)).toEqual(pdf);
    expect(path.basename(resolved.cleanupDir!).startsWith("upload-")).toBe(true);
  });

  it("rejects unsupported multipart filenames", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-upload-"));
    dirs.push(spool);

    const boundary = "----PrintBoundaryBadExt";
    const parts = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="malware.exe"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from("MZ"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const req = Readable.from([parts]) as import("node:http").IncomingMessage;
    req.headers = {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    };

    await expect(receiveMultipartUpload(req, testConfig(spool), {})).rejects.toThrow(
      /Unsupported file type/,
    );

    // No leftover upload dirs
    const entries = await readdir(spool);
    expect(entries).toEqual([]);
  });
});

describe("submitUploadedPrintJob + handlePrintUpload", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("runs preparePrintReadyFile then lp and cleans upload temps", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-upload-"));
    dirs.push(spool);
    const uploadDir = path.join(spool, "upload-test");
    const filePath = path.join(uploadDir, "doc.docx");
    await (await import("node:fs/promises")).mkdir(uploadDir);
    await (await import("node:fs/promises")).writeFile(filePath, fakeZipOffice());

    const resolved: ResolvedPrintFile = {
      filePath,
      cleanup: true,
      cleanupDir: uploadDir,
    };

    const prepare = vi.fn(async (_config: PrintConfig, input: ResolvedPrintFile) => {
      const pdfPath = path.join(path.dirname(input.filePath), "doc.pdf");
      await (await import("node:fs/promises")).writeFile(pdfPath, "%PDF\n");
      return { filePath: pdfPath, cleanup: true, cleanupDir: input.cleanupDir };
    });

    const print = vi.fn(async (): Promise<PrintResult> => ({
      ok: true,
      jobId: "HP_Test-42",
      printer: "HP_Test",
    }));

    const result = await submitUploadedPrintJob(
      testConfig(spool),
      resolved,
      { copies: 2, sides: "one-sided" },
      { prepare, print },
    );

    expect(result).toEqual({ ok: true, jobId: "HP_Test-42", printer: "HP_Test" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(print).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        copies: 2,
        sides: "one-sided",
        filePath: expect.stringMatching(/doc\.pdf$/),
      }),
    );

    await expect(readdir(spool)).resolves.toEqual([]);
  });

  it("handlePrintUpload end-to-end: multipart → mocked convert/lp", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-upload-"));
    dirs.push(spool);

    const docx = fakeZipOffice("multipart-docx");
    const boundary = "----E2EBoundary";
    const parts = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="printer"\r\n\r\n` +
          `HP_E2E\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="letter.docx"\r\n` +
          `Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`,
      ),
      docx,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const { res, state } = mockRes();
    const req = Readable.from([parts]) as import("express").Request;
    req.headers = {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(parts.length),
      authorization: "Bearer test-token",
    };
    req.method = "POST";
    req.query = {};

    const prepare = vi.fn(async (_c: PrintConfig, input: ResolvedPrintFile) => {
      expect(input.filePath.endsWith("letter.docx")).toBe(true);
      const pdfPath = path.join(path.dirname(input.filePath), "letter.pdf");
      await (await import("node:fs/promises")).writeFile(pdfPath, "%PDF-converted\n");
      return { ...input, filePath: pdfPath };
    });
    const print = vi.fn(async (): Promise<PrintResult> => ({
      ok: true,
      jobId: "HP_E2E-7",
      printer: "HP_E2E",
    }));

    await handlePrintUpload(req, res, {
      getConfig: () => testConfig(spool, { uploadToken: "test-token" }),
      prepare,
      print,
    });

    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({ ok: true, jobId: "HP_E2E-7", printer: "HP_E2E" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(print).toHaveBeenCalledOnce();
    await expect(readdir(spool)).resolves.toEqual([]);
  });

  it("returns 401 when upload token is required but missing", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-upload-"));
    dirs.push(spool);
    const { res, state } = mockRes();
    const req = Readable.from([]) as import("express").Request;
    req.headers = { "content-type": "application/octet-stream" };
    req.method = "PUT";
    req.query = { filename: "a.pdf" };

    await handlePrintUpload(req, res, {
      getConfig: () => testConfig(spool, { uploadToken: "needed" }),
    });

    expect(state.statusCode).toBe(401);
    expect(state.body).toMatchObject({ ok: false });
  });
});

describe("live HTTP server smoke (multipart)", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("accepts curl-like multipart over a real HTTP server", async () => {
    const spool = await mkdtemp(path.join(tmpdir(), "print-upload-"));
    dirs.push(spool);

    const prepare = vi.fn(async (_c: PrintConfig, input: ResolvedPrintFile) => input);
    const print = vi.fn(async (): Promise<PrintResult> => ({
      ok: true,
      jobId: "job-99",
      printer: "HP_Test",
    }));

    const server = createServer((req, res) => {
      // Minimal express-like shim for the handler
      const expressReq = req as import("express").Request;
      expressReq.query = Object.fromEntries(new URL(req.url || "/", "http://127.0.0.1").searchParams);
      const expressRes = {
        status(code: number) {
          res.statusCode = code;
          return expressRes;
        },
        json(payload: unknown) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(payload));
          return expressRes;
        },
      } as unknown as import("express").Response;

      void handlePrintUpload(expressReq, expressRes, {
        getConfig: () => testConfig(spool),
        prepare,
        print,
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const port = addr.port;

    const pdf = Buffer.from("%PDF-1.4\nhttp-smoke\n");
    const boundary = "----SmokeBoundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="smoke.pdf"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await fetch(`http://127.0.0.1:${port}/print/upload`, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    const json = (await response.json()) as PrintResult;
    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true, jobId: "job-99", printer: "HP_Test" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(print).toHaveBeenCalledOnce();

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });
});
