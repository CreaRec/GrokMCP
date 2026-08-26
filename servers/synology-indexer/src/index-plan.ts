export type IndexWorkKind = "none" | "gpu_vision" | "cpu_folders";

/** Decide whether to skip, start RunPod for vision, or rebuild folders on CPU only. */
export function planIndexWork(
  visionFileCount: number,
  dirtyFolderCount: number,
): IndexWorkKind {
  if (visionFileCount === 0 && dirtyFolderCount === 0) {
    return "none";
  }
  if (visionFileCount > 0) {
    return "gpu_vision";
  }
  return "cpu_folders";
}
