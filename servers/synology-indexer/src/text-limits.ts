import { logInfo } from "./telemetry.js";

/** Bytes read from plain-text files for qwen gist (default 64 KiB). */
export const DEFAULT_TEXT_HEAD_BYTES = 65_536;

/** Max document excerpt characters sent to qwen (default 32k). */
export const DEFAULT_QWEN_DOCUMENT_CHARS = 32_768;

/** Max DESCRIPTION length stored and sent to mxbai (label capped separately at 100). */
export const DEFAULT_MAX_DESCRIPTION_CHARS = 500;

export interface TextLimits {
  textHeadBytes: number;
  qwenDocumentChars: number;
  maxDescriptionChars: number;
}

export function truncateForQwen(
  text: string,
  maxChars: number,
  context: { fileName: string; source: "docling" | "qwen-text" },
): string {
  if (text.length <= maxChars) {
    return text;
  }
  logInfo("document text truncated for qwen", {
    file_name: context.fileName,
    source: context.source,
    original_chars: text.length,
    max_chars: maxChars,
  });
  return text.slice(0, maxChars);
}

export function capDescription(description: string, maxChars: number): string {
  if (description.length <= maxChars) {
    return description;
  }
  return description.slice(0, maxChars - 3) + "...";
}
