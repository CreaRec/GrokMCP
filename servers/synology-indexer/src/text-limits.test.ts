import { describe, it, expect, vi } from "vitest";
import { truncateForQwen, capDescription } from "./text-limits.js";

vi.mock("./telemetry.js", () => ({
  logInfo: vi.fn(),
}));

import { logInfo } from "./telemetry.js";

describe("truncateForQwen", () => {
  it("passes through text under the limit", () => {
    expect(truncateForQwen("hello", 10, { fileName: "a.txt", source: "qwen-text" })).toBe(
      "hello",
    );
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("truncates and logs character counts without content", () => {
    const long = "x".repeat(100);
    const result = truncateForQwen(long, 50, { fileName: "big.md", source: "docling" });

    expect(result).toHaveLength(50);
    expect(logInfo).toHaveBeenCalledWith("document text truncated for qwen", {
      file_name: "big.md",
      source: "docling",
      original_chars: 100,
      max_chars: 50,
    });
    const logPayload = JSON.stringify(vi.mocked(logInfo).mock.calls[0]);
    expect(logPayload).not.toContain("xxxx");
  });
});

describe("capDescription", () => {
  it("caps description length with ellipsis", () => {
    const long = "a".repeat(600);
    expect(capDescription(long, 500)).toHaveLength(500);
    expect(capDescription(long, 500).endsWith("...")).toBe(true);
  });
});
