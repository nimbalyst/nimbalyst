import type {
  FeedbackRequestProgress,
  FeedbackRequestReadModel,
} from '@nimbalyst/collab-protocol';
import type { FeedbackRequestSyncState } from '@nimbalyst/runtime/sync';
import type { TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import { database } from '../database/PGLiteDatabaseWorker';

export interface FeedbackRequestPersistenceTarget {
  workspacePath: string;
  orgId: string;
  teamMemberId: TeamMemberId;
  requestId: string;
}

export interface FeedbackRequestPersistenceDatabase {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface FeedbackRequestCacheRow {
  request: unknown;
  progress: unknown;
}

export function parseJsonSubfield<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

/** Dual-backend persistence for the latest server-projected request state. */
export class FeedbackRequestPersistence {
  constructor(
    private readonly db: FeedbackRequestPersistenceDatabase = database,
  ) {}

  async load(
    target: FeedbackRequestPersistenceTarget,
  ): Promise<FeedbackRequestSyncState | null> {
    const { rows } = await this.db.query<FeedbackRequestCacheRow>(
      `SELECT data->'request' AS request, data->'progress' AS progress
         FROM feedback_request_cache
        WHERE workspace_path = $1 AND org_id = $2
          AND viewer_user_id = $3 AND request_id = $4`,
      [
        target.workspacePath,
        target.orgId,
        target.teamMemberId,
        target.requestId,
      ],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      request: parseJsonSubfield<FeedbackRequestReadModel>(row.request),
      progress: parseJsonSubfield<FeedbackRequestProgress>(row.progress),
    };
  }

  async save(
    target: FeedbackRequestPersistenceTarget,
    state: FeedbackRequestSyncState,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO feedback_request_cache
         (workspace_path, org_id, viewer_user_id, request_id, data, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       ON CONFLICT (workspace_path, org_id, viewer_user_id, request_id) DO UPDATE SET
         data = EXCLUDED.data,
         updated_at = EXCLUDED.updated_at`,
      [
        target.workspacePath,
        target.orgId,
        target.teamMemberId,
        target.requestId,
        JSON.stringify(state),
      ],
    );
  }
}
