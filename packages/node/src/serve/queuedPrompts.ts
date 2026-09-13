/**
 * The prompt queue, over the shared `queued_prompts` table.
 *
 * Queued prompts arrive in the index broadcast, which is a REPLAY: the same
 * prompt is re-delivered on every reconnect and on every bulk index pass until
 * the desktop stops publishing it. The id is therefore the whole story --
 * "have I already run this one?" has to survive a process restart, or a
 * container that reconnects re-runs the user's last prompt.
 *
 * Rows transition (`pending` -> `executing` -> `completed`/`failed`); nothing is
 * ever deleted, so a replayed id is recognised regardless of how its run ended.
 * `INSERT OR IGNORE` on the primary key is what makes claiming idempotent
 * without a read-then-write race.
 */

import type { EncryptedAttachment } from '@nimbalyst/runtime/sync/types';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { toIsoText } from '../store/columns.js';

export interface PendingPrompt {
  id: string;
  sessionId: string;
  prompt: string;
  /** Epoch ms, from the sender. */
  createdAt: number;
  attachments?: EncryptedAttachment[];
  options?: import("@nimbalyst/runtime/sync/types").RemoteTurnOptions;
}

export interface QueuedPromptStore {
  /** Insert a prompt as pending. Returns false when the id was already seen. */
  offer(prompt: PendingPrompt): boolean;
  /** Oldest-first pending rows for a session. */
  listPending(sessionId: string): PendingPrompt[];
  /** Mark a row as executing. Returns false when another writer claimed it first. */
  claim(id: string): boolean;
  complete(id: string): void;
  fail(id: string, errorMessage: string): void;
  /** Sessions with at least one pending row, so a restart can resume them. */
  listPendingSessions(): string[];
  /**
   * Rows left `executing` by a previous process are dead: nothing is streaming
   * for them.
   *
   * They are FAILED, not returned to `pending`. A turn's side effects -- files
   * written, commands run, commits pushed -- are not once-only, so replaying an
   * interrupted one is not a retry, it is a second uncoordinated attempt at
   * work that may already be half done. Returns the rows it failed so the
   * caller can say so in each session's transcript.
   */
  failInterrupted(): PendingPrompt[];
}

function toEpochMillis(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function createQueuedPromptStore(db: SqliteDatabase): QueuedPromptStore {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO queued_prompts (id, session_id, prompt, status, created_at, attachments, document_context)
    VALUES (@id, @sessionId, @prompt, 'pending', @createdAt, @attachments, @options)
  `);

  const selectPending = db.prepare(`
    SELECT id, session_id, prompt, created_at, attachments, document_context
    FROM queued_prompts
    WHERE session_id = ? AND status = 'pending'
    ORDER BY created_at ASC, rowid ASC
  `);

  // Guarded by the status: two drains racing the same row means exactly one
  // reports a change, and only that one runs the turn.
  const claimRow = db.prepare(`
    UPDATE queued_prompts SET status = 'executing', claimed_at = ?
    WHERE id = ? AND status = 'pending'
  `);

  const completeRow = db.prepare(`
    UPDATE queued_prompts SET status = 'completed', completed_at = ?, error_message = NULL
    WHERE id = ?
  `);

  const failRow = db.prepare(`
    UPDATE queued_prompts SET status = 'failed', completed_at = ?, error_message = ?
    WHERE id = ?
  `);

  const selectPendingSessions = db.prepare(`
    SELECT DISTINCT session_id FROM queued_prompts WHERE status = 'pending'
  `);

  const selectExecuting = db.prepare(`
    SELECT id, session_id, prompt, created_at, attachments, document_context FROM queued_prompts WHERE status = 'executing'
  `);

  const failExecuting = db.prepare(`
    UPDATE queued_prompts
    SET status = 'failed', completed_at = ?, error_message = ?
    WHERE status = 'executing'
  `);

  return {
    offer(prompt: PendingPrompt): boolean {
      return insert.run({
        id: prompt.id,
        sessionId: prompt.sessionId,
        prompt: prompt.prompt,
        createdAt: toIsoText(prompt.createdAt),
        attachments: prompt.attachments?.length ? JSON.stringify(prompt.attachments) : null,
        options: prompt.options ? JSON.stringify(prompt.options) : null,
      }).changes > 0;
    },

    listPending(sessionId: string): PendingPrompt[] {
      return (selectPending.all(sessionId) as Array<Record<string, unknown>>).map((row) => ({
        id: row.id as string,
        sessionId: row.session_id as string,
        prompt: row.prompt as string,
        createdAt: toEpochMillis(row.created_at),
        ...(row.attachments ? { attachments: JSON.parse(row.attachments as string) } : {}),
        ...(row.document_context ? {options: JSON.parse(row.document_context as string)} : {}),
      }));
    },

    claim(id: string): boolean {
      return claimRow.run(toIsoText(Date.now()), id).changes > 0;
    },

    complete(id: string): void {
      completeRow.run(toIsoText(Date.now()), id);
    },

    fail(id: string, errorMessage: string): void {
      failRow.run(toIsoText(Date.now()), errorMessage.slice(0, 2000), id);
    },

    listPendingSessions(): string[] {
      return (selectPendingSessions.all() as Array<{ session_id: string }>)
        .map((row) => row.session_id);
    },

    failInterrupted(): PendingPrompt[] {
      // Read then write in one transaction: the rows have to be captured before
      // they stop being `executing`, or the caller gets an empty list and the
      // sessions never learn their turn was abandoned.
      return db.transaction((): PendingPrompt[] => {
        const rows = (selectExecuting.all() as Array<Record<string, unknown>>).map((row) => ({
          id: row.id as string,
          sessionId: row.session_id as string,
          prompt: row.prompt as string,
          createdAt: toEpochMillis(row.created_at),
        ...(row.attachments ? { attachments: JSON.parse(row.attachments as string) } : {}),
        ...(row.document_context ? {options: JSON.parse(row.document_context as string)} : {}),
        }));
        if (rows.length > 0) {
          failExecuting.run(
            toIsoText(Date.now()),
            'Interrupted: the node stopped while this prompt was running.',
          );
        }
        return rows;
      }).immediate();
    },
  };
}
