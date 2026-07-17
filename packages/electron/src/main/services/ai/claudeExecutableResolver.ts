/**
 * Resolve the `claude` executable to run for a `claude-code-cli` session
 * (NIM-806, Phase 1).
 *
 * We must run the SAME `claude` the user runs in their terminal — not a stale
 * global. The official native/local installer (and `claude update`) keeps the
 * current version under `~/.claude/local`, which the user's login shell resolves
 * first. A bug shipped where the resolver's hardcoded candidate list omitted
 * `~/.claude/local` and fell through to `/opt/homebrew/bin/claude` (an old
 * v1.0.x npm global), so the CLI ran years out of date.
 *
 * Resolution order:
 *   1. `~/.claude/local/...` — the official auto-updating install (current).
 *   2. First `claude` on the login-shell PATH — mirrors typing `claude`.
 *   3. Legacy hardcoded install locations (homebrew, npm-global, ~/.local/bin).
 *   4. The bare command `claude` (node-pty resolves it via the spawned PATH).
 *
 * Pure (deps injected) so it unit-tests without touching the real filesystem.
 */

import path from 'path';

export interface ResolveClaudeExecutableDeps {
  /** User home directory (os.homedir()). */
  homedir: string;
  /** Existence predicate (fs.existsSync). */
  pathExists: (p: string) => boolean;
  /** Login-shell-enhanced PATH (CLIManager.getEnhancedPath()). */
  enhancedPath?: string;
  /** PATH delimiter (path.delimiter); injectable for cross-platform tests. */
  pathDelimiter?: string;
  /** Platform (process.platform); injectable for cross-platform tests. */
  platform?: NodeJS.Platform;
}

export function resolveClaudeExecutablePath(deps: ResolveClaudeExecutableDeps): string {
  const { homedir, pathExists, enhancedPath, pathDelimiter = path.delimiter, platform = process.platform } = deps;

  // On Windows the launchable `claude` is `claude.exe` / `claude.cmd`, not the
  // extensionless Unix sh-shim that npm drops alongside them. node-pty cannot
  // CreateProcess the sh-shim (it is not a PE binary) and fails with error 193
  // (ERROR_BAD_EXE_FORMAT), so each candidate must resolve the real Windows
  // executable. Prefer `.exe`, then `.cmd`, then extensionless. (#684)
  const extensions = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const firstExisting = (base: string): string | undefined => {
    for (const ext of extensions) {
      const candidate = base + ext;
      if (pathExists(candidate)) return candidate;
    }
    return undefined;
  };

  // 1. Official ~/.claude/local install — the version `claude update` maintains.
  const localBases = [
    path.join(homedir, '.claude', 'local', 'node_modules', '.bin', 'claude'),
    path.join(homedir, '.claude', 'local', 'claude'),
  ];
  for (const base of localBases) {
    const hit = firstExisting(base);
    if (hit) return hit;
  }

  // 2. First `claude` on the login-shell PATH (what the user's terminal runs).
  if (enhancedPath) {
    const entries = enhancedPath
      .split(pathDelimiter)
      .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean);
    for (const entry of entries) {
      const hit = firstExisting(path.join(entry, 'claude'));
      if (hit) return hit;
    }
  }

  // 3. Legacy hardcoded install locations (incl. the Windows npm-global dir).
  const legacyBases = [
    path.join(homedir, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(homedir, '.npm-global', 'bin', 'claude'),
    path.join(homedir, 'AppData', 'Roaming', 'npm', 'claude'),
  ];
  for (const base of legacyBases) {
    const hit = firstExisting(base);
    if (hit) return hit;
  }

  // 4. Bare command — node-pty resolves it against the spawned (enhanced) PATH.
  return 'claude';
}

/**
 * Whether a `claude` executable is actually installed somewhere we could spawn
 * (NIM-852). Reuses the resolver so it matches exactly what node-pty would run:
 * the resolver scans the SAME enhanced PATH node-pty spawns with, so a bare
 * `'claude'` fallback means nothing was found on disk OR PATH → not installed.
 * Pure (deps injected) for unit testing without touching the filesystem.
 */
export function isClaudeExecutableInstalled(deps: ResolveClaudeExecutableDeps): boolean {
  return resolveClaudeExecutablePath(deps) !== 'claude';
}
