/**
 * Stop the dev server's file watcher from leaking a listener on every add().
 *
 * Vite calls `watcher.add(file)` for every file it loads from outside the
 * renderer root and for every PostCSS dependency. Tailwind reports each file
 * matched by its `content` globs (~1,700 under runtime/ and collab-client/), so
 * every edit that re-transforms index.css re-adds all of them. On macOS the
 * watcher's fsevents backend does not dedupe: each add() of an already-watched
 * path registers one more listener on the shared fsevents stream, and every
 * filesystem event then runs all of them. A renderer server kept alive across
 * dev-loop restarts accumulated enough of them over a few days to spend all of
 * its time in one fsevents callback, so reload and HMR requests never got an
 * answer.
 *
 * Only the first add() of a path reaches the watcher. A path the watcher drops
 * (because the file was deleted, or by unwatch()) is forgotten so a later add()
 * watches it again.
 */
export function dedupeWatcherAdds(watcher) {
  const added = new Set();
  const forget = (paths) => {
    for (const p of [paths].flat()) added.delete(p);
  };
  const forgetDir = (dir) => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    for (const p of added) {
      if (p === dir || p.startsWith(prefix)) added.delete(p);
    }
  };

  const add = watcher.add.bind(watcher);
  watcher.add = (paths, ...rest) => {
    // `!pattern` entries change the ignore list; always pass them through.
    const fresh = [paths].flat().filter((p) => p.startsWith('!') || !added.has(p));
    for (const p of fresh) {
      if (!p.startsWith('!')) added.add(p);
    }
    if (fresh.length > 0) add(fresh, ...rest);
    return watcher;
  };

  const unwatch = watcher.unwatch.bind(watcher);
  watcher.unwatch = (paths) => {
    forget(paths);
    return unwatch(paths);
  };

  watcher.on('unlink', forget);
  watcher.on('unlinkDir', forgetDir);
  return watcher;
}

export default function dedupeWatcherAddsPlugin() {
  return {
    name: 'nimbalyst-dedupe-watcher-adds',
    apply: 'serve',
    configureServer(server) {
      dedupeWatcherAdds(server.watcher);
    },
  };
}
