import { basename } from "node:path";

export interface ChildDescription {
  label: string;
  description: string | null;
  kind: string;
}

export function generateFolderSummary(
  folderPath: string,
  children: ChildDescription[],
): { label: string; description: string } {
  const folderName = basename(folderPath) || folderPath;

  const docCount = children.filter((c) => c.kind === "doc").length;
  const photoCount = children.filter((c) => c.kind === "photo").length;
  const otherCount = children.filter((c) => c.kind === "other").length;

  const parts: string[] = [];
  if (docCount > 0) parts.push(`${docCount} document${docCount > 1 ? "s" : ""}`);
  if (photoCount > 0) parts.push(`${photoCount} photo${photoCount > 1 ? "s" : ""}`);
  if (otherCount > 0) parts.push(`${otherCount} other file${otherCount > 1 ? "s" : ""}`);

  const label = `${folderName} (${parts.join(", ") || "empty"})`;

  const childDescriptions = children
    .filter((c) => c.description)
    .map((c) => `- ${c.label}: ${c.description}`)
    .slice(0, 20);

  let description: string;
  if (childDescriptions.length > 0) {
    description =
      `Folder containing ${parts.join(", ") || "files"}:\n` +
      childDescriptions.join("\n");
  } else {
    description = `Folder "${folderName}" containing ${parts.join(", ") || "no indexed files"}.`;
  }

  return { label, description };
}
