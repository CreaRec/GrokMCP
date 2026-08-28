import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTextFileHead } from "./file-head.js";

describe("readTextFileHead (integration)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "file-head-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns full content when file is smaller than maxBytes", async () => {
    const path = join(dir, "small.sql");
    await writeFile(path, "CREATE TABLE t (id int);", "utf-8");

    const result = await readTextFileHead(path, 65536);

    expect(result.text).toBe("CREATE TABLE t (id int);");
    expect(result.truncated).toBe(false);
  });

  it("reads only the head when file exceeds maxBytes", async () => {
    const path = join(dir, "medium.txt");
    const content = "A".repeat(200);
    await writeFile(path, content, "utf-8");

    const result = await readTextFileHead(path, 100);

    expect(result.text).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });
});
