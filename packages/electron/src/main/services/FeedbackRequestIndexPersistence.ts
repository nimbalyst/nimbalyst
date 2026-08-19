import { randomUUID } from 'crypto';

import {
  feedbackRequestUrn,
  normalizeFeedbackArtifact,
  type Actor,
  type FeedbackRequestIndexEntry,
  type FeedbackRequestLifecycle,
  type FeedbackRequestProgress,
} from '@nimbalyst/collab-protocol';

import {
  feedbackRequestIndexEntryHasSubject,
  type FeedbackRequestIndexViewerTarget,
  type FeedbackRequestSubjectRef,
} from '../../shared/feedbackRequestIndex';
import { database } from '../database/PGLiteDatabaseWorker';
import { toMillis } from '../utils/timestampUtils';

const SNAPSHOT_BATCH_SIZE = 250;

export interface FeedbackRequestIndexPersistenceDatabase {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  runTransaction(
    statements: Array<{ sql: string; params?: unknown[] }>,
  ): Promise<void>;
}

interface FeedbackRequestIndexRow {
  request_id: string;
  data: unknown;
  created_at: unknown;
  updated_at: unknown;
  closed_at: unknown;
}

export interface FeedbackRequestIndexBackfillState {
  cutoffAt: number;
  cursorRequestId?: string;
  completedAt?: number;
}

interface FeedbackRequestIndexBackfillRow {
  cutoff_at: unknown;
  cursor_request_id: string | null;
  completed_at: unknown;
}

function parseJsonColumn<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function defaultLifecycle(updatedAt: number): FeedbackRequestLifecycle {
  return { status: 'open', changedAt: updatedAt };
}

function defaultProgress(): FeedbackRequestProgress {
  return {
    answeredAskCount: 0,
    totalAssignedAskCount: 0,
    answeredRecipientCount: 0,
    totalRecipientCount: 0,
    quorumReached: false,
  };
}

function defaultActor(): Actor {
  return { kind: 'user', onBehalfOfUserId: '' };
}

function normalizeLifecycle(
  lifecycle: Partial<FeedbackRequestLifecycle> | undefined,
  updatedAt: number,
): FeedbackRequestLifecycle {
  const defaults = defaultLifecycle(updatedAt);
  return {
    status: lifecycle?.status ?? defaults.status,
    changedAt: lifecycle?.changedAt ?? defaults.changedAt,
  };
}

function normalizeProgress(
  progress: Partial<FeedbackRequestProgress> | undefined,
): FeedbackRequestProgress {
  const defaults = defaultProgress();
  return {
    answeredAskCount: progress?.answeredAskCount ?? defaults.answeredAskCount,
    totalAssignedAskCount: progress?.totalAssignedAskCount
      ?? defaults.totalAssignedAskCount,
    answeredRecipientCount: progress?.answeredRecipientCount
      ?? defaults.answeredRecipientCount,
    totalRecipientCount: progress?.totalRecipientCount
      ?? defaults.totalRecipientCount,
    quorumReached: progress?.quorumReached ?? defaults.quorumReached,
  };
}

function normalizeActor(actor: Partial<Actor> | undefined): Actor {
  const defaults = defaultActor();
  return {
    ...actor,
    kind: actor?.kind ?? defaults.kind,
    onBehalfOfUserId: actor?.onBehalfOfUserId ?? defaults.onBehalfOfUserId,
  };
}

/** Normalize whole-column JSON from either PGLite objects or SQLite text. */
export function feedbackRequestIndexEntryFromRow(
  row: FeedbackRequestIndexRow,
  target: FeedbackRequestIndexViewerTarget,
): FeedbackRequestIndexEntry {
  const stored = parseJsonColumn<Partial<FeedbackRequestIndexEntry>>(row.data) ?? {};
  const createdAt = toMillis(row.created_at) ?? stored.createdAt ?? 0;
  const updatedAt = toMillis(row.updated_at) ?? stored.updatedAt ?? createdAt;
  const closedAt = toMillis(row.closed_at) ?? stored.closedAt ?? undefined;
  return {
    requestId: stored.requestId ?? row.request_id,
    urn: stored.urn ?? feedbackRequestUrn(stored.requestId ?? row.request_id),
    orgId: stored.orgId ?? target.orgId,
    title: stored.title ?? '',
    author: normalizeActor(stored.author),
    recipients: (stored.recipients ?? []).map((recipient) => ({
      userId: recipient.userId ?? '',
      name: recipient.name ?? recipient.userId ?? '',
    })),
    lifecycle: normalizeLifecycle(stored.lifecycle, updatedAt),
    progress: normalizeProgress(stored.progress),
    subjects: (stored.subjects ?? []).map(normalizeFeedbackArtifact),
    createdAt,
    updatedAt,
    ...(closedAt === undefined ? {} : { closedAt }),
  };
}

function targetParams(target: FeedbackRequestIndexViewerTarget): unknown[] {
  return [target.workspacePath, target.orgId, target.teamMemberId];
}

/** Persist only the metadata projection, even if an IPC/wire object has extras. */
function feedbackRequestIndexEntryForStorage(
  entry: FeedbackRequestIndexEntry,
): FeedbackRequestIndexEntry {
  return {
    requestId: entry.requestId,
    urn: entry.urn,
    orgId: entry.orgId,
    title: entry.title,
    author: {
      kind: entry.author.kind,
      onBehalfOfUserId: entry.author.onBehalfOfUserId,
      ...(entry.author.userId === undefined ? {} : { userId: entry.author.userId }),
      ...(entry.author.sessionId === undefined ? {} : { sessionId: entry.author.sessionId }),
      ...(entry.author.sessionName === undefined ? {} : { sessionName: entry.author.sessionName }),
    },
    recipients: entry.recipients.map(({ userId, name }) => ({ userId, name })),
    lifecycle: {
      status: entry.lifecycle.status,
      changedAt: entry.lifecycle.changedAt,
    },
    progress: {
      answeredAskCount: entry.progress.answeredAskCount,
      totalAssignedAskCount: entry.progress.totalAssignedAskCount,
      answeredRecipientCount: entry.progress.answeredRecipientCount,
      totalRecipientCount: entry.progress.totalRecipientCount,
      quorumReached: entry.progress.quorumReached,
    },
    subjects: entry.subjects.map((subject) => ({
      label: subject.label,
      ...(subject.context === undefined ? {} : { context: subject.context }),
      ref: {
        orgId: subject.ref.orgId,
        kind: subject.ref.kind,
        sourceId: subject.ref.sourceId,
        ...(subject.ref.projectId === undefined
          ? {}
          : { projectId: subject.ref.projectId }),
        ...(subject.ref.messageId === undefined
          ? {}
          : { messageId: subject.ref.messageId }),
      },
    })),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.closedAt === undefined ? {} : { closedAt: entry.closedAt }),
  };
}

function buildUpsertStatement(
  target: FeedbackRequestIndexViewerTarget,
  entries: readonly FeedbackRequestIndexEntry[],
  snapshotId?: string,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const values = entries.map((entry) => {
    const projected = feedbackRequestIndexEntryForStorage(entry);
    const offset = params.length;
    params.push(
      target.workspacePath,
      target.orgId,
      target.teamMemberId,
      entry.requestId,
      JSON.stringify(projected),
      new Date(projected.createdAt),
      new Date(projected.updatedAt),
      projected.closedAt == null ? null : new Date(projected.closedAt),
      snapshotId ?? null,
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::jsonb, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`;
  });
  return {
    sql: `INSERT INTO feedback_request_index
            (workspace_path, org_id, viewer_user_id, request_id, data,
             created_at, updated_at, closed_at, snapshot_id)
          VALUES ${values.join(', ')}
          ON CONFLICT (workspace_path, org_id, viewer_user_id, request_id) DO UPDATE SET
            data = CASE
              WHEN EXCLUDED.updated_at >= feedback_request_index.updated_at
              THEN EXCLUDED.data ELSE feedback_request_index.data END,
            created_at = CASE
              WHEN EXCLUDED.updated_at >= feedback_request_index.updated_at
              THEN EXCLUDED.created_at ELSE feedback_request_index.created_at END,
            updated_at = CASE
              WHEN EXCLUDED.updated_at >= feedback_request_index.updated_at
              THEN EXCLUDED.updated_at ELSE feedback_request_index.updated_at END,
            closed_at = CASE
              WHEN EXCLUDED.updated_at >= feedback_request_index.updated_at
              THEN EXCLUDED.closed_at ELSE feedback_request_index.closed_at END,
            snapshot_id = COALESCE(EXCLUDED.snapshot_id, feedback_request_index.snapshot_id)`,
    params,
  };
}

/** Durable local cache of participant-filtered team-room feedback index rows. */
export class FeedbackRequestIndexPersistence {
  constructor(
    private readonly db: FeedbackRequestIndexPersistenceDatabase = database,
  ) {}

  async replaceSnapshot(
    target: FeedbackRequestIndexViewerTarget,
    entries: readonly FeedbackRequestIndexEntry[],
  ): Promise<void> {
    const snapshotId = randomUUID();
    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    for (let offset = 0; offset < entries.length; offset += SNAPSHOT_BATCH_SIZE) {
      statements.push(buildUpsertStatement(
        target,
        entries.slice(offset, offset + SNAPSHOT_BATCH_SIZE),
        snapshotId,
      ));
    }
    statements.push({
      sql: `DELETE FROM feedback_request_index
             WHERE workspace_path = $1 AND org_id = $2 AND viewer_user_id = $3
               AND (snapshot_id IS NULL OR snapshot_id <> $4)`,
      params: [...targetParams(target), snapshotId],
    });
    await this.db.runTransaction(statements);
  }

  async upsertEntries(
    target: FeedbackRequestIndexViewerTarget,
    entries: readonly FeedbackRequestIndexEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const statements = [];
    for (let offset = 0; offset < entries.length; offset += SNAPSHOT_BATCH_SIZE) {
      statements.push(buildUpsertStatement(
        target,
        entries.slice(offset, offset + SNAPSHOT_BATCH_SIZE),
      ));
    }
    await this.db.runTransaction(statements);
  }

  async list(
    target: FeedbackRequestIndexViewerTarget,
  ): Promise<FeedbackRequestIndexEntry[]> {
    const { rows } = await this.db.query<FeedbackRequestIndexRow>(
      `SELECT request_id, data, created_at, updated_at, closed_at
         FROM feedback_request_index
        WHERE workspace_path = $1 AND org_id = $2 AND viewer_user_id = $3
        ORDER BY updated_at DESC, request_id ASC`,
      targetParams(target),
    );
    return rows.map((row) => feedbackRequestIndexEntryFromRow(row, target));
  }

  async findBySubject(
    target: FeedbackRequestIndexViewerTarget,
    subject: FeedbackRequestSubjectRef,
  ): Promise<FeedbackRequestIndexEntry[]> {
    const entries = await this.list(target);
    return entries.filter((entry) => feedbackRequestIndexEntryHasSubject(entry, subject));
  }

  async getOrCreateBackfillState(
    target: FeedbackRequestIndexViewerTarget,
  ): Promise<FeedbackRequestIndexBackfillState> {
    await this.db.query(
      `INSERT INTO feedback_request_index_backfill
         (workspace_path, org_id, viewer_user_id, cutoff_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (workspace_path, org_id, viewer_user_id) DO NOTHING`,
      targetParams(target),
    );
    const { rows } = await this.db.query<FeedbackRequestIndexBackfillRow>(
      `SELECT cutoff_at, cursor_request_id, completed_at
         FROM feedback_request_index_backfill
        WHERE workspace_path = $1 AND org_id = $2 AND viewer_user_id = $3`,
      targetParams(target),
    );
    const row = rows[0];
    if (!row) throw new Error('Feedback request index backfill state was not created');
    return {
      cutoffAt: toMillis(row.cutoff_at) ?? Date.now(),
      ...(row.cursor_request_id ? { cursorRequestId: row.cursor_request_id } : {}),
      ...(toMillis(row.completed_at) == null
        ? {}
        : { completedAt: toMillis(row.completed_at)! }),
    };
  }

  async getBackfillBatch(
    target: FeedbackRequestIndexViewerTarget,
    state: FeedbackRequestIndexBackfillState,
    limit: number,
  ): Promise<string[]> {
    const { rows } = await this.db.query<{ request_id: string }>(
      `SELECT request_id
         FROM feedback_request_cache
        WHERE workspace_path = $1 AND org_id = $2 AND viewer_user_id = $3
          AND updated_at <= $4 AND request_id > $5
        ORDER BY request_id ASC
        LIMIT $6`,
      [
        ...targetParams(target),
        new Date(state.cutoffAt),
        state.cursorRequestId ?? '',
        limit,
      ],
    );
    return rows.map((row) => row.request_id);
  }

  async advanceBackfillCursor(
    target: FeedbackRequestIndexViewerTarget,
    requestId: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE feedback_request_index_backfill
          SET cursor_request_id = $4
        WHERE workspace_path = $1 AND org_id = $2 AND viewer_user_id = $3
          AND completed_at IS NULL`,
      [...targetParams(target), requestId],
    );
  }

  async completeBackfill(
    target: FeedbackRequestIndexViewerTarget,
  ): Promise<void> {
    await this.db.query(
      `UPDATE feedback_request_index_backfill
          SET completed_at = COALESCE(completed_at, NOW())
        WHERE workspace_path = $1 AND org_id = $2 AND viewer_user_id = $3`,
      targetParams(target),
    );
  }
}
