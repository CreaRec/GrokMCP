import { readdir, stat } from "node:fs/promises";
import { join, extname, basename, relative } from "node:path";

export interface FileEntry {
  absolutePath: string;
  synoPath: string;
  bytes: bigint;
  mtime: Date;
  kind: "doc" | "photo" | "other";
}

export interface FolderEntry {
  absolutePath: string;
  synoPath: string;
}

export interface WalkResult {
  files: FileEntry[];
  folders: FolderEntry[];
  skipped: number;
}

const ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".tgz",
  ".tbz2",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".mpg",
  ".mpeg",
]);

const PHOTO_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".webp",
  ".tiff",
  ".tif",
  ".heic",
  ".heif",
  ".raw",
  ".cr2",
  ".nef",
  ".arw",
]);

const DOC_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
  ".rtf",
  ".odt",
  ".ods",
  ".odp",
  ".csv",
  ".md",
  ".html",
  ".htm",
]);

const SKIP_FILES = new Set([".DS_Store", "Thumbs.db", ".gitignore", ".gitkeep"]);

function shouldSkip(name: string): boolean {
  if (SKIP_FILES.has(name)) return true;
  if (name.startsWith("._")) return true;

  const ext = extname(name).toLowerCase();
  if (ARCHIVE_EXTENSIONS.has(ext)) return true;
  if (VIDEO_EXTENSIONS.has(ext)) return true;

  return false;
}

function getKind(name: string): "doc" | "photo" | "other" {
  const ext = extname(name).toLowerCase();
  if (PHOTO_EXTENSIONS.has(ext)) return "photo";
  if (DOC_EXTENSIONS.has(ext)) return "doc";
  return "other";
}

export function mountPathToSynoPath(
  absolutePath: string,
  mountRoot: string,
): string {
  const rel = relative(mountRoot, absolutePath);
  const parentDir = basename(mountRoot);
  return `/${parentDir}/${rel}`.replace(/\\/g, "/");
}

export async function walkDirectory(mountRoot: string): Promise<WalkResult> {
  const files: FileEntry[] = [];
  const folders: FolderEntry[] = [];
  let skipped = 0;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`[walker] Error reading directory ${dir}:`, err);
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      const absolutePath = join(dir, name);

      if (entry.isDirectory()) {
        if (name.startsWith(".")) {
          skipped++;
          continue;
        }
        const synoPath = mountPathToSynoPath(absolutePath, mountRoot);
        folders.push({ absolutePath, synoPath });
        await walk(absolutePath);
      } else if (entry.isFile()) {
        if (shouldSkip(name)) {
          skipped++;
          continue;
        }
        try {
          const stats = await stat(absolutePath);
          const synoPath = mountPathToSynoPath(absolutePath, mountRoot);
          files.push({
            absolutePath,
            synoPath,
            bytes: BigInt(stats.size),
            mtime: stats.mtime,
            kind: getKind(name),
          });
        } catch (err) {
          console.error(`[walker] Error stat-ing ${absolutePath}:`, err);
          skipped++;
        }
      }
    }
  }

  await walk(mountRoot);

  return { files, folders, skipped };
}
