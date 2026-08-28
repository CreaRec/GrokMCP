import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFile, access } from "node:fs/promises";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  rasterizePdfFirstPageToJpeg,
  cleanupPdfPageJpegTemp,
  PDF_PAGE_JPEG_SCALE_TO,
} from "./pdf-page-jpeg.js";

describe("rasterizePdfFirstPageToJpeg", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("uses pdftoppm with scale-to cap on page 1", async () => {
    execFileMock.mockImplementation(
      (
        cmd: string,
        args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        void (async () => {
          if (cmd === "pdftoppm") {
            const prefix = args[args.length - 1];
            await writeFile(`${prefix}.jpg`, Buffer.alloc(64, 0xff));
          }
          cb(null, "", "");
        })();
        return {};
      },
    );

    const result = await rasterizePdfFirstPageToJpeg("/mnt/synology/Documents/offer.pdf");

    expect(result.jpegPath).toMatch(/offer\.jpg$/);
    expect(result.jpegBytes).toBe(64);
    expect(result.tempDir).toContain("synology-pdf-page-jpeg-");

    const pdftoppmCall = execFileMock.mock.calls.find((c) => c[0] === "pdftoppm") as [
      string,
      string[],
    ];
    expect(pdftoppmCall[1]).toEqual([
      "-jpeg",
      "-singlefile",
      "-f",
      "1",
      "-l",
      "1",
      "-scale-to",
      String(PDF_PAGE_JPEG_SCALE_TO),
      "/mnt/synology/Documents/offer.pdf",
      expect.stringMatching(/offer$/),
    ]);

    await cleanupPdfPageJpegTemp(result.tempDir);
    await expect(access(result.tempDir)).rejects.toThrow();
  });

  it("falls back to ImageMagick when pdftoppm fails", async () => {
    execFileMock.mockImplementation(
      (
        cmd: string,
        args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        void (async () => {
          if (cmd === "pdftoppm") {
            cb(new Error("pdftoppm missing"), "", "");
            return;
          }
          if (cmd === "magick") {
            const dest = args[args.length - 1];
            await writeFile(dest, Buffer.alloc(32, 0xaa));
            cb(null, "", "");
            return;
          }
          cb(new Error("unexpected"), "", "");
        })();
        return {};
      },
    );

    const result = await rasterizePdfFirstPageToJpeg("/mnt/synology/Documents/scan.pdf");
    expect(result.jpegBytes).toBe(32);
    expect(execFileMock.mock.calls.some((c) => c[0] === "magick")).toBe(true);

    await cleanupPdfPageJpegTemp(result.tempDir);
  });
});
