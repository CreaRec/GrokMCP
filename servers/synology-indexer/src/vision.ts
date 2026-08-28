import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  capDescription,
  truncateForQwen,
  DEFAULT_MAX_DESCRIPTION_CHARS,
  DEFAULT_QWEN_DOCUMENT_CHARS,
  type TextLimits,
} from "./text-limits.js";

export interface VisionResult {
  label: string;
  description: string;
  redacted: boolean;
}

export interface DescribeDocumentOptions {
  /** Max excerpt characters in the qwen prompt (default 32k). */
  qwenDocumentChars?: number;
  /** Max DESCRIPTION length after parsing (default 500). */
  maxDescriptionChars?: number;
  /** Source route for truncation logs. */
  source?: "docling" | "qwen-text";
}

const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b\d{9}\b/g,
  /passport\s*(?:no|number|#)?\s*[:.]?\s*\w{6,12}/gi,
  /\bSSN\s*[:.]?\s*\d{3}[-\s]?\d{2}[-\s]?\d{4}/gi,
  /(?:bank|account)\s*(?:no|number|#)?\s*[:.]?\s*\d{8,17}/gi,
  /(?:driver'?s?\s*licen[sc]e|DL)\s*(?:no|number|#)?\s*[:.]?\s*\w{5,15}/gi,
  /\b(?:routing|aba)\s*(?:no|number|#)?\s*[:.]?\s*\d{9}\b/gi,
];

function redactPii(text: string): { text: string; wasRedacted: boolean } {
  let wasRedacted = false;
  let redacted = text;

  for (const pattern of PII_PATTERNS) {
    const newText = redacted.replace(pattern, "[REDACTED]");
    if (newText !== redacted) {
      wasRedacted = true;
      redacted = newText;
    }
  }

  return { text: redacted, wasRedacted };
}

function parseVisionResponse(
  text: string,
  fileName: string,
  maxDescriptionChars: number,
): VisionResult {
  const labelMatch = text.match(/LABEL:\s*(.+?)(?:\n|DESCRIPTION:|$)/i);
  const descMatch = text.match(/DESCRIPTION:\s*(.+?)$/is);

  let label = labelMatch?.[1]?.trim() ?? fileName;
  let description = descMatch?.[1]?.trim() ?? text.trim();

  if (label.length > 100) {
    label = label.slice(0, 97) + "...";
  }

  description = capDescription(description, maxDescriptionChars);

  const labelRedact = redactPii(label);
  const descRedact = redactPii(description);

  return {
    label: labelRedact.text,
    description: descRedact.text,
    redacted: labelRedact.wasRedacted || descRedact.wasRedacted,
  };
}

const PII_EXCLUSION = `IMPORTANT: Do NOT include any:
- Passport numbers
- Social Security Numbers (SSN)
- Bank account numbers
- Driver's license numbers`;

const RESPONSE_FORMAT = `Format your response as:
LABEL: [short label]
DESCRIPTION: [brief description]`;

const GIST_DOCUMENT_INTRO = `You are describing a document based on a GIST — only the beginning of the file was extracted, not the full document. Do not invent or assume content beyond what is shown in the excerpt below.

Provide:
1. A short label (under 100 characters) suitable for display
2. A brief description (2-3 sentences) summarizing what you can infer from this excerpt only`;

async function callOllamaGenerate(
  ollamaBaseUrl: string,
  model: string,
  prompt: string,
  images?: string[],
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    prompt,
    stream: false,
  };
  if (images !== undefined) {
    body.images = images;
  }

  const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Vision model request failed: HTTP ${response.status}`);
  }

  const result = (await response.json()) as { response: string };
  return result.response;
}

/** Describe a raster image via qwen vision (images[] path). */
export async function describeWithVisionImage(
  filePath: string,
  ollamaBaseUrl: string,
  model: string,
): Promise<VisionResult> {
  const fileBuffer = await readFile(filePath);
  const base64 = fileBuffer.toString("base64");
  const fileName = basename(filePath);

  const prompt = `Describe this image. Provide:
1. A short label (under 100 characters) suitable for display
2. A detailed description (2-3 sentences) of the content

${PII_EXCLUSION}

${RESPONSE_FORMAT}`;

  const text = await callOllamaGenerate(ollamaBaseUrl, model, prompt, [base64]);
  return parseVisionResponse(text, fileName, DEFAULT_MAX_DESCRIPTION_CHARS);
}

/** Summarize Docling markdown or plain-text gist via qwen (never images[]). */
export async function describeFromDocumentText(
  documentMarkdown: string,
  fileName: string,
  ollamaBaseUrl: string,
  model: string,
  options: DescribeDocumentOptions = {},
): Promise<VisionResult> {
  const qwenDocumentChars = options.qwenDocumentChars ?? DEFAULT_QWEN_DOCUMENT_CHARS;
  const maxDescriptionChars = options.maxDescriptionChars ?? DEFAULT_MAX_DESCRIPTION_CHARS;
  const source = options.source ?? "docling";

  const excerpt = truncateForQwen(documentMarkdown, qwenDocumentChars, {
    fileName,
    source,
  });

  const prompt = `${GIST_DOCUMENT_INTRO}

${PII_EXCLUSION}

${RESPONSE_FORMAT}

--- DOCUMENT EXCERPT (beginning only) ---
${excerpt}`;

  const text = await callOllamaGenerate(ollamaBaseUrl, model, prompt);
  return parseVisionResponse(text, fileName, maxDescriptionChars);
}

/** Build describe options from indexer config limits. */
export function describeLimitsFromConfig(limits: TextLimits): DescribeDocumentOptions {
  return {
    qwenDocumentChars: limits.qwenDocumentChars,
    maxDescriptionChars: limits.maxDescriptionChars,
  };
}

/** @deprecated Use describeWithVisionImage — kept for test imports during migration. */
export const describeWithVision = describeWithVisionImage;

export async function checkOllamaAvailable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}
