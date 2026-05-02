/**
 * PGLite implementation of SessionWakeupsStore
 *
 * Persistent scheduled wakeups for AI sessions. The scheduler service in main
 * process owns the timer; this store owns the rows.
 *
 * "Replace-on-create" semantics: creating a wakeup for a session that already
 * has an active one (pending / overdue / waiting_for_workspace) cancels the
 * prior row in the same transaction.
 */

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
}

export interface CreateSessionWakeupInput {
  id: string;
  sessionId: string;
  workspaceId: string;
  prompt: string;
  reason?: string;
  fireAt: Date | number; // Date or epoch ms
}

export interface SessionWakeupsStore {
  /**
   * Create a wakeup. Cancels any existing active wakeup
   * (pending / overdue / waiting_for_workspace) for the same session first.
   */
  create(input: CreateSessionWakeupInput): Promise<SessionWakeup>;

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

function toMillis(date: Date | string | null | undefined): number {
  if (!date) return 0;
  if (date instanceof Date) {
    return date.getTime();
  }
  const str = String(date).trim();
  const hasTimezone =
    str.endsWith('Z') || str.includes('+') || /-\d{2}:\d{2}$/.test(str);
  const parsed = new Date(hasTimezone ? str : str.replace(' ', 'T') + 'Z').getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function rowToWakeup(row: any): SessionWakeup {
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    prompt: row.prompt,
    reason: row.reason ?? null,
    fireAt: toMillis(row.fire_at),
    status: row.status as SessionWakeupStatus,
    createdAt: toMillis(row.created_at),
    firedAt: row.fired_at ? toMillis(row.fired_at) : null,
    error: row.error ?? null,
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

      // Cancel any active wakeup for the same session (replace-on-create semantics).
      await db.query(
        `UPDATE ai_session_wakeups
            SET status = 'cancelled'
          WHERE session_id = $1
            AND status = ANY($2::text[])`,
        [input.sessionId, ACTIVE_STATUSES],
      );

      const { rows } = await db.query<any>(
        `INSERT INTO ai_session_wakeups
           (id, session_id, workspace_id, prompt, reason, fire_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING *`,
        [
          input.id,
          input.sessionId,
          input.workspaceId,
          input.prompt,
          input.reason ?? null,
          fireAt,
        ],
      );

      if (rows.length === 0) {
        throw new Error('Failed to create session wakeup');
      }
      return rowToWakeup(rows[0]);
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
