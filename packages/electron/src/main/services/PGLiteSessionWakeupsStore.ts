/**
 * PGLite implementation of SessionWakeupsStore
 *
 * Persistent scheduled wakeups for AI sessions. The scheduler service in main
 * process owns the timer; this store owns the rows.
 *
 * `create` only inserts. Replacement is the caller's decision, made through
 * `cancelActiveForSession` -- see sessionWakeupScheduling.ts, which is the one
 * place that decides it (#1497). The two are separate statements, not one
 * transaction.
 */

import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';
import type { SessionWakeupOrigin } from '../../shared/sessionWakeups';
import { toMillis } from '../utils/timestampUtils';

export type SessionWakeupStatus =
  | 'pending'
  | 'firing'
  | 'fired'
  | 'waiting_for_workspace'
  | 'overdue'
  | 'cancelled'
  | 'failed';

export interface SessionWakeup {
  id: string;
  sessionId: string;
  workspaceId: string;
  prompt: string;
  reason: string | null;
  fireAt: number; // epoch ms
  status: SessionWakeupStatus;
  createdAt: number;
  firedAt: number | null;
  error: string | null;
  /** Carried with the scheduled prompt; empty when none. */
  attachments: ChatAttachment[];
  origin: SessionWakeupOrigin;
}

export interface CreateSessionWakeupInput {
  id: string;
  sessionId: string;
  workspaceId: string;
  prompt: string;
  reason?: string;
  fireAt: Date | number; // Date or epoch ms
  attachments?: ChatAttachment[];
  /** Defaults to 'agent', matching every row written before the column existed. */
  origin?: SessionWakeupOrigin;
}

export interface SessionWakeupsStore {
  /** Insert a wakeup. Never touches the session's other wakeups. */
  create(input: CreateSessionWakeupInput): Promise<SessionWakeup>;

  /**
   * Cancel a session's active wakeups of one origin, returning the cancelled
   * rows so the caller can tell the renderer they are gone.
   */
  cancelActiveForSession(sessionId: string, origin: SessionWakeupOrigin): Promise<SessionWakeup[]>;

  get(id: string): Promise<SessionWakeup | null>;

  /** All rows in 'pending' status, ordered by fire_at ASC. */
  listPending(): Promise<SessionWakeup[]>;

  /** Active rows (pending / overdue / waiting_for_workspace) for a session. */
  listActiveForSession(sessionId: string): Promise<SessionWakeup[]>;

  /** Active rows for a workspace, ordered by fire_at ASC. */
  listActiveForWorkspace(workspaceId: string): Promise<SessionWakeup[]>;

  /** Rows in 'waiting_for_workspace' for a workspace. */
  listWaitingForWorkspace(workspaceId: string): Promise<SessionWakeup[]>;

  cancel(id: string): Promise<SessionWakeup | null>;

  markOverdue(id: string): Promise<SessionWakeup | null>;
  markFiring(id: string): Promise<SessionWakeup | null>;
  markFired(id: string): Promise<SessionWakeup | null>;
  markWaitingForWorkspace(id: string): Promise<SessionWakeup | null>;
  markFailed(id: string, error: string): Promise<SessionWakeup | null>;

  /** Move fire_at to now, return the updated row. Used by "Run now" UI. */
  bumpToNow(id: string): Promise<SessionWakeup | null>;
}

type PGliteLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
};

type EnsureReadyFn = () => Promise<void>;

/**
 * `attachments` is a TEXT column on both backends, so it arrives as a JSON
 * string -- but the standard defensive parse is kept because a JSONB-typed
 * read would hand back an already-parsed array on PGLite and a string on
 * SQLite (see DATABASE.md). Malformed JSON degrades to no attachments rather
 * than breaking the whole wakeup.
 */
function parseAttachments(value: unknown): ChatAttachment[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rowToWakeup(row: any): SessionWakeup {
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    prompt: row.prompt,
    attachments: parseAttachments(row.attachments),
    reason: row.reason ?? null,
    fireAt: toMillis(row.fire_at)!,
    status: row.status as SessionWakeupStatus,
    createdAt: toMillis(row.created_at)!,
    firedAt: toMillis(row.fired_at),
    error: row.error ?? null,
    origin: row.origin === 'user' ? 'user' : 'agent',
  };
}

const ACTIVE_STATUSES = ['pending', 'overdue', 'waiting_for_workspace'] as const;

export function createPGLiteSessionWakeupsStore(
  db: PGliteLike,
  ensureDbReady?: EnsureReadyFn,
): SessionWakeupsStore {
  const ensureReady = async () => {
    if (ensureDbReady) {
      await ensureDbReady();
    }
  };

  return {
    async create(input: CreateSessionWakeupInput): Promise<SessionWakeup> {
      await ensureReady();

      const fireAt = input.fireAt instanceof Date ? input.fireAt : new Date(input.fireAt);

      const attachments = input.attachments?.length ? JSON.stringify(input.attachments) : null;
      const { rows } = await db.query<any>(
        `INSERT INTO ai_session_wakeups
           (id, session_id, workspace_id, prompt, reason, fire_at, status, attachments, origin)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
         RETURNING *`,
        [
          input.id,
          input.sessionId,
          input.workspaceId,
          input.prompt,
          input.reason ?? null,
          fireAt,
          attachments,
          input.origin ?? 'agent',
        ],
      );

      if (rows.length === 0) {
        throw new Error('Failed to create session wakeup');
      }
      return rowToWakeup(rows[0]);
    },

    async cancelActiveForSession(sessionId: string, origin: SessionWakeupOrigin): Promise<SessionWakeup[]> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `UPDATE ai_session_wakeups
            SET status = 'cancelled'
          WHERE session_id = $1
            AND origin = $2
            AND status = ANY($3::text[])
          RETURNING *`,
        [sessionId, origin, ACTIVE_STATUSES],
      );
      return rows.map(rowToWakeup);
    },

    async get(id: string): Promise<SessionWakeup | null> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `SELECT * FROM ai_session_wakeups WHERE id = $1`,
        [id],
      );
      return rows.length > 0 ? rowToWakeup(rows[0]) : null;
    },

    async listPending(): Promise<SessionWakeup[]> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `SELECT * FROM ai_session_wakeups
          WHERE status = 'pending'
          ORDER BY fire_at ASC`,
      );
      return rows.map(rowToWakeup);
    },

    async listActiveForSession(sessionId: string): Promise<SessionWakeup[]> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `SELECT * FROM ai_session_wakeups
          WHERE session_id = $1
            AND status = ANY($2::text[])
          ORDER BY fire_at ASC`,
        [sessionId, ACTIVE_STATUSES],
      );
      return rows.map(rowToWakeup);
    },

    async listActiveForWorkspace(workspaceId: string): Promise<SessionWakeup[]> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `SELECT * FROM ai_session_wakeups
          WHERE workspace_id = $1
            AND status = ANY($2::text[])
          ORDER BY fire_at ASC`,
        [workspaceId, ACTIVE_STATUSES],
      );
      return rows.map(rowToWakeup);
    },

    async listWaitingForWorkspace(workspaceId: string): Promise<SessionWakeup[]> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `SELECT * FROM ai_session_wakeups
          WHERE workspace_id = $1
            AND status = 'waiting_for_workspace'
          ORDER BY fire_at ASC`,
        [workspaceId],
      );
      return rows.map(rowToWakeup);
    },

    async cancel(id: string): Promise<SessionWakeup | null> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `UPDATE ai_session_wakeups
            SET status = 'cancelled'
          WHERE id = $1
            AND status = ANY($2::text[])
          RETURNING *`,
        [id, ACTIVE_STATUSES],
      );
      return rows.length > 0 ? rowToWakeup(rows[0]) : null;
    },

    async markOverdue(id: string): Promise<SessionWakeup | null> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `UPDATE ai_session_wakeups
            SET status = 'overdue'
          WHERE id = $1 AND status = 'pending'
          RETURNING *`,
        [id],
      );
      return rows.length > 0 ? rowToWakeup(rows[0]) : null;
    },

    async markFiring(id: string): Promise<SessionWakeup | null> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `UPDATE ai_session_wakeups
            SET status = 'firing'
          WHERE id = $1 AND status = ANY($2::text[])
          RETURNING *`,
        [id, ACTIVE_STATUSES],
      );
      return rows.length > 0 ? rowToWakeup(rows[0]) : null;
    },

    async markFired(id: string): Promise<SessionWakeup | null> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `UPDATE ai_session_wakeups
            SET status = 'fired',
                fired_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *`,
        [id],
      );
      return rows.length > 0 ? rowToWakeup(rows[0]) : null;
    },

    async markWaitingForWorkspace(id: string): Promise<SessionWakeup | null> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `UPDATE ai_session_wakeups
            SET status = 'waiting_for_workspace'
          WHERE id = $1
          RETURNING *`,
        [id],
      );
      return rows.length > 0 ? rowToWakeup(rows[0]) : null;
    },

    async markFailed(id: string, error: string): Promise<SessionWakeup | null> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `UPDATE ai_session_wakeups
            SET status = 'failed',
                error  = $2
          WHERE id = $1
          RETURNING *`,
        [id, error],
      );
      return rows.length > 0 ? rowToWakeup(rows[0]) : null;
    },

    async bumpToNow(id: string): Promise<SessionWakeup | null> {
      await ensureReady();
      const { rows } = await db.query<any>(
        `UPDATE ai_session_wakeups
            SET fire_at = CURRENT_TIMESTAMP,
                status  = 'pending'
          WHERE id = $1
            AND status = ANY($2::text[])
          RETURNING *`,
        [id, ACTIVE_STATUSES],
      );
      return rows.length > 0 ? rowToWakeup(rows[0]) : null;
    },
  };
}
