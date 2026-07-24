/**
 * Shared per-session registry of already-persisted `nimbalyst_tool_result`
 * tool_use_ids for the genuine `claude-code-cli` path (NIM-806, Phase 3 / B3).
 *
 * Why a shared registry (and not just the proxy's local `seen` set):
 * a CLI AskUserQuestion / PromptForUserInput tool_result has TWO writers —
 *   1. the MCP interactive-prompt settle (synthetic write, mid-turn), and
 *   2. the proxy observation scraping the CLI's echoed tool_result from the
 *      next `/v1/messages` request body.
 * The proxy's `seen` set is pre-seeded only at observation START, so it misses
 * the synthetic write that lands when the user answers → a duplicate row.
 *
 * This registry is the single source of "already persisted for this session":
 * the proxy observation uses the session's set (pre-seeded from the DB, cleared
 * on stop), and the synthetic writers mark the id the instant they write. The
 * CLI is blocked on the MCP response until settle, so the mark always precedes
 * the proxy's continuation-body scrape — the proxy then skips the duplicate,
 * independent of DB commit timing.
 *
 * Intentionally dependency-free so it can be imported by both the MCP-tools
 * layer and the proxy-observation layer without an import cycle.
 */

const seenToolResultIdsBySession = new Map<string, Set<string>>();

/** The session's seen-set, created on first access. */
export function getSeenToolResultIds(sessionId: string): Set<string> {
  let set = seenToolResultIdsBySession.get(sessionId);
  if (!set) {
    set = new Set<string>();
    seenToolResultIdsBySession.set(sessionId, set);
  }
  return set;
}

/** Mark a tool_use_id as persisted for this session (no-op for empty ids). */
export function markToolResultPersisted(sessionId: string, toolUseId: string | undefined): void {
  if (!sessionId || !toolUseId) return;
  getSeenToolResultIds(sessionId).add(toolUseId);
}

/** Drop the session's set (call when its observation session ends). */
export function clearSeenToolResultIds(sessionId: string): void {
  seenToolResultIdsBySession.delete(sessionId);
}
