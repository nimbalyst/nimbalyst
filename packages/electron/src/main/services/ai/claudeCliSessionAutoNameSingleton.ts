/**
 * Production wiring for the claude-code-cli auto-namer (NIM-822).
 *
 * Invoked from the launcher's PID `idle` transition (the first completed turn
 * boundary). Once-per-session guarded; a failed attempt may retry on the next
 * idle. The title writer is registered by SessionNamingService at startup
 * (same applySessionTitle path the naming MCP server uses) — registration
 * indirection avoids a services → launcher import cycle.
 */

import { AISessionsRepository, AgentMessagesRepository } from '@nimbalyst/runtime';
import { maybeAutoNameClaudeCliSession } from './claudeCliSessionAutoName';

type ApplyTitleFn = (sessionId: string, title: string) => Promise<void>;

let applyTitleFn: ApplyTitleFn | null = null;

export function setClaudeCliAutoNameApplyTitleFn(fn: ApplyTitleFn | null): void {
  applyTitleFn = fn;
}

const attempted = new Set<string>();

/** Clean prompt text of the session's first visible user turn, or null. */
async function getFirstUserPrompt(sessionId: string): Promise<string | null> {
  const messages = await AgentMessagesRepository.list(sessionId, { limit: 50 });
  const firstInput = messages.find((m) => m.direction === 'input' && !m.hidden);
  if (!firstInput) return null;
  try {
    const parsed = JSON.parse(firstInput.content) as { prompt?: unknown };
    return typeof parsed?.prompt === 'string' ? parsed.prompt : null;
  } catch {
    return null;
  }
}

/**
 * Auto-name the session from its first user prompt if the agent hasn't named
 * it (best-effort; never throws into the turn-state callback).
 */
export async function maybeAutoNameClaudeCliSessionProduction(sessionId: string): Promise<void> {
  if (attempted.has(sessionId)) return;
  attempted.add(sessionId);
  try {
    const apply = applyTitleFn;
    if (!apply) {
      console.warn('[ClaudeCliAutoName] applyTitle not registered; skipping');
      return;
    }
    const outcome = await maybeAutoNameClaudeCliSession(sessionId, {
      isAlreadyNamed: async (id) => {
        const session = await AISessionsRepository.get(id);
        return !!session?.hasBeenNamed;
      },
      getFirstUserPrompt,
      applyTitle: apply,
    });
    console.log(`[ClaudeCliAutoName] ${sessionId}: ${outcome}`);
  } catch (err) {
    // Allow a retry on the next idle transition.
    attempted.delete(sessionId);
    console.warn('[ClaudeCliAutoName] auto-name failed:', err);
  }
}
