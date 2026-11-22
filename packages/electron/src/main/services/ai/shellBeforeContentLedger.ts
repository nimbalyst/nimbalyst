import path from 'node:path';

/**
 * Pre-change content observed by a shell-window session's own watcher, kept
 * briefly so a hook-window link can be tagged with the file's content from
 * before the command's first write.
 *
 * The checkout baseline supplies exact content only for files that were clean
 * at window start. For a file that was already dirty, the session's snapshot
 * cache is the only source: its watcher reports the content it held just
 * before each change. That content is not trustworthy on its own (for a dirty
 * file the cache never seeded it falls back to the committed blob), so in a
 * Git checkout it is accepted only when it matches the fingerprint captured
 * at window start (`ShellCheckoutBaseline.baselineContent`). Outside Git there
 * is no fingerprint; the first change at or after the window start is used.
 */
const RETAIN_MS = 120_000;
const MAX_ENTRIES_PER_FILE = 16;
const MAX_FILES_PER_SESSION = 512;
const MAX_CONTENT_BYTES = 1_000_000;

interface Entry { at: number; before: string }

export class ShellBeforeContentLedger {
  private readonly sessions = new Map<string, Map<string, Entry[]>>();
  constructor(private readonly now: () => number = Date.now) {}

  record(sessionId: string, filePath: string, before: string | null | undefined, at: number): void {
    if (typeof before !== 'string' || before.length > MAX_CONTENT_BYTES) return;
    let files = this.sessions.get(sessionId);
    if (!files) this.sessions.set(sessionId, files = new Map());
    const file = path.resolve(filePath);
    let entries = files.get(file);
    if (!entries) {
      this.prune(files);
      if (files.size >= MAX_FILES_PER_SESSION) files.delete(files.keys().next().value!);
      files.set(file, entries = []);
    }
    entries.push({ at, before });
    if (entries.length > MAX_ENTRIES_PER_FILE) entries.shift();
  }

  /** Every retained before-content for the file, oldest first, to be matched against a fingerprint. */
  observed(sessionId: string, filePath: string): string[] {
    return (this.sessions.get(sessionId)?.get(path.resolve(filePath)) ?? []).map((entry) => entry.before);
  }

  /** Content before the first change observed at or after `windowStart`. Unverified; for non-Git workspaces only. */
  beforeWindow(sessionId: string, filePath: string, windowStart: number): string | undefined {
    const entries = this.sessions.get(sessionId)?.get(path.resolve(filePath));
    return entries?.find((entry) => entry.at >= windowStart)?.before;
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private prune(files: Map<string, Entry[]>): void {
    const cutoff = this.now() - RETAIN_MS;
    for (const [file, entries] of files) {
      const kept = entries.filter((entry) => entry.at >= cutoff);
      if (kept.length === 0) files.delete(file);
      else if (kept.length !== entries.length) files.set(file, kept);
    }
  }
}

export const shellBeforeContentLedger = new ShellBeforeContentLedger();
