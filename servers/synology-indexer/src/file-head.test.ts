import { describe, it, expect, vi, beforeEach } from "vitest";

const statMock = vi.fn();
const openMock = vi.fn();

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (...args: unknown[]) => statMock(...args),
    open: (...args: unknown[]) => openMock(...args),
  };
});

import { readTextFileHead } from "./file-head.js";

describe("readTextFileHead", () => {
  beforeEach(() => {
    statMock.mockReset();
    openMock.mockReset();
  });

  it("reads only the first maxBytes without loading the whole file", async () => {
    const hugeSize = 13.7 * 1024 ** 3;
    const snippet = "SELECT * FROM users;\n";

    statMock.mockResolvedValue({ size: hugeSize });
    openMock.mockResolvedValue({
      read: vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
        const data = Buffer.from(snippet, "utf-8");
        const bytesRead = Math.min(length, data.length);
        data.copy(buffer, 0, 0, bytesRead);
        return { bytesRead };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const result = await readTextFileHead("/mnt/synology/Documents/pg_dump.sql", 4096);

    expect(result.text).toBe(snippet);
    expect(result.totalBytes).toBe(hugeSize);
    expect(result.bytesRead).toBe(snippet.length);
    expect(result.truncated).toBe(true);
    expect(openMock).toHaveBeenCalledWith("/mnt/synology/Documents/pg_dump.sql", "r");
    expect(statMock).toHaveBeenCalledOnce();
  });

  it("does not throw for files larger than 2 GiB", async () => {
    const over2GiB = 3 * 1024 ** 3;
    statMock.mockResolvedValue({ size: over2GiB });
    openMock.mockResolvedValue({
      read: vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
        const data = Buffer.from("-- head", "utf-8");
        const bytesRead = Math.min(length, data.length);
        data.copy(buffer, 0, 0, bytesRead);
        return { bytesRead };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    await expect(readTextFileHead("/mnt/synology/huge.sql", 64)).resolves.toMatchObject({
      totalBytes: over2GiB,
      truncated: true,
    });
  });
});
