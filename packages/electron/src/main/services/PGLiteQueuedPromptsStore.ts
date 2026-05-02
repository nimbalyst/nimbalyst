/**
 * PGLite implementation of QueuedPromptsStore
 *
 * Stores prompts queued from any device for execution.
 * Uses simple row-level atomic updates instead of JSONB array manipulation.
 */

export interface QueuedPrompt {
  id: string;
  sessionId: string;
  prompt: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  attachments?: any[];
  documentContext?: {
    filePath?: string;
    content?: string;
    fileType?: string;
  };
  createdAt: number;  // epoch ms
  claimedAt?: number; // epoch ms
  completedAt?: number; // epoch ms
  errorMessage?: string;
}

export interface CreateQueuedPromptInput {
  id: string;
  sessionId: string;
  prompt: string;
  attachments?: any[];
  documentContext?: {
    filePath?: string;
    content?: string;
    fileType?: string;
  };
}

export interface QueuedPromptsStore {
  /** Create a new queued prompt */
  create(input: CreateQueuedPromptInput): Promise<QueuedPrompt>;

  /** Get a specific queued prompt by ID */
  get(id: string): Promise<QueuedPrompt | null>;

  /** List all queued prompts for a session */
  listForSession(sessionId: string, options?: { includeCompleted?: boolean }): Promise<QueuedPrompt[]>;

  /** List pending prompts for a session (ready to execute) */
  listPending(sessionId: string): Promise<QueuedPrompt[]>;

  /**
   * Atomically claim a pending prompt for execution.
   * Returns the prompt if successfully claimed, null if already claimed or not found.
   * This is the key atomic operation that prevents duplicate execution.
   */
  claim(id: string): Promise<QueuedPrompt | null>;

  /** Mark a prompt as completed */
  complete(id: string): Promise<void>;

  /** Mark a prompt as failed with an error message */
  fail(id: string, errorMessage: string): Promise<void>;

  /** Delete a queued prompt */
  delete(id: string): Promise<void>;

  /** Delete all completed/failed prompts older than a certain age */
  cleanup(olderThanMs: number): Promise<number>;
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

function rowToQueuedPrompt(row: any): QueuedPrompt {
  // Parse JSONB fields
  let attachments = row.attachments;
  if (typeof attachments === 'string') {
    try {
      attachments = JSON.parse(attachments);
    } catch {
      attachments = undefined;
    }
  }

  let documentContext = row.document_context;
  if (typeof documentContext === 'string') {
    try {
      documentContext = JSON.parse(documentContext);
    } catch {
      documentContext = undefined;
    }
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    prompt: row.prompt,
    status: row.status,
    attachments,
    documentContext,
    createdAt: toMillis(row.created_at),
    claimedAt: row.claimed_at ? toMillis(row.claimed_at) : undefined,
    completedAt: row.completed_at ? toMillis(row.completed_at) : undefined,
    errorMessage: row.error_message || undefined,
  };
}

export function createPGLiteQueuedPromptsStore(
  db: PGliteLike,
  ensureDbReady?: EnsureReadyFn
): QueuedPromptsStore {
  const ensureReady = async () => {
    if (ensureDbReady) {
      await ensureDbReady();
    }
  };

  return {
    async create(input: CreateQueuedPromptInput): Promise<QueuedPrompt> {
      await ensureReady();

      const { rows } = await db.query<any>(
        `INSERT INTO queued_prompts (id, session_id, prompt, attachments, document_context)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          input.id,
          input.sessionId,
          input.prompt,
          input.attachments ? JSON.stringify(input.attachments) : null,
          input.documentContext ? JSON.stringify(input.documentContext) : null,
        ]
      );

      if (rows.length === 0) {
        throw new Error('Failed to create queued prompt');
      }

      console.log(`[QueuedPromptsStore] Created prompt ${input.id} for session ${input.sessionId}`);
      return rowToQueuedPrompt(rows[0]);
    },

    async get(id: string): Promise<QueuedPrompt | null> {
      await ensureReady();

      const { rows } = await db.query<any>(
        `SELECT * FROM queued_prompts WHERE id = $1`,
        [id]
      );

      return rows.length > 0 ? rowToQueuedPrompt(rows[0]) : null;
    },

    async listForSession(
      sessionId: string,
      options?: { includeCompleted?: boolean }
    ): Promise<QueuedPrompt[]> {
      await ensureReady();

      const includeCompleted = options?.includeCompleted ?? false;

      let query = `SELECT * FROM queued_prompts WHERE session_id = $1`;
      if (!includeCompleted) {
        query += ` AND status NOT IN ('completed', 'failed')`;
      }
      query += ` ORDER BY created_at ASC`;

      const { rows } = await db.query<any>(query, [sessionId]);
      return rows.map(rowToQueuedPrompt);
    },

    async listPending(sessionId: string): Promise<QueuedPrompt[]> {
      await ensureReady();

      const { rows } = await db.query<any>(
        `SELECT * FROM queued_prompts
         WHERE session_id = $1 AND status = 'pending'
         ORDER BY created_at ASC`,
        [sessionId]
      );

      return rows.map(rowToQueuedPrompt);
    },

    async claim(id: string): Promise<QueuedPrompt | null> {
      await ensureReady();

      // ATOMIC: Only update if status is still 'pending'
      // This is the key operation that prevents duplicate execution
      const { rows } = await db.query<any>(
        `UPDATE queued_prompts
         SET status = 'executing', claimed_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id]
      );

      if (rows.length === 0) {
        console.log(`[QueuedPromptsStore] claim: prompt ${id} not found or already claimed`);
        return null;
      }

      console.log(`[QueuedPromptsStore] claim: successfully claimed prompt ${id}`);
      return rowToQueuedPrompt(rows[0]);
    },

    async complete(id: string): Promise<void> {
      await ensureReady();

      await db.query(
        `UPDATE queued_prompts
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id]
      );

      // console.log(`[QueuedPromptsStore] Marked prompt ${id} as completed`);
    },

    async fail(id: string, errorMessage: string): Promise<void> {
      await ensureReady();

      await db.query(
        `UPDATE queued_prompts
         SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_message = $2
         WHERE id = $1`,
        [id, errorMessage]
      );

      console.log(`[QueuedPromptsStore] Marked prompt ${id} as failed: ${errorMessage}`);
    },

    async delete(id: string): Promise<void> {
      await ensureReady();

      await db.query(
        `DELETE FROM queued_prompts WHERE id = $1`,
        [id]
      );

      console.log(`[QueuedPromptsStore] Deleted prompt ${id}`);
    },

    async cleanup(olderThanMs: number): Promise<number> {
      await ensureReady();

      const cutoffDate = new Date(Date.now() - olderThanMs);

      const { rows } = await db.query<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM queued_prompts
           WHERE status IN ('completed', 'failed')
             AND completed_at < $1
           RETURNING 1
         )
         SELECT COUNT(*) as count FROM deleted`,
        [cutoffDate]
      );

      const count = parseInt(rows[0]?.count || '0', 10);
      if (count > 0) {
        console.log(`[QueuedPromptsStore] Cleaned up ${count} old prompts`);
      }

      return count;
    },
  };
}
