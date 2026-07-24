/**
 * Dev-only stale-bundle detection for built-in extensions.
 *
 * `npm run dev` does NOT rebuild extensions -- it serves each extension's
 * last-built `dist` entry. If a developer edits an extension's `src` (or pulls
 * changes) without rebuilding, the running app loads a stale bundle whose
 * behaviour (e.g. a missing `registerContentAdapter` call) no longer matches
 * the source. This silently breaks features like collaborative editing. See
 * NIM-1983.
 *
 * This helper compares the built entry's mtime against the newest source file
 * and reports a warning when the source is newer. It is a diagnostic only --
 * it never blocks loading.
 */
import * as fs from 'fs/promises';
import * as path from 'path';

export interface StaleBundleReport {
  extensionId: string;
  /** Absolute path to the built entry (manifest.main). */
  entryPath: string;
  /** mtime (ms) of the built entry. */
  builtMs: number;
  /** Newest source-file mtime (ms) found under src/. */
  newestSrcMs: number;
  /** Relative path of the newest source file, for the warning message. */
  newestSrcRel: string;
}

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'out', '__tests__']);

/**
 * Walk `dir` recursively and return the newest file mtime (ms) plus its path.
 * Skips build output and dependency directories. Returns null when the tree
 * has no readable files.
 */
async function newestFileMtime(
  dir: string,
): Promise<{ mtimeMs: number; filePath: string } | null> {
  let best: { mtimeMs: number; filePath: string } | null = null;

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const nested = await newestFileMtime(full);
      if (nested && (!best || nested.mtimeMs > best.mtimeMs)) best = nested;
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.stat(full);
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { mtimeMs: stat.mtimeMs, filePath: full };
      }
    } catch {
      // Unreadable file -- ignore.
    }
  }

  return best;
}

/**
 * Detect whether a built-in extension's built entry is older than its source.
 *
 * Returns a report when the newest file under `<extensionPath>/src` is newer
 * than the built entry (`manifestMain`, relative to the extension root), or
 * when the built entry is missing entirely. Returns null when the bundle is
 * fresh, when there is no `src` directory, or when paths can't be read.
 */
export async function detectStaleBuiltinExtensionBundle(
  extensionId: string,
  extensionPath: string,
  manifestMain: string | undefined,
): Promise<StaleBundleReport | null> {
  const srcDir = path.join(extensionPath, 'src');
  const newestSrc = await newestFileMtime(srcDir);
  if (!newestSrc) return null; // No source tree (e.g. prebuilt marketplace ext).

  const entryRel = manifestMain ?? 'dist/index.js';
  const entryPath = path.join(extensionPath, entryRel);

  let builtMs: number;
  try {
    builtMs = (await fs.stat(entryPath)).mtimeMs;
  } catch {
    // Built entry missing entirely -- definitely stale.
    return {
      extensionId,
      entryPath,
      builtMs: 0,
      newestSrcMs: newestSrc.mtimeMs,
      newestSrcRel: path.relative(extensionPath, newestSrc.filePath),
    };
  }

  if (newestSrc.mtimeMs <= builtMs) return null;

  return {
    extensionId,
    entryPath,
    builtMs,
    newestSrcMs: newestSrc.mtimeMs,
    newestSrcRel: path.relative(extensionPath, newestSrc.filePath),
  };
}

/** Human-readable one-line warning for a stale bundle. */
export function formatStaleBundleWarning(report: StaleBundleReport): string {
  const detail =
    report.builtMs === 0
      ? 'its built entry is missing'
      : `${report.newestSrcRel} is newer than the built bundle`;
  return (
    `[ExtensionHandlers] Built-in extension "${report.extensionId}" has a stale dev bundle ` +
    `(${detail}). Run "npm run build:extensions" (or the extension's build) so dev serves ` +
    `current code -- collaborative editing and other activate()-time features may be broken otherwise.`
  );
}
