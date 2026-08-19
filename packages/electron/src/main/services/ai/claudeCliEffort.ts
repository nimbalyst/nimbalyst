/**
 * Effort resolution for `claude-code-cli` sessions (#844).
 *
 * The Agent SDK path forwards the selected effort to the CLI as
 * `CLAUDE_CODE_EFFORT_LEVEL` (see `sdkOptionsBuilder`). The interactive CLI path
 * never did, so the effort selector was inert for a `claude-code-cli` session and
 * every launch ran at whatever the CLI defaults to.
 *
 * Resolution order matches the SDK path: an explicit value wins, then the
 * session's own selection, then the app default. Pure + dependency-injected so
 * it unit-tests without a database or an electron-store.
 */

import type { EffortLevel } from '@nimbalyst/runtime/ai/server/effortLevels';

export interface ResolveClaudeCliEffortInput {
  /** Explicit override. Skips the lookup entirely when present. */
  explicit?: string;
  sessionId: string;
}

export interface ResolveClaudeCliEffortDeps {
  /**
   * The session's own effort selection. Typed `unknown` because it comes from
   * untyped session metadata; `resolveEffortLevel` validates it.
   */
  getSessionEffortLevel: (sessionId: string) => Promise<unknown>;
  /** The app-wide default effort, or undefined to leave the CLI on its own. */
  getDefaultEffortLevel: () => EffortLevel | undefined;
  /** Validates a raw value, falling back to the app default. */
  resolveEffortLevel: (
    sessionEffort: unknown,
    appDefault: EffortLevel | undefined,
  ) => EffortLevel | undefined;
  logWarn?: (message: string, err: unknown) => void;
}

/**
 * Returns the effort to forward, or undefined to leave `CLAUDE_CODE_EFFORT_LEVEL`
 * unset so the CLI applies its own default.
 *
 * Never throws: a failed session lookup degrades to the app default rather than
 * blocking the launch.
 */
export async function resolveClaudeCliEffort(
  input: ResolveClaudeCliEffortInput,
  deps: ResolveClaudeCliEffortDeps,
): Promise<string | undefined> {
  if (input.explicit) return input.explicit;

  let sessionEffort: unknown;
  try {
    sessionEffort = await deps.getSessionEffortLevel(input.sessionId);
  } catch (err) {
    deps.logWarn?.('[ClaudeCliLauncher] effort lookup failed; using the app default:', err);
  }

  return deps.resolveEffortLevel(sessionEffort ?? undefined, deps.getDefaultEffortLevel());
}
