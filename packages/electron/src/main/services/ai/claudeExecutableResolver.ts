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
}

export function resolveClaudeExecutablePath(deps: ResolveClaudeExecutableDeps): string {
  const { homedir, pathExists, enhancedPath, pathDelimiter = path.delimiter } = deps;

  // 1. Official ~/.claude/local install — the version `claude update` maintains.
  const localCandidates = [
    path.join(homedir, '.claude', 'local', 'node_modules', '.bin', 'claude'),
    path.join(homedir, '.claude', 'local', 'claude'),
  ];
  for (const candidate of localCandidates) {
    if (pathExists(candidate)) return candidate;
  }

  // 2. First `claude` on the login-shell PATH (what the user's terminal runs).
  if (enhancedPath) {
    const entries = enhancedPath
      .split(pathDelimiter)
      .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean);
    for (const entry of entries) {
      const candidate = path.join(entry, 'claude');
      if (pathExists(candidate)) return candidate;
    }
  }

  // 3. Legacy hardcoded install locations.
  const legacyCandidates = [
    path.join(homedir, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(homedir, '.npm-global', 'bin', 'claude'),
  ];
  for (const candidate of legacyCandidates) {
    if (pathExists(candidate)) return candidate;
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
