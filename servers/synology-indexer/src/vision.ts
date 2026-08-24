import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface VisionResult {
  label: string;
  description: string;
  redacted: boolean;
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

export async function describeWithVision(
  filePath: string,
  ollamaBaseUrl: string,
  model: string,
): Promise<VisionResult> {
  const fileBuffer = await readFile(filePath);
  const base64 = fileBuffer.toString("base64");
  const fileName = basename(filePath);

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
      images: [base64],
      stream: false,
    }),
  });

  if (!response.ok) {
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

export async function checkOllamaAvailable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}
