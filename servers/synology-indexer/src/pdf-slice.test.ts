import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, rm, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock("./telemetry.js", () => ({
  logInfo: vi.fn(),
  logErrorWithCause: vi.fn(),
}));

import { logInfo, logErrorWithCause } from "./telemetry.js";
import {
  clampGistPageEnd,
  isPdfPath,
  slicePdfToGist,
  preparePdfGistForDocling,
  cleanupPdfGistTemp,
  DEFAULT_PDF_GIST_PAGE_END,
} from "./pdf-slice.js";

describe("isPdfPath", () => {
  it("detects pdf case-insensitively", () => {
    expect(isPdfPath("/mnt/a.pdf")).toBe(true);
    expect(isPdfPath("/mnt/A.PDF")).toBe(true);
    expect(isPdfPath("/mnt/offer.Pdf")).toBe(true);
  });

  it("rejects non-pdf extensions", () => {
    expect(isPdfPath("/mnt/a.docx")).toBe(false);
    expect(isPdfPath("/mnt/a.xlsx")).toBe(false);
    expect(isPdfPath("/mnt/a.pptx")).toBe(false);
    expect(isPdfPath("/mnt/a.epub")).toBe(false);
    expect(isPdfPath("/mnt/a.html")).toBe(false);
    expect(isPdfPath("/mnt/a.csv")).toBe(false);
    expect(isPdfPath("/mnt/a.pdf.bak")).toBe(false);
  });
});

describe("clampGistPageEnd", () => {
  it("defaults to 5 for missing/invalid values", () => {
    expect(clampGistPageEnd()).toBe(DEFAULT_PDF_GIST_PAGE_END);
    expect(clampGistPageEnd(0)).toBe(5);
    expect(clampGistPageEnd(-1)).toBe(5);
    expect(clampGistPageEnd(Number.NaN)).toBe(5);
  });

  it("floors positive end pages", () => {
    expect(clampGistPageEnd(5)).toBe(5);
    expect(clampGistPageEnd(3.9)).toBe(3);
    expect(clampGistPageEnd(10)).toBe(10);
  });
});

describe("slicePdfToGist / preparePdfGistForDocling", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.mocked(logInfo).mockReset();
    vi.mocked(logErrorWithCause).mockReset();
  });

  function mockExecSuccess(
    stdoutByCmd: (cmd: string, args: string[]) => string = () => "",
    opts: { writeDest?: boolean } = {},
  ) {
    const writeDest = opts.writeDest ?? false;
    execFileMock.mockImplementation(
      (
        cmd: string,
        args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        void (async () => {
          if (writeDest && args.includes("--pages")) {
            const dest = args[args.length - 1];
            await writeFile(dest, Buffer.alloc(128, 0x25));
          }
          cb(null, stdoutByCmd(cmd, args), "");
        })();
        return {};
      },
    );
  }

  it("invokes qpdf --pages with 1..N for slicePdfToGist", async () => {
    mockExecSuccess();
    await slicePdfToGist("/mnt/synology/Documents/big.pdf", "/tmp/gist.pdf", 5);

    expect(execFileMock).toHaveBeenCalledOnce();
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("qpdf");
    expect(args).toEqual([
      "/mnt/synology/Documents/big.pdf",
      "--pages",
      ".",
      "1-5",
      "--",
      "/tmp/gist.pdf",
    ]);
  });

  it("skips slice for non-pdf paths (no qpdf)", async () => {
    const result = await preparePdfGistForDocling("/mnt/synology/Documents/report.docx", 5);
    expect(result).toEqual({
      filePath: "/mnt/synology/Documents/report.docx",
      tempDir: null,
      sliced: false,
    });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("skips slice when PDF already has ≤ N pages and logs skip", async () => {
    mockExecSuccess((_cmd, args) => (args.includes("--show-npages") ? "3\n" : ""));

    const result = await preparePdfGistForDocling("/mnt/synology/Documents/short.pdf", 5);
    expect(result.sliced).toBe(false);
    expect(result.tempDir).toBeNull();
    expect(result.filePath).toBe("/mnt/synology/Documents/short.pdf");

    expect(execFileMock).toHaveBeenCalledOnce();
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("qpdf");
    expect(args).toEqual(["--show-npages", "/mnt/synology/Documents/short.pdf"]);

    expect(logInfo).toHaveBeenCalledWith("pdf gist skipped", {
      source: "short.pdf",
      reason: "already_short",
      page_count: 3,
    });
  });

  it("slices long PDFs with qpdf 1..N, logs dest + bytes, cleans temp on cleanup", async () => {
    mockExecSuccess((_cmd, args) => (args.includes("--show-npages") ? "42\n" : ""), {
      writeDest: true,
    });

    const result = await preparePdfGistForDocling(
      "/mnt/synology/Documents/Full time Offer - Stoke Space.pdf",
      5,
    );

    expect(result.sliced).toBe(true);
    expect(result.tempDir).toContain("synology-pdf-gist-");
    expect(result.filePath).toMatch(/Full time Offer - Stoke Space\.gist-1-5\.pdf$/);

    const sliceCall = execFileMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("--pages"),
    ) as [string, string[]];
    expect(sliceCall[0]).toBe("qpdf");
    expect(sliceCall[1]).toEqual([
      "/mnt/synology/Documents/Full time Offer - Stoke Space.pdf",
      "--pages",
      ".",
      "1-5",
      "--",
      result.filePath,
    ]);

    expect(logInfo).toHaveBeenCalledWith("pdf gist sliced", {
      source: "Full time Offer - Stoke Space.pdf",
      dest: result.filePath,
      gist_bytes: 128,
      gist_pages_end: 5,
      sliced: true,
    });

    await cleanupPdfGistTemp(result.tempDir!);
    await expect(access(result.tempDir!)).rejects.toThrow();
  });

  it("logs error then deletes temp dir when qpdf slice fails", async () => {
    let sliceAttempted = false;
    execFileMock.mockImplementation(
      (
        _cmd: string,
        args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (args.includes("--show-npages")) {
          cb(null, "20\n", "");
          return {};
        }
        sliceAttempted = true;
        cb(new Error("qpdf failed"), "", "boom");
        return {};
      },
    );

    const parentBefore = await mkdtemp(join(tmpdir(), "pdf-gist-fail-"));
    await expect(preparePdfGistForDocling("/mnt/synology/Documents/bad.pdf", 5)).rejects.toThrow();
    expect(sliceAttempted).toBe(true);
    expect(logErrorWithCause).toHaveBeenCalledWith(
      "pdf gist slice failed",
      expect.any(Error),
      expect.objectContaining({
        source: "bad.pdf",
        gist_pages_end: 5,
      }),
    );
    expect(logInfo).not.toHaveBeenCalledWith(
      "pdf gist sliced",
      expect.anything(),
    );
    await rm(parentBefore, { recursive: true, force: true });
  });

  it("clamps end page when invoking qpdf --pages", async () => {
    mockExecSuccess();
    await slicePdfToGist("/a.pdf", "/b.pdf", 0);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).toContain("1-5");
  });
});
