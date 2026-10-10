import { hasOpenPrompts } from '../ai/openPromptRegistry';
import { hasLiveInteractivePrompt } from '../../mcp/tools/interactivePromptLiveness';

export { hasOpenPrompts };

/**
 * Whether this process is actually blocked on a prompt in the session.
 *
 * A transcript keeps an unanswered tool call forever, and `status` stays
 * `waiting_for_input` after the process that asked is gone -- 23 sessions in one
 * workspace, back months. Voice reading those aloud as current questions is the
 * failure this guards. The in-memory registries die with the process, and the
 * persisted bit is swept at startup, so any one of them means a live waiter.
 */
export function sessionHasLivePrompt(sessionId: string, persistedBit: unknown): boolean {
  return persistedBit === true || hasOpenPrompts(sessionId) || hasLiveInteractivePrompt(sessionId);
}
