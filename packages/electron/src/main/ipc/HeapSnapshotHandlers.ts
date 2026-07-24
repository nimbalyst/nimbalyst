import { safeHandle } from "../utils/ipcRegistry";
import { captureRendererHeapSnapshot } from "../services/HeapSnapshotService";

export function registerHeapSnapshotHandlers(): void {
  safeHandle("heap-snapshot:capture", async (event) => {
    return captureRendererHeapSnapshot(event.sender);
  });
}
