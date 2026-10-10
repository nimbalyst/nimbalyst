/**
 * Durable record of a composer prompt between "the user pressed send" and
 * "the turn finished".
 *
 * A prompt sent to an idle session used to live only in memory until the
 * provider logged it to ai_agent_messages, and several awaited setup steps
 * (inbox, question supersede, provider init, file watcher, Codex workflow
 * exports) run before that. A stall in any of them followed by a quit lost
 * the prompt for good: the composer and its persisted draft were already
 * cleared. The renderer now records the prompt here, in the session's
 * metadata, before it clears anything, and the send path clears the record
 * when the turn ends.
 *
 * Boot recovery never re-sends a recorded prompt. If an input row was logged
 * after the record, the prompt is in the transcript and the record is just
 * dropped. Otherwise the text is put back into the session's draft, merged
 * after anything already there, so the user decides whether to send it.
 */

import { logger } from '../../utils/logger';
import { toMillis } from '../../utils/timestampUtils';
import { mergeRestoredPromptIntoDraft } from '../../../shared/restoredDraft';

export interface PendingSubmission {
  id: string;
  prompt: string;
  submittedAt: number;
}

type Db = { query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }> };

/** Narrow slice of SessionStore.updateMetadata the store writes through. */
type UpdateMetadata = (
  sessionId: string,
  update: { draftInput?: string; metadata?: Record<string, unknown> },
) => Promise<void>;

export interface PendingSubmissionCandidate {
  sessionId: string;
  pending: PendingSubmission;
  draftInput: string | null;
  /** Latest `input` row logged for the session, epoch ms, or null if none. */
  lastInputAt: number | null;
}

export type PendingSubmissionRecoveryPlan =
  | { kind: 'delivered'; sessionId: string }
  | { kind: 'restore'; sessionId: string; draftInput: string; pending: PendingSubmission };

/**
 * Decides what boot recovery does with one recorded submission. Pure so the
 * decision is testable without a database.
 */
export function planPendingSubmissionRecovery(candidate: PendingSubmissionCandidate): PendingSubmissionRecoveryPlan {
  const { sessionId, pending, draftInput, lastInputAt } = candidate;
  if (lastInputAt !== null && lastInputAt >= pending.submittedAt) {
    return { kind: 'delivered', sessionId };
  }
  return {
    kind: 'restore',
    sessionId,
    pending,
    draftInput: mergeRestoredPromptIntoDraft(draftInput, pending.prompt),
  };
}

export function parsePendingSubmission(raw: unknown): PendingSubmission | null {
  const value = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!value || typeof value !== 'object') return null;
  const { id, prompt, submittedAt } = value as Record<string, unknown>;
  if (typeof id !== 'string' || typeof prompt !== 'string' || typeof submittedAt !== 'number') return null;
  return { id, prompt, submittedAt };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface PendingSubmissionStore {
  record(sessionId: string, prompt: string): Promise<PendingSubmission>;
  /** Drops the record only if it is still the submission `id` refers to. */
  clear(sessionId: string, id: string): Promise<void>;
  recoverOnBoot(): Promise<{ delivered: number; restored: PendingSubmissionRecoveryPlan[] }>;
}

export function createPendingSubmissionStore(
  db: Db,
  updateMetadata: UpdateMetadata,
  now: () => number = Date.now,
  newId: () => string = () => crypto.randomUUID(),
): PendingSubmissionStore {
  const readPending = async (sessionId: string): Promise<PendingSubmission | null> => {
    const { rows } = await db.query<{ pending: unknown }>(
      `SELECT metadata->>'pendingSubmission' AS pending FROM ai_sessions WHERE id = $1`,
      [sessionId],
    );
    return parsePendingSubmission(rows[0]?.pending);
  };

  return {
    async record(sessionId, prompt) {
      const pending: PendingSubmission = { id: newId(), prompt, submittedAt: now() };
      await updateMetadata(sessionId, { metadata: { pendingSubmission: pending } });
      return pending;
    },

    async clear(sessionId, id) {
      // A newer submission may already have replaced this one when the
      // renderer saw the session go idle before this turn's teardown finished.
      const current = await readPending(sessionId);
      if (current?.id !== id) return;
      await updateMetadata(sessionId, { metadata: { pendingSubmission: null } });
    },

    async recoverOnBoot() {
      const { rows } = await db.query<{ id: string; draft_input: string | null; pending: unknown }>(
        `SELECT id, draft_input, metadata->>'pendingSubmission' AS pending
         FROM ai_sessions
         WHERE metadata->>'pendingSubmission' IS NOT NULL`,
      );
      const recorded = rows
        .map(row => ({ row, pending: parsePendingSubmission(row.pending) }))
        .filter((entry): entry is { row: typeof rows[number]; pending: PendingSubmission } => entry.pending !== null);
      if (recorded.length === 0) return { delivered: 0, restored: [] };

      const placeholders = recorded.map((_, index) => `$${index + 1}`).join(', ');
      const { rows: inputRows } = await db.query<{ session_id: string; last_input_at: unknown }>(
        `SELECT session_id, MAX(created_at) AS last_input_at
         FROM ai_agent_messages
         WHERE direction = 'input' AND session_id IN (${placeholders})
         GROUP BY session_id`,
        recorded.map(entry => entry.row.id),
      );
      const lastInputBySession = new Map(inputRows.map(row => [row.session_id, toMillis(row.last_input_at)]));

      let delivered = 0;
      const restored: PendingSubmissionRecoveryPlan[] = [];
      for (const { row, pending } of recorded) {
        const plan = planPendingSubmissionRecovery({
          sessionId: row.id,
          pending,
          draftInput: row.draft_input,
          lastInputAt: lastInputBySession.get(row.id) ?? null,
        });
        if (plan.kind === 'delivered') {
          delivered++;
          await updateMetadata(row.id, { metadata: { pendingSubmission: null } });
        } else {
          // Logged before the write so a crash mid-recovery still leaves a trace;
          // the record itself stays until the draft holding the text is written.
          logger.main.warn(
            `[PendingSubmissions] Restoring undelivered prompt ${pending.id} (${pending.prompt.length} chars) to the composer for session ${row.id}`,
          );
          await updateMetadata(row.id, { draftInput: plan.draftInput, metadata: { pendingSubmission: null } });
          restored.push(plan);
        }
      }
      return { delivered, restored };
    },
  };
}

/**
 * Boot entry point. Runs after the queued-prompt sweep; failures are logged
 * and never block startup, because the records stay in place for next launch.
 */
export async function recoverPendingSubmissionsOnBoot(store: PendingSubmissionStore): Promise<void> {
  try {
    const { delivered, restored } = await store.recoverOnBoot();
    if (delivered > 0 || restored.length > 0) {
      logger.main.info(
        `[PendingSubmissions] Boot recovery: ${delivered} delivered, ${restored.length} restored to the composer (${restored.map(plan => plan.sessionId).join(', ')})`,
      );
    }
  } catch (error) {
    logger.main.error('[PendingSubmissions] Boot recovery failed:', error);
  }
}
