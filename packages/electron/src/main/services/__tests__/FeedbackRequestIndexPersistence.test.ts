// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PGlite } from '@electric-sql/pglite';
import type { FeedbackRequestIndexEntry } from '@nimbalyst/collab-protocol';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { afterEach, describe, expect, it } from 'vitest';

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import {
  FeedbackRequestIndexPersistence,
  type FeedbackRequestIndexPersistenceDatabase,
} from '../FeedbackRequestIndexPersistence';

const temporaryDirectories: string[] = [];

const target = {
  workspacePath: '/workspace/a',
  orgId: 'org-a',
  teamMemberId: asTeamMemberId('member-a'),
};

function entry(
  requestId: string,
  updatedAt: number,
  subjects: FeedbackRequestIndexEntry['subjects'],
  title = requestId,
): FeedbackRequestIndexEntry {
  return {
    requestId,
    urn: `nimbalyst://feedback-request/${requestId}`,
    orgId: 'org-a',
    title,
    author: { kind: 'user', userId: 'author-a', onBehalfOfUserId: 'author-a' },
    recipients: [{ userId: 'member-a', name: 'Member A' }],
    lifecycle: { status: 'open', changedAt: updatedAt },
    progress: {
      answeredAskCount: 0,
      totalAssignedAskCount: 1,
      answeredRecipientCount: 0,
      totalRecipientCount: 1,
      quorumReached: false,
    },
    subjects,
    createdAt: 1,
    updatedAt,
  };
}

const documentSubject = {
  ref: { orgId: 'org-a', kind: 'document' as const, sourceId: 'doc-1' },
  label: 'Document One',
};
const trackerSubject = {
  ref: { orgId: 'org-a', kind: 'tracker' as const, sourceId: 'tracker-1' },
  label: 'Tracker One',
};

async function createPgliteStore(): Promise<{
  raw: PGlite;
  store: FeedbackRequestIndexPersistence;
  close: () => Promise<void>;
}> {
  const raw = new PGlite();
  await raw.exec(`
    CREATE TABLE feedback_request_index (
      workspace_path TEXT NOT NULL,
      org_id TEXT NOT NULL,
      viewer_user_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      closed_at TIMESTAMPTZ,
      snapshot_id TEXT,
      PRIMARY KEY (workspace_path, org_id, viewer_user_id, request_id)
    );
    CREATE TABLE feedback_request_index_backfill (
      workspace_path TEXT NOT NULL,
      org_id TEXT NOT NULL,
      viewer_user_id TEXT NOT NULL,
      cutoff_at TIMESTAMPTZ NOT NULL,
      cursor_request_id TEXT,
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (workspace_path, org_id, viewer_user_id)
    );
    CREATE TABLE feedback_request_cache (
      workspace_path TEXT NOT NULL,
      org_id TEXT NOT NULL,
      viewer_user_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (workspace_path, org_id, viewer_user_id, request_id)
    );
  `);
  const db: FeedbackRequestIndexPersistenceDatabase = {
    query: (sql, params) => raw.query(sql, params as never[]),
    runTransaction: async (statements) => {
      await raw.transaction(async (tx) => {
        for (const statement of statements) {
          await tx.query(statement.sql, statement.params as never[]);
        }
      });
    },
  };
  return {
    raw,
    store: new FeedbackRequestIndexPersistence(db),
    close: () => raw.close(),
  };
}

async function createSqliteStore(): Promise<{
  raw: SQLiteDatabase;
  store: FeedbackRequestIndexPersistence;
  close: () => Promise<void>;
}> {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-index-'));
  temporaryDirectories.push(dbDir);
  const raw = new SQLiteDatabase({
    dbDir,
    schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
    slowQueryThresholdMs: 1_000,
    sampleRate: 0,
  });
  await raw.initialize();
  return {
    raw,
    store: new FeedbackRequestIndexPersistence(raw),
    close: () => raw.close(),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('FeedbackRequestIndexPersistence', () => {
  it('batches idempotent snapshots, preserves newer broadcasts, and queries both subject kinds on both backends', async () => {
    const pglite = await createPgliteStore();
    const sqlite = await createSqliteStore();
    try {
      for (const { store } of [pglite, sqlite]) {
        const document = entry('request-doc', 10, [documentSubject]);
        const tracker = entry('request-tracker', 20, [trackerSubject]);
        await store.replaceSnapshot(target, [document, tracker]);
        await store.replaceSnapshot(target, [document, tracker]);
        expect((await store.list(target)).map((row) => row.requestId).sort())
          .toEqual(['request-doc', 'request-tracker']);

        await store.upsertEntries(target, [entry(
          'request-doc',
          30,
          [documentSubject],
          'Newest title',
        )]);
        await store.upsertEntries(target, [entry(
          'request-doc',
          25,
          [documentSubject],
          'Stale title',
        )]);
        expect((await store.list(target)).find((row) => row.requestId === 'request-doc')?.title)
          .toBe('Newest title');

        await expect(store.findBySubject(target, {
          kind: 'document', sourceId: 'doc-1',
        })).resolves.toEqual([expect.objectContaining({ requestId: 'request-doc' })]);
        await expect(store.findBySubject(target, {
          kind: 'tracker', sourceId: 'tracker-1',
        })).resolves.toEqual([expect.objectContaining({ requestId: 'request-tracker' })]);
      }

      const pgliteRaw = await pglite.raw.query<{ data: unknown }>(
        'SELECT data FROM feedback_request_index LIMIT 1',
      );
      const sqliteRaw = await sqlite.raw.query<{ data: unknown }>(
        'SELECT data FROM feedback_request_index LIMIT 1',
      );
      expect(typeof pgliteRaw.rows[0]?.data).toBe('object');
      expect(typeof sqliteRaw.rows[0]?.data).toBe('string');
      await expect(pglite.store.list(target)).resolves.toEqual(
        await sqlite.store.list(target),
      );

      const richRuntimeEntry = Object.assign(entry('request-rich', 40, []), {
        asks: [{ id: 'must-not-persist' }],
        responses: [{ requestId: 'request-rich', answer: 'must-not-persist' }],
      });
      await pglite.store.upsertEntries(target, [richRuntimeEntry]);
      await sqlite.store.upsertEntries(target, [richRuntimeEntry]);
      for (const raw of [pglite.raw, sqlite.raw]) {
        const stored = await raw.query<{ data: unknown }>(
          `SELECT data FROM feedback_request_index
            WHERE request_id = $1`,
          ['request-rich'],
        );
        const data = typeof stored.rows[0]?.data === 'string'
          ? JSON.parse(stored.rows[0].data)
          : stored.rows[0]?.data;
        expect(data).not.toHaveProperty('asks');
        expect(data).not.toHaveProperty('responses');
      }
    } finally {
      await pglite.close();
      await sqlite.close();
    }
  });
});
