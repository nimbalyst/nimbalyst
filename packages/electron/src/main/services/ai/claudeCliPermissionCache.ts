/**
 * Per-session approved-tool-pattern cache for the genuine `claude-code-cli`
 * permission flow (NIM-806, Phase 4 / Direction A).
 *
 * When the CLI needs permission for a built-in tool (Bash/Edit/Write/…) it
 * invokes our MCP `request_tool_permission` tool (via
 * `--permission-prompt-tool request_tool_permission`). The
 * user answers a `ToolPermissionWidget` with a scope (once / session / always).
 *
 * The CLI has no knowledge of a "session"-scoped approval (we never wrote it to
 * `.claude/settings.local.json`), so it WILL re-invoke our tool for the same
 * pattern later in the run. This cache is how Session/Always actually suppress
 * the re-prompt: the handler records the approved pattern here and short-circuits
 * to `allow` on the next matching request — mirroring the SDK provider's
 * `sessionApprovedPatterns` set (`toolAuthorization.ts`), but for the external
 * CLI which has no in-process provider to hold that state.
 *
 * "always" additionally persists to Claude settings (handled by the caller), so
 * a future CLI session is auto-allowed by the CLI itself before our tool is even
 * called. This cache only needs to cover the CURRENT run.
 *
 * Pattern matching uses the SAME prefix-wildcard semantics as the Claude allow
 * list (`matchesAllowPattern`), so an approved `Bash(git:*)` covers a later
 * `Bash(git status:*)` request — exactly like the settings-file allow list.
 *
 * Intentionally dependency-light (only the pure `matchesAllowPattern` helper) so
 * it can be imported by the MCP-tools layer without an import cycle.
 */

import { matchesAllowPattern } from '@nimbalyst/runtime/ai/server/permissions/toolPermissionHelpers';

const approvedPatternsBySession = new Map<string, Set<string>>();

/** The session's approved-pattern set, created on first access. */
function getSet(sessionId: string): Set<string> {
  let set = approvedPatternsBySession.get(sessionId);
  if (!set) {
    set = new Set<string>();
    approvedPatternsBySession.set(sessionId, set);
  }
  return set;
}

/**
 * Record a pattern approved for the session (Session/Always scope). Compound
 * one-time patterns (`Bash:compound:…`) are intentionally never cached — they
 * must be re-approved each time, matching the SDK behavior.
 */
export function markPatternApproved(sessionId: string, pattern: string): void {
  if (!sessionId || !pattern) return;
  if (pattern.startsWith('Bash:compound:')) return;
  getSet(sessionId).add(pattern);
}

/**
 * True when the requested `pattern` is covered by a pattern already approved for
 * this session (exact or prefix-wildcard via `matchesAllowPattern`). Compound
 * patterns never match (they carry a per-call timestamp).
 */
export function isPatternApproved(sessionId: string, pattern: string): boolean {
  if (!sessionId || !pattern) return false;
  if (pattern.startsWith('Bash:compound:')) return false;
  const set = approvedPatternsBySession.get(sessionId);
  if (!set || set.size === 0) return false;
  for (const approved of set) {
    if (matchesAllowPattern(pattern, approved)) return true;
  }
  return false;
}

/** Drop the session's approvals (call when its CLI session ends). */
export function clearApprovedPatterns(sessionId: string): void {
  approvedPatternsBySession.delete(sessionId);
}
