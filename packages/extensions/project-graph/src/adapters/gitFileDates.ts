import type { PanelHost } from '@nimbalyst/extension-sdk';

/**
 * Returns a map of "file path → first-add epoch ms" by walking the git history
 * for `--diff-filter=A` commits. Used by docAdapter and planAdapter to seed
 * `createdAt` for markdown files without re-running git log per file.
 *
 * One call per snapshot load is memoized via a per-workspace promise cache so
 * docAdapter, planAdapter, and any future adapter that wants birth dates share
 * the cost. The cache is intentionally short-lived: we drop it once the
 * promise settles so a subsequent refresh runs fresh git.
 *
 * For files that git doesn't know about (gitignored, untracked, brand new),
 * `getFileDates` falls back to filesystem mtime via `stat`. That's the right
 * answer for `nimbalyst-local/plans/*.md` which are intentionally outside git.
 */

const inflight = new Map<string, Promise<Map<string, number>>>();

const MAX_COMMITS = 5000;

export async function getGitFileAddDates(host: PanelHost): Promise<Map<string, number>> {
  const key = host.workspacePath;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = computeDates(host).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

async function computeDates(host: PanelHost): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const check = await host.exec('git rev-parse --is-inside-work-tree 2>/dev/null || true', { timeout: 5000 });
    if (!/true/.test(check.stdout)) return map;

    // --diff-filter=A → only "added" file events. --reverse → oldest first, so
    // the first time we see a path is its birth. Format marker uses unit-sep so
    // we can distinguish commit headers from filenames.
    const log = await host.exec(
      `git log --diff-filter=A --reverse --name-only --no-merges --format='__COMMIT__%aI' --max-count=${MAX_COMMITS}`,
      { timeout: 30000, maxBuffer: 50 * 1024 * 1024 },
    );
    if (!log.success) return map;

    let currentTs: number | null = null;
    for (const lineRaw of log.stdout.split('\n')) {
      const line = lineRaw.trim();
      if (!line) continue;
      if (line.startsWith('__COMMIT__')) {
        const iso = line.slice('__COMMIT__'.length);
        const ms = Date.parse(iso);
        currentTs = Number.isFinite(ms) ? ms : null;
        continue;
      }
      if (currentTs == null) continue;
      // Keep the *first* add date for each path — git --reverse iterates oldest
      // commit first, so the first time we see a path is the right one. If a
      // file was deleted and re-added, this still captures the original birth.
      if (!map.has(line)) map.set(line, currentTs);
    }
  } catch {
    // Best effort — return whatever we collected.
  }
  return map;
}

/**
 * Returns a per-path createdAt map for the given paths. Tries the git-add
 * lookup first; for any path git doesn't know (gitignored, untracked), falls
 * back to filesystem mtime via batched `stat` calls. Returns a fresh Map so
 * callers can mutate without polluting the shared git cache.
 */
export async function getFileDates(host: PanelHost, paths: ReadonlyArray<string>): Promise<Map<string, number>> {
  const git = await getGitFileAddDates(host);
  const out = new Map(git);
  const missing: string[] = [];
  for (const p of paths) {
    if (!out.has(p)) missing.push(p);
  }
  if (missing.length === 0) return out;

  // Batch stat: pass paths directly as args (avoids stdin/xargs entirely so
  // host.exec doesn't need to wire stdin). macOS uses `-f`, GNU/Linux uses
  // `-c`; whichever matches the platform runs and the other fails silently.
  // macOS `stat -f` does NOT process `\t` inside single-quoted format strings,
  // so we use a multi-char sentinel between path and timestamp.
  const SEP = '<:NIMBALYST:>';
  const CHUNK = 400;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const slice = missing.slice(i, i + CHUNK);
    const args = slice.map(p => `'${p.replace(/'/g, "'\\''")}'`).join(' ');
    const cmd = `stat -f '%N${SEP}%m' ${args} 2>/dev/null || stat -c '%n${SEP}%Y' ${args} 2>/dev/null`;
    try {
      const res = await host.exec(cmd, { timeout: 10000 });
      if (!res.success) continue;
      for (const line of res.stdout.split('\n')) {
        const idx = line.indexOf(SEP);
        if (idx < 0) continue;
        const path = line.slice(0, idx);
        const sec = line.slice(idx + SEP.length).trim();
        if (!path || !sec) continue;
        const ms = Number(sec) * 1000;
        if (Number.isFinite(ms) && ms > 0) out.set(path, ms);
      }
    } catch {
      // Skip this chunk; partial fallback still better than none.
    }
  }
  return out;
}
