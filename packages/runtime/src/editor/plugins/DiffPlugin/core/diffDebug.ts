/**
 * Whether `DIFF_DEBUG=1` was set when the diff engine loaded. Read through
 * `globalThis` because the engine also runs where there is no `process` at
 * all (the collab worker's `@nimbalyst/markdown-ydoc` bundle), and optional
 * chaining does not guard an undeclared identifier. Read once: the checks sit
 * in the tree matcher's inner loops.
 */
const DIFF_DEBUG =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.DIFF_DEBUG === '1';

export function isDiffDebug(): boolean {
  return DIFF_DEBUG;
}
