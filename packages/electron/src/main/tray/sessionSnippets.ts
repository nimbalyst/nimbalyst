/**
 * A one-line "what is it actually saying" snippet per session.
 *
 * The tray cache carries state but no content, so a row can say a session is
 * running without saying anything about what it is doing. This reads the latest
 * assistant text straight out of `ai_agent_messages`.
 *
 * Two things make that cheap enough to do at all:
 *
 * - `searchable_text` is already the extracted plain text. Parsing `content`
 *   would mean decoding each provider's raw envelope in the tray, which is the
 *   job `TranscriptTransformer` exists to do exactly once. It is also empty for
 *   `tool`, `meta` and `system` rows, so filtering on it drops the noise for
 *   free -- on a real session, 555 tool rows against 83 assistant ones.
 * - One batched query for every visible session, never one per row. A per-row
 *   query here would be an N+1 against the largest table in the database.
 *
 * Snippets are fetched only while the island is expanded. Nothing about the
 * resting strip needs them, and a query per `session:streaming` tick would be
 * indefensible.
 */

/** Long enough to be a sentence fragment, short enough not to reflow the panel. */
export const SNIPPET_MAX_CHARS = 110;

/** Session ids are ours, but they still get quoted rather than interpolated raw. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Reduce a message body to one line.
 *
 * Takes the *last* non-empty line rather than the first: an assistant turn
 * usually opens with preamble and ends with the point, and the trailing line is
 * what "where has it got to" means. Markdown scaffolding (list bullets, heading
 * hashes, fences) is stripped because at this size it reads as noise.
 */
export function toSnippetLine(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('```'));
  if (lines.length === 0) return null;

  const line = lines[lines.length - 1]
    .replace(/^[#>\s]*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) return null;

  return line.length > SNIPPET_MAX_CHARS
    ? `${line.slice(0, SNIPPET_MAX_CHARS - 1).trimEnd()}…`
    : line;
}

/**
 * The current title for each of `sessionIds`, in one query.
 *
 * The tray cache fills a row's title once, when the session first enters it, and
 * a session is routinely renamed after that -- by the agent's own
 * `update_session_meta`, by the naming service, by the user. The panel was
 * showing whatever the title happened to be at first sight, sometimes hours
 * stale. This is read on the same trigger as the snippets (island open only),
 * against a small table, so it costs one more round trip on a surface the user
 * is looking at.
 *
 * Separate from the snippet query rather than joined into it: that one is shaped
 * to plan off `idx_ai_agent_messages_session` over the largest table in the
 * database, and widening it to reach `ai_sessions` for a string would be paying
 * in the wrong place.
 */
export function sessionTitlesSql(sessionIds: readonly string[]): string | null {
  const ids = sessionIds.filter((id) => SAFE_ID.test(id));
  if (ids.length === 0) return null;

  const list = ids.map((id) => `'${id}'`).join(', ');
  return `SELECT id, title FROM ai_sessions WHERE id IN (${list})`;
}

/**
 * The latest assistant text for each of `sessionIds`, in one query.
 *
 * Returns null when there is nothing to ask about, so the caller can skip the
 * round trip entirely rather than issuing `... IN ()`.
 *
 * One `ORDER BY id DESC LIMIT 1` probe per session, glued with UNION ALL, so
 * each probe reads one entry of the partial index
 * `idx_ai_agent_messages_latest_assistant_text (session_id, id DESC)` and stops.
 * The earlier grouped-MAX join let the planner pick `message_kind = ?` off the
 * user-prompts index instead (no ANALYZE stats, so `session_id IN (...)` looked
 * costlier), which walked every assistant row in the database through the table
 * on each refresh. The WHERE clause must keep repeating the index's three
 * predicate terms or the partial index stops being eligible.
 */
export function latestAssistantTextSql(sessionIds: readonly string[]): string | null {
  const ids = sessionIds.filter((id) => SAFE_ID.test(id));
  if (ids.length === 0) return null;

  return ids.map((id, i) => `
    SELECT * FROM (
      SELECT session_id, searchable_text
      FROM ai_agent_messages
      WHERE session_id = '${id}'
        AND message_kind = 'assistant'
        AND searchable_text IS NOT NULL
        AND searchable_text <> ''
      ORDER BY id DESC
      LIMIT 1
    ) AS latest_${i}`).join('\n    UNION ALL');
}
