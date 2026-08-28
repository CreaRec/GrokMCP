/** How a dirty file is indexed before embedding (one vector per file). */
export type FileIndexRoute = "docling" | "qwen-text" | "qwen-image" | "heic" | "skip";

const DOCLING_EXTENSIONS = new Set([
  "pdf",
  "xlsx",
  "docx",
  "epub",
  "pptx",
  "html",
  "csv",
]);

const QWEN_TEXT_EXTENSIONS = new Set([
  "txt",
  "sql",
  "js",
  "json",
  "md",
  "xml",
  "conf",
  "css",
  "properties",
  "sh",
]);

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png"]);

const SKIP_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "svg",
  "ico",
  "psd",
  "otf",
  "pem",
  "crt",
  "key",
  "p12",
  "ovpn",
  "kdb",
  "bson",
  "bak",
  "backup",
  "iml",
  "default",
  "webmanifest",
]);

/** Basename extension in lowercase, or null when there is no extension. */
export function getFileExtension(fileBasename: string): string | null {
  const dot = fileBasename.lastIndexOf(".");
  if (dot <= 0 || dot === fileBasename.length - 1) {
    return null;
  }
  return fileBasename.slice(dot + 1).toLowerCase();
}

/** Classify a file by extension for indexer routing (production mix validated in tests). */
export function classifyFileRoute(fileBasename: string): FileIndexRoute {
  const ext = getFileExtension(fileBasename);

  if (ext === "heic") {
    return "heic";
  }
  if (ext !== null && DOCLING_EXTENSIONS.has(ext)) {
    return "docling";
  }
  if (ext !== null && IMAGE_EXTENSIONS.has(ext)) {
    return "qwen-image";
  }
  if (ext !== null && QWEN_TEXT_EXTENSIONS.has(ext)) {
    return "qwen-text";
  }
  if (ext === null || SKIP_EXTENSIONS.has(ext)) {
    return "skip";
  }

  // Unknown binary-ish types: skip rather than base64 to qwen.
  return "skip";
}

/** True when the route needs a GPU qwen session. */
export function routeNeedsQwen(route: FileIndexRoute): boolean {
  return (
    route === "docling" ||
    route === "qwen-text" ||
    route === "qwen-image" ||
    route === "heic"
  );
}

/** OTEL-friendly route label for logs. */
export function routeLogLabel(route: FileIndexRoute): string {
  switch (route) {
    case "docling":
      return "docling";
    case "qwen-text":
      return "qwen-text";
    case "qwen-image":
      return "qwen-image";
    case "heic":
      return "qwen-image";
    case "skip":
      return "skip";
  }
}
