/**
 * Version gate for the genuine `claude` CLI's `--plugin-dir` flag (NIM-845).
 *
 * `--plugin-dir <dir>` loads a bare extension Claude-plugin directory (one with
 * `.claude-plugin/plugin.json` + `commands/`) for the session — the CLI analog
 * of the Agent SDK's `{ type: 'local', path }`. It is what makes namespaced
 * slash commands (`/feedback:bug-report`, `/planning:design`, …) resolve in a
 * `claude-code-cli` session. Without it the launched binary has zero extension
 * plugins loaded and honestly reports `Unknown command`.
 *
 * The flag only exists on modern CLIs. Per the official Claude Code CHANGELOG the
 * top-level `--plugin-dir` already existed and was being *modified* by 2.1.74
 * ("local dev copies now override installed marketplace plugins") and 2.1.76
 * ("use repeated `--plugin-dir` for multiple directories" — the exact repeated
 * single-path form we emit). We gate at **2.1.76**: it's the earliest version
 * whose documented arity matches our emission, well below the introduction. (The
 * later 2.1.142 line in the changelog is the separate `claude agents` subcommand
 * flag batch, NOT the top-level flag — don't be misled by it.) Confirmed present
 * as a top-level option on 2.1.177; 1.0.72 has no plugin system at all.
 * Nimbalyst runs the user's OWN `claude` (see `claudeExecutableResolver.ts`) and
 * does not pin a version, so an older install may be resolved. On such a CLI
 * commander rejects `--plugin-dir` as an unknown option and the launch FAILS —
 * so we must detect support before passing the flags by parsing `claude
 * --version` and comparing against the floor.
 *
 * Pure where it can be (parse/compare are injectable-free); the live probe takes
 * an injected `runVersionCommand` so it unit-tests without spawning a process.
 * Production uses `execFileSync(<exe>, ['--version'])`. The result is cached per
 * resolved executable for the process lifetime (the version only changes across
 * a `claude update`, which restarts nothing here) and re-probed if the resolved
 * path changes.
 */

import { execFileSync } from 'node:child_process';

/**
 * Minimum `claude` version we pass the top-level `--plugin-dir` flag to.
 * Source: Claude Code CHANGELOG — 2.1.76 documents repeated single-path
 * `--plugin-dir` (the form we emit); the flag itself predates it (modified at
 * 2.1.74). Empirically confirmed present on 2.1.177 and absent on 1.0.72.
 */
export const MIN_CLAUDE_CLI_VERSION_FOR_PLUGIN_DIR = '2.1.76';

export interface ParsedClaudeVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Parse the first `x.y.z` triple out of `claude --version` output (e.g. `2.1.177 (Claude Code)`). */
export function parseClaudeVersion(output: string): ParsedClaudeVersion | null {
  if (typeof output !== 'string') return null;
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** True iff `a` >= `b` by major/minor/patch. */
function versionGte(a: ParsedClaudeVersion, b: ParsedClaudeVersion): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

const FLOOR = parseClaudeVersion(MIN_CLAUDE_CLI_VERSION_FOR_PLUGIN_DIR)!;

/**
 * Decide support directly from raw `--version` output. Fails closed: any version
 * below the floor, or output we cannot parse, is treated as unsupported (we'd
 * rather silently skip the flags than crash the launch on an old CLI).
 */
export function claudeVersionOutputSupportsPluginDir(versionOutput: string): boolean {
  const parsed = parseClaudeVersion(versionOutput);
  if (!parsed) return false;
  return versionGte(parsed, FLOOR);
}

export interface ClaudeCliPluginSupportDeps {
  /** Run `<executable> --version` and return its stdout. Throws if the binary can't run. */
  runVersionCommand: (executable: string) => string;
}

/** Default production probe: `execFileSync(<exe>, ['--version'])` with a short timeout. */
const defaultDeps: ClaudeCliPluginSupportDeps = {
  runVersionCommand: (executable: string) =>
    execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      // Don't inherit a huge env / let stderr noise reach us; we only need stdout.
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
};

const supportCache = new Map<string, boolean>();

/**
 * Resolve (and cache) whether the resolved `claude` executable supports
 * `--plugin-dir`. Probes `--version` once per executable path; fails closed on
 * any error (missing binary, timeout, unparseable output).
 */
export function resolveClaudeCliSupportsPluginDir(
  executable: string,
  deps: ClaudeCliPluginSupportDeps = defaultDeps,
): boolean {
  const cached = supportCache.get(executable);
  if (cached !== undefined) return cached;

  let supported = false;
  try {
    supported = claudeVersionOutputSupportsPluginDir(deps.runVersionCommand(executable));
  } catch {
    supported = false;
  }
  supportCache.set(executable, supported);
  return supported;
}

/** Test-only: clear the per-executable support cache. */
export function __resetClaudeCliPluginSupportCache(): void {
  supportCache.clear();
}
