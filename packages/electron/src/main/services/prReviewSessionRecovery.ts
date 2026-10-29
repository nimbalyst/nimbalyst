import type { DatabaseEngine } from '../database/PGLiteDatabaseWorker';
import type { DatabaseLike } from './githubOverlayLookup';

/**
 * Finds review sessions the Pull Requests panel started before it kept an
 * overlay for each PR (NIM-7657). Those sessions have no tracker link and no
 * worktree; the only record of their PR is the panel's opening prompt,
 * "Review pull request https://github.com/<remote>/pull/<n> ...".
 *
 * One FTS phrase lookup per PR, then an exact prefix check on the matched
 * prompt. SQLite only: PGLite's message search index is built on demand, so
 * there this returns nothing rather than scanning ai_agent_messages.
 */

const MAX_SESSIONS = 20;

function draftPrefix(remote: string, prNumber: number): string {
  return `Review pull request https://github.com/${remote}/pull/${prNumber} `.toLowerCase();
}

/** The draft's opening words as an FTS5 phrase (tokens split like unicode61). */
function draftPhrase(remote: string, prNumber: number): string {
  const tokens = `review pull request https github com ${remote} pull ${prNumber}`
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return `"${tokens.join(' ')}"`;
}

export async function findPrReviewSessionIds(
  db: DatabaseLike,
  engine: DatabaseEngine,
  workspacePath: string,
  remote: string,
  prNumber: number,
): Promise<string[]> {
  if (engine !== 'sqlite') return [];
  const { rows } = await db.query<{ session_id: string; searchable_text: string | null }>(
    `SELECT m.session_id, m.searchable_text
     FROM ai_agent_messages_fts f
     JOIN ai_agent_messages m ON m.id = f.rowid
     JOIN ai_sessions s ON s.id = m.session_id
     WHERE ai_agent_messages_fts MATCH $1
       AND m.direction = 'input'
       AND s.workspace_id = $2
     LIMIT ${MAX_SESSIONS * 2}`,
    [draftPhrase(remote, prNumber), workspacePath],
  );
  const prefix = draftPrefix(remote, prNumber);
  const ids = new Set<string>();
  for (const row of rows) {
    // The phrase also matches a prompt that merely quotes the draft; only a
    // prompt that opens with it was started from the panel for this PR.
    if (row.searchable_text?.trimStart().toLowerCase().startsWith(prefix)) ids.add(row.session_id);
    if (ids.size >= MAX_SESSIONS) break;
  }
  return Array.from(ids);
}
