export type IndexWorkKind = "none" | "gpu_vision" | "cpu_folders";

/**
 * Decide whether to skip, start RunPod for vision, or rebuild on CPU.
 * Text-PDF embeds (no VLM) count toward CPU work when there is no vision queue.
 */
export function planIndexWork(
  visionFileCount: number,
  dirtyFolderCount: number,
  textFileCount: number = 0,
): IndexWorkKind {
  if (visionFileCount === 0 && dirtyFolderCount === 0 && textFileCount === 0) {
    return "none";
  }
  if (visionFileCount > 0) {
    return "gpu_vision";
  }
  return "cpu_folders";
}
