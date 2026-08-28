import { openAsBlob } from "node:fs";
import { basename } from "node:path";

export interface DoclingConvertResponse {
  document?: {
    md_content?: string;
  };
  status?: string;
  errors?: unknown[];
}

/** Convert a document on the RO mount to markdown via docling-serve (streams file; no persistent copy). */
export async function convertFileToMarkdown(
  filePath: string,
  doclingBaseUrl: string,
): Promise<string> {
  const blob = await openAsBlob(filePath);
  const form = new FormData();
  form.append("files", blob, basename(filePath));
  form.append("to_formats", "md");

  const base = doclingBaseUrl.replace(/\/$/, "");
  const response = await fetch(`${base}/v1/convert/file`, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Docling conversion failed: HTTP ${response.status}`);
  }

  const result = (await response.json()) as DoclingConvertResponse;
  const markdown = result.document?.md_content;
  if (typeof markdown !== "string" || markdown.trim() === "") {
    throw new Error("Docling conversion returned no markdown content");
  }

  return markdown;
}
