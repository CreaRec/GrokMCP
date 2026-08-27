import { basename } from "node:path";
import { classifyMedia } from "./media.js";
import { encodeRasterForVision, type ImageEncoder } from "./image-encode.js";
import {
  descriptionFromPdfText,
  extractPdfText,
  hasUsablePdfText,
  labelFromPdfText,
  rasterizePdfPages,
  type PdfPageRasterizer,
  type PdfTextExtractor,
  PDF_VISION_MAX_PAGES,
} from "./pdf.js";

export interface VisionResult {
  label: string;
  description: string;
  redacted: boolean;
}

export type FileContentResult =
  | { mode: "skip"; reason: string }
  | { mode: "text"; label: string; description: string; redacted: boolean }
  | { mode: "vision"; label: string; description: string; redacted: boolean };

export interface PrepareFileDeps {
  extractPdfText?: PdfTextExtractor;
  rasterizePdfPages?: PdfPageRasterizer;
  encodeImage?: ImageEncoder;
  /** Injected for tests — when set, vision HTTP is not called; images still prepared. */
  describeImages?: (
    imagesBase64: string[],
    ollamaBaseUrl: string,
    model: string,
    fileName: string,
  ) => Promise<VisionResult>;
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

/**
 * Prepare base64 JPEG frames for Ollama vision.
 * Only raster paths or already-rasterized page buffers — never raw PDF/office bytes.
 */
export async function prepareVisionImageBase64(
  filePath: string,
  encodeImage: ImageEncoder = encodeRasterForVision,
): Promise<string[]> {
  const kind = classifyMedia(filePath);
  if (kind !== "raster") {
    throw new Error(
      `prepareVisionImageBase64 only accepts raster images, got ${kind} for ${basename(filePath)}`,
    );
  }
  return [await encodeImage(filePath)];
}

/**
 * Call Ollama /api/generate with pre-encoded raster image(s) only.
 * Do not pass PDF or other file bytes here.
 */
export async function describeWithVision(
  imagesBase64: string[],
  ollamaBaseUrl: string,
  model: string,
  fileName: string = "image",
): Promise<VisionResult> {
  if (imagesBase64.length === 0) {
    throw new Error("describeWithVision requires at least one image");
  }

  const prompt = `Describe this document or image. Provide:
1. A short label (under 100 characters) suitable for display
2. A detailed description (2-3 sentences) of the content

IMPORTANT: Do NOT include any:
- Passport numbers
- Social Security Numbers (SSN)
- Bank account numbers
- Driver's license numbers

Format your response as:
LABEL: [short label]
DESCRIPTION: [detailed description]`;

  const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      images: imagesBase64,
      stream: false,
    }),
  });

  if (!response.ok) {
    // Do not include Ollama URL (privacy / #33).
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as { response: string };
  const text = result.response;

  const labelMatch = text.match(/LABEL:\s*(.+?)(?:\n|DESCRIPTION:|$)/i);
  const descMatch = text.match(/DESCRIPTION:\s*(.+?)$/is);

  let label = labelMatch?.[1]?.trim() ?? fileName;
  let description = descMatch?.[1]?.trim() ?? text.trim();

  if (label.length > 100) {
    label = label.slice(0, 97) + "...";
  }

  const labelRedact = redactPii(label);
  const descRedact = redactPii(description);

  return {
    label: labelRedact.text,
    description: descRedact.text,
    redacted: labelRedact.wasRedacted || descRedact.wasRedacted,
  };
}

/**
 * Full per-file content pipeline:
 * - skip non-images
 * - raster → vision images (resized)
 * - PDF → digital text + embed path when usable; else page-image vision fallback
 */
export async function describeFileContent(
  filePath: string,
  ollamaBaseUrl: string,
  model: string,
  deps: PrepareFileDeps = {},
): Promise<FileContentResult> {
  const fileName = basename(filePath);
  const kind = classifyMedia(filePath);
  const encodeImage = deps.encodeImage ?? encodeRasterForVision;
  const extractText = deps.extractPdfText ?? extractPdfText;
  const rasterize = deps.rasterizePdfPages ?? rasterizePdfPages;
  const describeImages = deps.describeImages ?? describeWithVision;

  if (kind === "skip") {
    return { mode: "skip", reason: "unsupported_media" };
  }

  if (kind === "pdf") {
    const text = await extractText(filePath);
    if (hasUsablePdfText(text)) {
      const labelRedact = redactPii(labelFromPdfText(text, fileName));
      const descRedact = redactPii(descriptionFromPdfText(text));
      return {
        mode: "text",
        label: labelRedact.text,
        description: descRedact.text,
        redacted: labelRedact.wasRedacted || descRedact.wasRedacted,
      };
    }

    const pageBuffers = await rasterize(filePath, PDF_VISION_MAX_PAGES);
    if (pageBuffers.length === 0) {
      return { mode: "skip", reason: "pdf_empty" };
    }
    const images: string[] = [];
    for (const buf of pageBuffers) {
      images.push(await encodeImage(buf));
    }
    const vision = await describeImages(images, ollamaBaseUrl, model, fileName);
    return { mode: "vision", ...vision };
  }

  // raster
  const images = await prepareVisionImageBase64(filePath, encodeImage);
  const vision = await describeImages(images, ollamaBaseUrl, model, fileName);
  return { mode: "vision", ...vision };
}

export async function checkOllamaAvailable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}
