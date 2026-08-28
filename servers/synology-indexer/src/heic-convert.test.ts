import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { convertHeicToJpeg, cleanupHeicTemp } from "./heic-convert.js";

describe("heic conversion temp cleanup", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (
        cmd: string,
        _args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd === "heif-convert") {
          cb(null, "", "");
          return;
        }
        cb(new Error("not found"), "", "");
      },
    );
  });

  it("creates jpeg under mkdtemp and cleanupHeicTemp removes the dir", async () => {
    const parent = await mkdtemp(join(tmpdir(), "heic-test-parent-"));
    const heicPath = join(parent, "photo.heic");

    const converted = await convertHeicToJpeg(heicPath);
    expect(converted.jpegPath).toContain("photo.jpg");
    expect(converted.tempDir).toContain("synology-heic-");

    await cleanupHeicTemp(converted.tempDir);

    await expect(rm(converted.tempDir, { recursive: true })).rejects.toThrow();
    await rm(parent, { recursive: true, force: true });
  });

  it("falls back to magick when heif-convert is unavailable", async () => {
    execFileMock.mockImplementation(
      (
        cmd: string,
        _args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd === "heif-convert") {
          cb(new Error("missing"), "", "");
          return;
        }
        if (cmd === "magick") {
          cb(null, "", "");
          return;
        }
        cb(new Error("unexpected"), "", "");
      },
    );

    const converted = await convertHeicToJpeg("/mnt/synology/Documents/x.heic");
    expect(converted.jpegPath).toMatch(/\.jpg$/);
    await cleanupHeicTemp(converted.tempDir);
  });
});
