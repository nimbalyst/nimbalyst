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
 * Cap on prior turns seeded into the backend each turn. The backend re-seeds
 * the whole history every turn (it replaces, not appends), so without a bound a
 * long meta-agent run would re-send an ever-growing transcript - including 50k
 * get_session_result tool results - into the prompt on every turn. We keep the
 * first entry (usually the original task) plus the most recent ones.
 */
const MAX_SEEDED_HISTORY = 80;

/**
 * The host passes one of two shapes, and AIProvider.sendMessage types it as
 * any[], so the type checker will not catch a mismatch:
 *   - the canonical Message: { role, content, toolCall: { name } }
 *   - the TranscriptViewMessage the session actually stores:
 *       { type: 'user_message' | 'assistant_message' | 'tool_call' | ...,
 *         text, toolCall: { toolName, result } }
 * Session state holds TranscriptViewMessage[], so the type/text/toolName branch
 * is the one that fires at runtime. We accept both structurally.
 */
interface RuntimeHistoryLike {
  role?: string;
  content?: unknown;
  type?: string;
  text?: unknown;
  toolCall?: { name?: string; toolName?: string; result?: unknown } | null;
}

function eventTypeToRole(type: string | undefined): 'user' | 'assistant' | 'tool' | null {
  switch (type) {
    case 'user_message':
      return 'user';
    case 'assistant_message':
      return 'assistant';
    case 'tool_call':
    case 'tool_result':
      return 'tool';
    default:
      return null; // system_message, turn markers, subagent frames, etc.
  }
}

/**
 * Convert the host's prior conversation into the BackendHistoryMessage[] the
 * extension agent backend replays each turn.
 *
 * Why this exists: the bridge re-creates the backend session every turn (which
 * resets the tool loop) and the backend reads `history`, not `messages`. Feeding
 * the correctly-shaped history restores cross-turn memory - a meta-agent then
 * remembers which children it spawned and the get_session_result content it
 * pulled, and normal chat keeps its memory. A tool_call entry maps to role
 * 'tool' with its result, which the backend's seedHistory replays even when the
 * text is empty.
 *
 * system-role / system_message turns are dropped: the persona is delivered via
 * systemPrompt, not replayed as conversation. The backend de-duplicates a
 * trailing user turn matching the inbound message, so passing the full prior
 * history is safe.
 */
export function toBackendHistory(
  messages: ReadonlyArray<unknown> | undefined | null,
): BackendHistoryMessage[] {
  if (!messages || messages.length === 0) return [];
  const out: BackendHistoryMessage[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as RuntimeHistoryLike;
    let role: 'user' | 'assistant' | 'tool' | null;
    if (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') {
      role = m.role;
    } else if (m.role === 'system') {
      role = null;
    } else {
      role = eventTypeToRole(m.type);
    }
    if (!role) continue;
    const content =
      typeof m.content === 'string'
        ? m.content
        : typeof m.text === 'string'
          ? m.text
          : '';
    const entry: BackendHistoryMessage = { role, content };
    const tc = m.toolCall;
    if (tc && typeof tc === 'object') {
      entry.toolCall = { name: tc.name ?? tc.toolName, result: tc.result };
    }
    // Skip an entry that carries nothing the backend can replay (no text and,
    // for a tool entry, no result) - matches the backend's own seed filter.
    if (!entry.content && !(entry.toolCall && entry.toolCall.result !== undefined)) {
      continue;
    }
    out.push(entry);
  }
  if (out.length <= MAX_SEEDED_HISTORY) return out;
  // Preserve the first entry (usually the original task) plus the most recent.
  return [out[0], ...out.slice(-(MAX_SEEDED_HISTORY - 1))];
}
