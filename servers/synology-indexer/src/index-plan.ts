export type IndexWorkKind = "none" | "gpu_vision" | "cpu_folders";

/** Decide whether to skip, start RunPod for qwen, or rebuild folders on CPU only. */
export function planIndexWork(
  qwenFileCount: number,
  dirtyFolderCount: number,
): IndexWorkKind {
  if (qwenFileCount === 0 && dirtyFolderCount === 0) {
    return "none";
  }
  if (qwenFileCount > 0) {
    return "gpu_vision";
  }
  return "cpu_folders";
}
