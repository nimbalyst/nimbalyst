import { app, type WebContents } from "electron";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import * as path from "path";

export interface HeapSnapshotCaptureResult {
  path: string;
  sizeBytes: number;
}

const activeCaptures = new Set<number>();

function snapshotFilePath(webContentsId: number): string {
  const directory = path.join(app.getPath("userData"), "heap-snapshots");
  mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    directory,
    `renderer-${webContentsId}-${timestamp}.heapsnapshot`
  );
}

/** Capture a V8 heap snapshot from one renderer without opening DevTools. */
export async function captureRendererHeapSnapshot(
  webContents: WebContents
): Promise<HeapSnapshotCaptureResult> {
  if (app.isPackaged)
    throw new Error("Heap snapshots are only available in development builds");
  if (webContents.isDestroyed())
    throw new Error("Cannot capture a destroyed renderer");
  if (activeCaptures.has(webContents.id)) {
    throw new Error(
      `A heap snapshot is already being captured for renderer ${webContents.id}`
    );
  }
  if (webContents.debugger.isAttached()) {
    throw new Error(
      "Cannot capture heap snapshot while another debugger is attached to the renderer"
    );
  }

  activeCaptures.add(webContents.id);
  const outputPath = snapshotFilePath(webContents.id);
  const fileDescriptor = openSync(outputPath, "wx");
  let writeError: Error | null = null;
  let attached = false;

  const onDebuggerMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>
  ): void => {
    if (method !== "HeapProfiler.addHeapSnapshotChunk" || writeError) return;
    const chunk = params.chunk;
    if (typeof chunk !== "string") return;
    try {
      // Synchronous writes deliberately bound main-process memory. A 1GB+
      // snapshot must not become a second 1GB queue of pending write buffers.
      writeSync(fileDescriptor, chunk, null, "utf8");
    } catch (error) {
      writeError = error instanceof Error ? error : new Error(String(error));
    }
  };

  try {
    webContents.debugger.attach("1.3");
    attached = true;
    webContents.debugger.on("message", onDebuggerMessage);
    await webContents.debugger.sendCommand("HeapProfiler.enable");
    await webContents.debugger.sendCommand("HeapProfiler.takeHeapSnapshot", {
      reportProgress: false,
    });
    if (writeError) throw writeError;
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    const sizeBytes = statSync(outputPath).size;
    return { path: outputPath, sizeBytes };
  } catch (error) {
    try {
      closeSync(fileDescriptor);
    } catch {
      // The success path may already have closed it.
    }
    try {
      unlinkSync(outputPath);
    } catch {
      // Ignore cleanup failures and preserve the original capture error.
    }
    throw error;
  } finally {
    webContents.debugger.removeListener("message", onDebuggerMessage);
    if (
      attached &&
      !webContents.isDestroyed() &&
      webContents.debugger.isAttached()
    ) {
      try {
        await webContents.debugger.sendCommand("HeapProfiler.disable");
      } catch {
        // The renderer may have closed or detached during capture.
      }
      try {
        webContents.debugger.detach();
      } catch {
        // The renderer may have closed or detached during capture.
      }
    }
    activeCaptures.delete(webContents.id);
  }
}
