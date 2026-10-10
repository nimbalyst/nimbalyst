/**
 * Durable counterpart to `hasTerminalizedAskUserQuestion`.
 *
 * The in-memory set is lost on restart, so an answer that arrives afterwards
 * for a question already closed (superseded by a new turn, cancelled, or
 * answered through the fallback) from an older mobile build or voice would pass
 * the repeat guard and auto-resume the session. The terminal
 * `nimbalyst_tool_result` row is the durable record, so look for it.
 */

import { getCodexToolLookupAliases } from '@nimbalyst/runtime/ai/server/toolLookupIds';
import { database } from '../../database/PGLiteDatabaseWorker';
import { hasTerminalizedAskUserQuestion } from './askUserQuestionFallbackResolution';

export async function hasPersistedTerminalResult(sessionId: string, toolUseId: string): Promise<boolean> {
  // Both writers build the row with JSON.stringify, so the key/value pair is
  // contiguous. LIKE's `_` wildcard can over-match an id; the parse below is
  // the exact check. Whole `content` is parsed rather than sub-extracted, which
  // differs between PGLite and SQLite.
  const needle = `%"tool_use_id":${JSON.stringify(toolUseId)}%`;
  const { rows } = await database.query<{ content: string }>(
    `SELECT content FROM ai_agent_messages
     WHERE session_id = $1
       AND content LIKE '%nimbalyst_tool_result%'
       AND content LIKE $2`,
    [sessionId, needle],
  );
  return rows.some((row) => {
    try {
      const parsed = JSON.parse(row.content);
      return parsed?.type === 'nimbalyst_tool_result' && parsed.tool_use_id === toolUseId;
    } catch {
      return false;
    }
  });
}

/**
 * True when a question or structured-input prompt is already closed, under any
 * of its Codex aliases: terminalized by this process, or carrying a durable
 * terminal row. Answer entry points refuse a closed prompt before persisting or
 * emitting anything, so a stale form can never settle a newer waiter.
 */
export async function isInteractivePromptClosed(sessionId: string, promptId: string): Promise<boolean> {
  const ids = getCodexToolLookupAliases(promptId);
  if (ids.some((id) => hasTerminalizedAskUserQuestion(sessionId, id))) return true;
  for (const id of ids) {
    if (await hasPersistedTerminalResult(sessionId, id)) return true;
  }
  return false;
}
