import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EncryptedTrackerItemEnvelope, TrackerItemPayload } from '@nimbalyst/runtime/sync';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { TrackerPGLiteStore } from '../TrackerPGLiteStore';

const WORKSPACE = '/ws/shared';
const COMMENTS = [
  {
    id: 'comment-1',
    authorIdentity: { email: 'alice@example.com', displayName: 'Alice', gitName: null, gitEmail: null },
    body: 'persists',
    createdAt: 1,
  },
];
const ACTIVITY = [
  {
    id: 'activity-1',
    authorIdentity: { email: 'alice@example.com', displayName: 'Alice', gitName: null, gitEmail: null },
    action: 'commented' as const,
    timestamp: 1,
  },
];
const SECOND_COMMENT = {
  id: 'comment-2',
  authorIdentity: { email: 'bob@example.com', displayName: 'Bob', gitName: null, gitEmail: null },
  body: 'also persists',
  createdAt: 2,
};
const SECOND_ACTIVITY = {
  id: 'activity-2',
  authorIdentity: { email: 'bob@example.com', displayName: 'Bob', gitName: null, gitEmail: null },
  action: 'status_changed' as const,
  field: 'status',
  oldValue: 'to-do',
  newValue: 'in-progress',
  timestamp: 2,
};
const LINKED_PULL_REQUESTS = [{ remote: 'nimbalyst/nimbalyst', number: 42 }];

function payload(): TrackerItemPayload {
  return {
    itemId: 'bug-1',
    primaryType: 'bug',
    archived: false,
    bodyVersion: 0,
    fields: { title: 'Shared bug', status: 'to-do' },
    labels: {},
    comments: COMMENTS,
    activity: ACTIVITY,
    system: { linkedPullRequests: LINKED_PULL_REQUESTS },
  };
}

function envelope(syncId = 1): EncryptedTrackerItemEnvelope {
  return {
    itemId: 'bug-1',
    syncId,
    encryptedPayload: 'encrypted',
    iv: 'iv',
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    orgKeyFingerprint: null,
  };
}

function parseData(value: unknown): Record<string, unknown> {
  return typeof value === 'string' ? JSON.parse(value) : value as Record<string, unknown>;
}

async function expectSystemCollections(db: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }) {
  const result = await db.query<{ data: unknown }>('SELECT data FROM tracker_items WHERE id = $1', ['bug-1']);
  const data = parseData(result.rows[0].data);
  expect(data.comments).toEqual(COMMENTS);
  expect(data.activity).toEqual(ACTIVITY);
  expect(data.linkedPullRequests).toEqual(LINKED_PULL_REQUESTS);
}

describe('TrackerPGLiteStore system metadata projection (PGLite)', () => {
  let db: PGlite;
  let store: TrackerPGLiteStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE tracker_items (
        id TEXT PRIMARY KEY,
        issue_number INTEGER,
        issue_key TEXT,
        type TEXT NOT NULL,
        data JSONB NOT NULL,
        workspace TEXT NOT NULL,
        document_path TEXT,
        line_number INTEGER,
        content JSONB,
        archived BOOLEAN NOT NULL DEFAULT FALSE,
        source TEXT DEFAULT 'inline',
        source_ref TEXT,
        type_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        sync_status TEXT DEFAULT 'local',
        sync_id BIGINT,
        body_version INTEGER NOT NULL DEFAULT 0,
        deleted_at TIMESTAMPTZ,
        created TIMESTAMPTZ DEFAULT NOW(),
        updated TIMESTAMPTZ DEFAULT NOW(),
        last_indexed TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    store = new TrackerPGLiteStore(db as any, WORKSPACE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('preserves collections through applyRemoteItem', async () => {
    await store.applyRemoteItem(envelope(), payload());
    await expectSystemCollections(db as any);
  });

  it('preserves collections through applyOptimistic', async () => {
    await store.applyOptimistic('bug-1', payload());
    await expectSystemCollections(db as any);
  });

  it('does not let an older remote payload erase activity or pull request links', async () => {
    await store.applyRemoteItem(envelope(), payload());
    const legacyPayload = payload();
    delete legacyPayload.activity;
    delete legacyPayload.system.linkedPullRequests;
    await store.applyRemoteItem(envelope(2), legacyPayload);
    await expectSystemCollections(db as any);
  });

  it('merges comments and activity when a stale echo lands after a newer local snapshot', async () => {
    const newerPayload = payload();
    newerPayload.comments = [...COMMENTS, SECOND_COMMENT];
    newerPayload.activity = [...ACTIVITY, SECOND_ACTIVITY];
    await store.applyRemoteItem(envelope(), newerPayload);
    await store.applyRemoteItem(envelope(2), payload());

    const result = await db.query<{ data: unknown }>('SELECT data FROM tracker_items WHERE id = $1', ['bug-1']);
    const data = parseData(result.rows[0].data);
    expect(data.comments).toEqual([...COMMENTS, SECOND_COMMENT]);
    expect(data.activity).toEqual([...ACTIVITY, SECOND_ACTIVITY]);
  });
});

describe('TrackerPGLiteStore system metadata projection (SQLite)', () => {
  let tmpDir: string;
  let db: SQLiteDatabase;
  let store: TrackerPGLiteStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-tracker-system-'));
    db = new SQLiteDatabase({
      dbDir: tmpDir,
      schemaDir: path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas'),
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await db.initialize();
    store = new TrackerPGLiteStore(db as any, WORKSPACE);
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves collections through applyRemoteItem', async () => {
    await store.applyRemoteItem(envelope(), payload());
    await expectSystemCollections(db as any);
  });

  it('preserves collections through applyOptimistic', async () => {
    await store.applyOptimistic('bug-1', payload());
    await expectSystemCollections(db as any);
  });

  it('does not let an older optimistic payload erase activity or pull request links', async () => {
    await store.applyRemoteItem(envelope(), payload());
    const legacyPayload = payload();
    delete legacyPayload.activity;
    delete legacyPayload.system.linkedPullRequests;
    await store.applyOptimistic('bug-1', legacyPayload);
    await expectSystemCollections(db as any);
  });

  it('merges comments and activity when a stale echo lands after a newer local snapshot', async () => {
    const newerPayload = payload();
    newerPayload.comments = [...COMMENTS, SECOND_COMMENT];
    newerPayload.activity = [...ACTIVITY, SECOND_ACTIVITY];
    await store.applyRemoteItem(envelope(), newerPayload);
    await store.applyRemoteItem(envelope(2), payload());

    const result = await db.query<{ data: unknown }>('SELECT data FROM tracker_items WHERE id = $1', ['bug-1']);
    const data = parseData(result.rows[0].data);
    expect(data.comments).toEqual([...COMMENTS, SECOND_COMMENT]);
    expect(data.activity).toEqual([...ACTIVITY, SECOND_ACTIVITY]);
  });
});
