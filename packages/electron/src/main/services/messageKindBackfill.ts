/**
 * Relabel historical `ai_agent_messages` rows whose `message_kind` the
 * classifier now assigns differently.
 *
 * Codex app-server notifications used to land in `meta` unless they were an
 * agent message, so tool output (`item/completed` for commands, MCP calls and
 * file changes) and lifecycle frames (`turn/*`, `thread/*`, errors) all shared
 * one label with frames nothing renders. The live write path now labels them
 * `tool` and `system`; this pass brings the rows written before that into
 * line so retention and search can select by kind.
 *
 * The decision is `extractSearchable`, the same function the write path runs,
 * so history and new rows cannot disagree. SQL only selects the candidates:
 * output rows still labelled `meta`, in a bounded id window. Rows the
 * classifier still calls `meta` are left alone, which also makes the pass
 * idempotent.
 *
 * Runs from the daily retention scheduler (deferred past first-usable). Each
 * chunk reads one id window, so no query scans the table; a cursor is
 * persisted after every chunk so an interrupted run resumes, and a completion
 * flag skips the pass entirely once drained. Rows inserted after the run
 * starts are above its ceiling and were classified at insert time.
 *
 * The SQL is portable, but the scheduler hands it the SQLite handle only, so
 * on a PGLite install it does not run.
 */

import { extractSearchable, type MessageKind } from '@nimbalyst/runtime/ai/server/transcript/searchableTextExtractor';
import { getAppSetting, setAppSetting } from '../utils/store';
import { logger } from '../utils/logger';

/** The slice of the database the pass needs; `SQLiteDatabaseProxy` satisfies it. */
export interface MessageKindBackfillDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface MessageKindBackfillState {
  getCursor(): number;
  setCursor(id: number): void;
  isComplete(): boolean;
  markComplete(): void;
}

export interface MessageKindBackfillOptions {
  state?: MessageKindBackfillState;
  /** Ids per chunk. */
  idWindow?: number;
  interChunkDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MessageKindBackfillResult {
  skipped: boolean;
  scanned: number;
  relabeled: Partial<Record<MessageKind, number>>;
  lastId: number;
}

/**
 * Ids examined per chunk. Only `meta` output rows in the window are read, and
 * on the measured install those average a few KB, so a window stays a few MB.
 */
export const MESSAGE_KIND_BACKFILL_ID_WINDOW = 2000;

const DEFAULT_INTER_CHUNK_DELAY_MS = 25;

/** Bump the suffix to re-run the pass after a classifier change. */
const CURSOR_KEY = 'messageKindBackfillCursorV1';
const COMPLETE_KEY = 'messageKindBackfillCompleteV1';

const appSettingsState: MessageKindBackfillState = {
  getCursor: () => getAppSetting<number>(CURSOR_KEY) ?? 0,
  setCursor: (id) => setAppSetting<number>(CURSOR_KEY, id),
  isComplete: () => getAppSetting<boolean>(COMPLETE_KEY) === true,
  markComplete: () => setAppSetting<boolean>(COMPLETE_KEY, true),
};

interface CandidateRow {
  id: number;
  source: string;
  content: string;
  metadata: unknown;
  hidden: unknown;
}

function parseMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runMessageKindBackfill(
  db: MessageKindBackfillDb,
  options: MessageKindBackfillOptions = {},
): Promise<MessageKindBackfillResult> {
  const state = options.state ?? appSettingsState;
  const idWindow = options.idWindow ?? MESSAGE_KIND_BACKFILL_ID_WINDOW;
  const delayMs = options.interChunkDelayMs ?? DEFAULT_INTER_CHUNK_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const result: MessageKindBackfillResult = { skipped: false, scanned: 0, relabeled: {}, lastId: state.getCursor() };
  if (state.isComplete()) {
    result.skipped = true;
    return result;
  }

  // MAX(id) reads the end of the primary key; it is not a scan.
  const { rows: bounds } = await db.query<{ hi: number | null }>('SELECT MAX(id) AS hi FROM ai_agent_messages');
  const ceiling = Number(bounds[0]?.hi ?? 0);

  let cursor = result.lastId;
  while (cursor < ceiling) {
    const windowEnd = Math.min(cursor + idWindow, ceiling);
    const { rows } = await db.query<CandidateRow>(
      `SELECT id, source, content, metadata, hidden
         FROM ai_agent_messages
        WHERE id > $1 AND id <= $2
          AND direction = 'output'
          AND message_kind = 'meta'
        ORDER BY id`,
      [cursor, windowEnd],
    );

    const byKind = new Map<MessageKind, number[]>();
    for (const row of rows) {
      result.scanned++;
      const { searchableText, messageKind } = extractSearchable({
        source: row.source,
        direction: 'output',
        content: row.content,
        metadata: parseMetadata(row.metadata),
        hidden: row.hidden === true || row.hidden === 1,
      });
      if (messageKind === 'meta') continue;
      if (searchableText != null) {
        // Rare (codex error frames): the text has to land too, so the FTS
        // trigger indexes it.
        await db.query(
          `UPDATE ai_agent_messages SET message_kind = $1, searchable_text = $2 WHERE id = $3 AND message_kind = 'meta'`,
          [messageKind, searchableText, row.id],
        );
      } else {
        const ids = byKind.get(messageKind) ?? [];
        ids.push(row.id);
        byKind.set(messageKind, ids);
      }
      result.relabeled[messageKind] = (result.relabeled[messageKind] ?? 0) + 1;
    }

    for (const [kind, ids] of byKind) {
      const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
      await db.query(
        `UPDATE ai_agent_messages SET message_kind = $1 WHERE id IN (${placeholders}) AND message_kind = 'meta'`,
        [kind, ...ids],
      );
    }

    cursor = windowEnd;
    result.lastId = cursor;
    state.setCursor(cursor);
    if (cursor < ceiling) await sleep(delayMs);
  }

  state.markComplete();
  const summary = Object.entries(result.relabeled).map(([k, n]) => `${k}=${n}`).join(' ');
  logger.main.info(
    `[MessageKindBackfill] complete: scanned=${result.scanned} relabeled ${summary || 'none'} lastId=${result.lastId}`,
  );
  return result;
}
