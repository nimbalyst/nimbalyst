// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { afterEach, describe, expect, it } from 'vitest';

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import {
  FeedbackRequestPersistence,
  type FeedbackRequestPersistenceDatabase,
} from '../FeedbackRequestPersistence';

const temporaryDirectories: string[] = [];

const target = {
  workspacePath: '/workspace/a',
  orgId: 'org-a',
  teamMemberId: asTeamMemberId('member-a'),
  requestId: 'request-a',
};

const state = {
  request: {
    id: 'request-a',
    urn: 'nimbalyst://feedback-request/request-a' as const,
    orgId: 'org-a',
    author: {
      kind: 'user' as const,
      userId: 'author-a',
      onBehalfOfUserId: 'author-a',
    },
    subjects: [],
    asks: [{
      type: 'confirm' as const,
      id: 'ask-a',
      label: 'Approve?',
      description: 'Approve the proposal.',
    }],
    recipients: [{ userId: 'recipient-a', name: 'Recipient A' }],
    assignments: [{
      askId: 'ask-a',
      target: { kind: 'user' as const, userId: 'recipient-a' },
    }],
    responses: [],
    discussion: [],
    lifecycle: { status: 'open' as const, changedAt: 1 },
    visibility: 'hiddenUntilAnswered' as const,
    wakePolicy: 'quorumOrClose' as const,
    quorum: { requiredRecipientCount: 1 },
    createdAt: 1,
    updatedAt: 1,
  },
  progress: {
    answeredAskCount: 0,
    totalAssignedAskCount: 1,
    answeredRecipientCount: 0,
    totalRecipientCount: 1,
    quorumReached: false,
  },
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('FeedbackRequestPersistence', () => {
  it('round-trips JSON sub-extractions on PGLite objects and SQLite JSON text', async () => {
    const pglite = new PGlite();
    await pglite.exec(`
      CREATE TABLE feedback_request_cache (
        workspace_path TEXT NOT NULL,
        org_id TEXT NOT NULL,
        viewer_user_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_path, org_id, viewer_user_id, request_id)
      )
    `);
    const pgliteDb: FeedbackRequestPersistenceDatabase = {
      query: (sql, params) => pglite.query(sql, params as never[]),
    };
    const pgliteStore = new FeedbackRequestPersistence(pgliteDb);
    await pgliteStore.save(target, state);
    await expect(pgliteStore.load(target)).resolves.toEqual(state);
    await pglite.close();

    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-cache-'));
    temporaryDirectories.push(dbDir);
    const sqlite = new SQLiteDatabase({
      dbDir,
      schemaDir: path.resolve(
        __dirname,
        '../../database/sqlite/schemas',
      ),
      slowQueryThresholdMs: 1_000,
      sampleRate: 0,
    });
    await sqlite.initialize();
    const sqliteStore = new FeedbackRequestPersistence(sqlite);
    await sqliteStore.save(target, state);
    await expect(sqliteStore.load(target)).resolves.toEqual(state);
    await sqlite.close();
  });
});
