import * as fs from "fs";
import * as path from "path";
import { NativeFileEventQueue } from "./NativeFileEventQueue";
import chokidar, { type FSWatcher } from "chokidar";

export const supportsRecursiveWatch =
  process.platform === "darwin" || process.platform === "win32";
export type NativeWatchHandle = fs.FSWatcher | FSWatcher;

const queues = new WeakMap<NativeWatchHandle, NativeFileEventQueue>();
export function drainNativeFileEvents(handle: NativeWatchHandle): Promise<void> {
  return queues.get(handle)?.drain() ?? Promise.resolve();
}

/**
 * Native failures and a bounded processing backlog remain recoverable.
 * `ready` fires once the handle covers the tree: after chokidar's initial scan
 * on Linux, and immediately for recursive fs.watch, which has no scan.
 */
export function createWorkspaceNativeWatcher(
  root: string,
  current: () => boolean,
  fail: (reason: string) => void,
  ignored: (filePath: string) => boolean,
  deliver: (
    type: "change" | "rename" | "add" | "unlink",
    filePath: string,
    observedAt?: number
  ) => void,
  ready: () => void
): NativeWatchHandle {
  const queue = new NativeFileEventQueue(current, deliver, fail);
  const dispatch = queue.push.bind(queue);
  const watcher = supportsRecursiveWatch
    ? fs.watch(root, { recursive: true }, (type, filename) => {
        if (filename) dispatch(type, path.join(root, filename));
      })
    : chokidar
        .watch(root, {
          ignored,
          ignoreInitial: true,
          followSymlinks: false,
          usePolling: false,
          atomic: true,
          awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
          // Bound initial inotify setup; explicit expanded/bypassed paths are added by the bus.
          alwaysStat: false,
          depth: 10,
        })
        .on("change", (file) => dispatch("change", file))
        .on("add", (file) => dispatch("add", file))
        .on("unlink", (file) => dispatch("unlink", file))
        .on("ready", ready);
  queues.set(watcher, queue);
  watcher.on("error", (error: unknown) => {
    if (current())
      fail((error as NodeJS.ErrnoException)?.code ?? "watcher_error");
  });
  if (supportsRecursiveWatch)
    (watcher as fs.FSWatcher).on("close", () => {
      queue.stop();
      if (current()) fail("unexpected_close");
    });
  if (supportsRecursiveWatch) ready();
  return watcher;
}

/**
 * Adds an expanded folder or bypassed file to a Linux chokidar handle.
 * chokidar 4 counts a path it cannot stat twice toward `ready` (its stat error
 * handler and `add()` both report it), so adding one while the initial scan
 * runs fires `ready` before the tree is covered. During a scan such a path gets
 * the call chokidar itself falls back to, which counts once: watch the nearest
 * existing ancestor for the path's name.
 */
export function addNativeWatchPath(
  handle: NativeWatchHandle,
  filePath: string,
  scanning: boolean
): void {
  if (!("add" in handle)) return;
  if (!scanning || canStat(filePath)) {
    handle.add(filePath);
    return;
  }
  let dir = path.dirname(filePath);
  while (!canStat(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  handle.add(dir, path.basename(filePath));
}

function canStat(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}
