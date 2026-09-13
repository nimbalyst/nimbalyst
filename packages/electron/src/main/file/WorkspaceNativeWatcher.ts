import * as fs from "fs";
import * as path from "path";
import chokidar, { type FSWatcher } from "chokidar";

export const supportsRecursiveWatch =
  process.platform === "darwin" || process.platform === "win32";
export type NativeWatchHandle = fs.FSWatcher | FSWatcher;

/** Raw pressure is counted before ignores, which cannot protect the native callback queue. */
export function createWorkspaceNativeWatcher(
  root: string,
  current: () => boolean,
  fail: (reason: string) => void,
  ignored: (filePath: string) => boolean,
  deliver: (
    type: "change" | "rename" | "add" | "unlink",
    filePath: string
  ) => void
): NativeWatchHandle {
  const timestamps = new Array<number>(5000).fill(0);
  let index = 0;
  const dispatch = (
    type: "change" | "rename" | "add" | "unlink",
    filePath: string
  ) => {
    if (!current()) return;
    const now = Date.now();
    const oldest = timestamps[index];
    timestamps[index] = now;
    index = (index + 1) % timestamps.length;
    if (oldest > 0 && now - oldest < 5000) {
      fail("event_storm");
      return;
    }
    deliver(type, filePath);
  };
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
  watcher.on("error", (error: unknown) => {
    if (current())
      fail((error as NodeJS.ErrnoException)?.code ?? "watcher_error");
  });
  if (supportsRecursiveWatch)
    (watcher as fs.FSWatcher).on("close", () => {
      if (current()) fail("unexpected_close");
    });
  return watcher;
}
