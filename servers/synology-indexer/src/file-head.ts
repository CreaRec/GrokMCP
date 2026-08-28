import { open, stat } from "node:fs/promises";
import { logInfo } from "./telemetry.js";
import { DEFAULT_TEXT_HEAD_BYTES } from "./text-limits.js";

export interface TextFileHeadResult {
  text: string;
  totalBytes: number;
  bytesRead: number;
  truncated: boolean;
}

/**
 * Read the first `maxBytes` of a text file without loading the whole file into memory.
 * Safe for multi-GB files (avoids Node readFile 2 GiB limit).
 */
export async function readTextFileHead(
  filePath: string,
  maxBytes: number = DEFAULT_TEXT_HEAD_BYTES,
): Promise<TextFileHeadResult> {
  const { size } = await stat(filePath);
  const toRead = Math.min(size, maxBytes);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf-8");
    const truncated = size > bytesRead;
    if (truncated) {
      logInfo("text file head read truncated", {
        file_path: filePath,
        total_bytes: size,
        bytes_read: bytesRead,
        max_bytes: maxBytes,
      });
    }
    return {
      text,
      totalBytes: size,
      bytesRead,
      truncated,
    };
  } finally {
    await handle.close();
  }
}
