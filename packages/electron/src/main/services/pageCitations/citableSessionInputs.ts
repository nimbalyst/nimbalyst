/**
 * Read one session's citable inputs (prompts and answered questions) from the
 * database. Works on both backends: only whole columns are selected and every
 * JSON column is parsed defensively (`metadata` is an object on PGLite and a
 * string on SQLite; see DATABASE.md).
 *
 * A session can hold tens of thousands of raw rows, most of them tool output,
 * so the first query takes only the rows that can matter: input rows and rows
 * that name an interactive tool or carry an answer. The SDK's `tool_result` for
 * a question does not name the tool, so a second query fetches results for the
 * questions still unanswered, by their call ids.
 */

import { collectCitableInputsFromRows, type CitableInput, type CitableRawRow } from './citableRawRows';

export interface CitableRowsDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const COLUMNS = 'id, created_at, source, direction, content, metadata, hidden, provider_message_id';

/** Bounds the follow-up query; older questions beyond this stay uncited. */
const MAX_PENDING_CALL_LOOKUPS = 100;

const INTERACTIVE_MARKERS = [
  'AskUserQuestion',
  'PromptForUserInput',
  'RequestUserInput',
  'ask_user_question_re',
  'request_user_input_response',
];

/** Ids of the SDK and CLI question calls, whose answers may not name the tool. */
function askedCallIds(rows: CitableRawRow[]): string[] {
  const asked = new Set<string>();
  for (const row of rows) {
    if (row.direction === 'input') continue;
    for (const match of row.content.matchAll(/"type":"(?:nimbalyst_tool_use|tool_use)","id":"([^"]+)","name":"(?:[^"]*__)?(?:AskUserQuestion|PromptForUserInput|RequestUserInput)"/g)) {
      asked.add(match[1]!);
    }
  }
  return [...asked];
}

export async function readCitableSessionRows(db: CitableRowsDb, sessionId: string): Promise<CitableRawRow[]> {
  const markerClauses = INTERACTIVE_MARKERS.map((_, index) => `content LIKE $${index + 2}`).join(' OR ');
  const { rows } = await db.query<CitableRawRow>(
    `SELECT ${COLUMNS} FROM ai_agent_messages
     WHERE session_id = $1 AND (direction = 'input' OR ${markerClauses})
     ORDER BY id ASC`,
    [sessionId, ...INTERACTIVE_MARKERS.map((marker) => `%${marker}%`)],
  );

  const seenIds = new Set(rows.map((row) => String(row.id)));
  const pending = askedCallIds(rows).slice(-MAX_PENDING_CALL_LOOKUPS);
  if (pending.length === 0) return rows;

  const idClauses = pending.map((_, index) => `content LIKE $${index + 2}`).join(' OR ');
  const { rows: results } = await db.query<CitableRawRow>(
    `SELECT ${COLUMNS} FROM ai_agent_messages
     WHERE session_id = $1 AND direction = 'output' AND (${idClauses})
     ORDER BY id ASC`,
    [sessionId, ...pending.map((id) => `%${id}%`)],
  );
  const extra = results.filter((row) => !seenIds.has(String(row.id)));
  if (extra.length === 0) return rows;
  return [...rows, ...extra].sort((a, b) => Number(a.id) - Number(b.id));
}

export async function listSessionCitableInputs(
  db: CitableRowsDb,
  sessionId: string,
  options: { author: string; authorEmail?: string },
): Promise<CitableInput[]> {
  const rows = await readCitableSessionRows(db, sessionId);
  return collectCitableInputsFromRows(rows, { sessionId, ...options });
}
