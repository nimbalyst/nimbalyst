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

/** Native failures and a bounded processing backlog remain recoverable. */
export function createWorkspaceNativeWatcher(
  root: string,
  current: () => boolean,
  fail: (reason: string) => void,
  ignored: (filePath: string) => boolean,
  deliver: (
    type: "change" | "rename" | "add" | "unlink",
    filePath: string,
    observedAt?: number
  ) => void
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
        .on("unlink", (file) => dispatch("unlink", file));
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
  return watcher;
}
