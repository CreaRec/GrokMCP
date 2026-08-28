export type IndexWorkKind = "none" | "gpu_vision" | "cpu_embed" | "cpu_folders";

/** Decide whether to skip, start RunPod for qwen, CPU-embed text files, or rebuild folders only. */
export function planIndexWork(
  qwenFileCount: number,
  textEmbedFileCount: number,
  dirtyFolderCount: number,
): IndexWorkKind {
  if (qwenFileCount === 0 && textEmbedFileCount === 0 && dirtyFolderCount === 0) {
    return "none";
  }
  if (qwenFileCount > 0) {
    return "gpu_vision";
  }
  if (textEmbedFileCount > 0) {
    return "cpu_embed";
  }
  return "cpu_folders";
}
