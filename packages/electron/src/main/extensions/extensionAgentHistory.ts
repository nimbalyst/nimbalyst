import type { Message } from '@nimbalyst/runtime/ai/server/types';

/**
 * History shape the extension agent backend's tool loop seeds from each turn.
 * Mirrors the gemini-antigravity BackendHistoryMessage so the host can hand the
 * backend its prior conversation.
 */
export interface BackendHistoryMessage {
  role?: 'user' | 'assistant' | 'tool';
  content?: string;
  toolCall?: { name?: string; result?: unknown };
}

/**
 * Convert the host's canonical Message[] into the BackendHistoryMessage[] the
 * extension agent backend replays each turn.
 *
 * Why this exists: the bridge previously passed prior messages under a `messages`
 * key the backend ignores (the backend reads `history`), and it re-creates the
 * backend session every turn (which resets the tool loop). The net effect was an
 * amnesiac agent - every turn started with an empty loop, so a meta-agent forgot
 * which children it had spawned and the get_session_result content it had pulled,
 * and normal chat lost its memory. Feeding the correctly-keyed `history` restores
 * cross-turn memory.
 *
 * - system-role turns are dropped: the persona is delivered via systemPrompt, not
 *   replayed as conversation.
 * - the backend de-duplicates a trailing user turn that matches the inbound
 *   message, so passing the full prior history (current user turn included) is safe.
 */
export function toBackendHistory(
  messages: Message[] | undefined | null,
): BackendHistoryMessage[] {
  if (!messages || messages.length === 0) return [];
  const out: BackendHistoryMessage[] = [];
  for (const m of messages) {
    if (!m || m.role === 'system') continue;
    const role: 'user' | 'assistant' | 'tool' =
      m.role === 'user' || m.role === 'tool' ? m.role : 'assistant';
    const entry: BackendHistoryMessage = {
      role,
      content: typeof m.content === 'string' ? m.content : '',
    };
    if (m.toolCall && typeof m.toolCall === 'object') {
      entry.toolCall = { name: m.toolCall.name, result: m.toolCall.result };
    }
    out.push(entry);
  }
  return out;
}
