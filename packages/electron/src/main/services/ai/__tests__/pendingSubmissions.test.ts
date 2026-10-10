// @vitest-environment node
/**
 * A composer prompt recorded before setup must survive a restart that happens
 * before the provider logs it, and must never be re-sent. Runs the recorded
 * metadata SQL (`metadata->>...`, the json merge) against real better-sqlite3,
 * where the dialect translation is what could break.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { createPGLiteSessionStore } from '../../PGLiteSessionStore';
import { createPendingSubmissionStore } from '../pendingSubmissions';

let tmpDir: string;
let sqlite: SQLiteDatabase;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-pending-'));
  sqlite = new SQLiteDatabase({
    dbDir: tmpDir,
    schemaDir: path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas'),
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  await sqlite.initialize();
});

afterEach(async () => {
  await sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(now: () => number) {
  const sessions = createPGLiteSessionStore(sqlite);
  let n = 0;
  return createPendingSubmissionStore(sqlite, (id, update) => sessions.updateMetadata(id, update), now, () => `sub-${++n}`);
}

async function addSession(id: string, draftInput: string | null) {
  await sqlite.query(
    `INSERT INTO ai_sessions (id, provider, workspace_id, draft_input, metadata) VALUES ($1, 'openai-codex', '/p', $2, $3)`,
    [id, draftInput, JSON.stringify({ phase: 'implementing' })],
  );
}

async function readSession(id: string) {
  const { rows } = await sqlite.query<{ draft_input: string | null; metadata: string }>(
    `SELECT draft_input, metadata FROM ai_sessions WHERE id = $1`,
    [id],
  );
  return { draftInput: rows[0].draft_input, metadata: JSON.parse(rows[0].metadata) };
}

it('restores an undelivered prompt to the draft after restart, and drops a delivered one', async () => {
  const submittedAt = Date.parse('2026-10-02T13:55:30.000Z');
  const store = makeStore(() => submittedAt);
  await addSession('stalled', null);
  await addSession('typed-since', 'half a thought');
  await addSession('delivered', null);

  await store.record('stalled', 'switch bullets back to dashes');
  await store.record('typed-since', 'investigate paused prompts');
  await store.record('delivered', 'already sent');
  // An input row from an earlier turn must not count as delivery.
  await sqlite.query(
    `INSERT INTO ai_agent_messages (session_id, created_at, source, direction, content) VALUES ('stalled', '2026-10-02T13:50:00.000Z', 'openai-codex', 'input', 'older prompt')`,
  );
  await sqlite.query(
    `INSERT INTO ai_agent_messages (session_id, created_at, source, direction, content) VALUES ('delivered', '2026-10-02T13:55:31.000Z', 'openai-codex', 'input', 'already sent')`,
  );

  const result = await store.recoverOnBoot();

  expect(result.delivered).toBe(1);
  expect(result.restored.map(plan => plan.sessionId).sort()).toEqual(['stalled', 'typed-since']);
  expect(await readSession('stalled')).toMatchObject({
    draftInput: 'switch bullets back to dashes',
    metadata: { phase: 'implementing' },
  });
  expect((await readSession('typed-since')).draftInput).toBe('half a thought\n\ninvestigate paused prompts');
  expect((await readSession('delivered')).draftInput).toBeNull();
  for (const id of ['stalled', 'typed-since', 'delivered']) {
    expect((await readSession(id)).metadata.pendingSubmission ?? null).toBeNull();
  }
  // A second launch finds nothing left to recover.
  expect(await store.recoverOnBoot()).toEqual({ delivered: 0, restored: [] });
});

it('clear() leaves a newer submission in place', async () => {
  const store = makeStore(() => 1_000);
  await addSession('s', null);
  const first = await store.record('s', 'first');
  const second = await store.record('s', 'second');

  await store.clear('s', first.id);
  expect((await readSession('s')).metadata.pendingSubmission).toMatchObject({ id: second.id, prompt: 'second' });

  await store.clear('s', second.id);
  expect((await readSession('s')).metadata.pendingSubmission ?? null).toBeNull();
});
