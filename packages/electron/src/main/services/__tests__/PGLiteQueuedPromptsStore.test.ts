import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPGLiteQueuedPromptsStore,
  SWEEP_UNANSWERED_ERROR,
} from '../PGLiteQueuedPromptsStore';

const databases: PGlite[] = [];

async function createDatabase(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE ai_sessions (
      id TEXT PRIMARY KEY,
      metadata JSONB
    );
    CREATE TABLE queued_prompts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attachments JSONB,
      document_context JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      claimed_at TIMESTAMPTZ,
      claim_token TEXT,
      dispatch_started_at TIMESTAMPTZ,
      settlement_provenance TEXT,
      completed_at TIMESTAMPTZ,
      error_message TEXT,
      delivery_class TEXT NOT NULL DEFAULT 'ordinary',
      priority_rank INTEGER NOT NULL DEFAULT 0,
      delivery_ready BOOLEAN NOT NULL DEFAULT TRUE,
      producer TEXT,
      idempotency_key TEXT,
      request_digest TEXT,
      control_operation TEXT,
      interrupt_target_generation TEXT,
      interrupt_reservation_owner TEXT,
      interrupt_receipt JSONB,
      client_submission_id TEXT UNIQUE,
      source_session_id TEXT,
      source_room_id TEXT,
      submission_sequence INTEGER,
      payload_utf8_bytes INTEGER,
      payload_unicode_scalars INTEGER,
      payload_sha256 TEXT,
      claim_trigger TEXT,
      claim_triggered_at TIMESTAMPTZ,
      turn_id TEXT,
      provider_input_message_id TEXT,
      provider_output_message_id TEXT,
      stream_event_sequence INTEGER NOT NULL DEFAULT 0,
      terminal_status TEXT,
      terminal_at TIMESTAMPTZ
    );
    CREATE TABLE ai_agent_messages (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      source TEXT NOT NULL,
      direction TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE queued_prompt_source_sequences (
      source_session_id TEXT PRIMARY KEY,
      next_sequence INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_queued_prompts_interrupt_generation_owner
      ON queued_prompts(session_id, interrupt_target_generation)
      WHERE delivery_class = 'control' AND interrupt_target_generation IS NOT NULL;
    CREATE UNIQUE INDEX idx_queued_prompts_control_idempotency
      ON queued_prompts(session_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    INSERT INTO ai_sessions (id, metadata) VALUES
      ('session-a', '{}'::jsonb),
      ('session-b', '{}'::jsonb),
      ('blocked', '{"modelChangeReconciliation":{"status":"pending"}}'::jsonb),
      ('malformed', '[]'::jsonb);
  `);
  return db;
}

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.close();
});

describe('PGLiteQueuedPromptsStore dispatch fencing', () => {
  it('retries a transient dialect probe and generates a persisted opaque claim token', async () => {
    let unavailable = true;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('UPDATE queued_prompts')) {
        return {
          rows: [{
            id: 'retry', session_id: 'session-a', prompt: 'once', status: 'executing',
            created_at: new Date(), claimed_at: new Date(), claim_token: params?.[2],
            delivery_class: 'ordinary', priority_rank: 0, delivery_ready: true,
          }],
        };
      }
      if (sql.includes('jsonb_typeof')) {
        if (unavailable) throw new Error('database unavailable');
        return { rows: [{ kind: 'object' }] };
      }
      if (sql.includes('json_valid')) throw new Error('database unavailable');
      throw new Error(`Unexpected query: ${sql}`);
    });
    const store = createPGLiteQueuedPromptsStore({ query } as any);

    await expect(store.claim('retry', 'session-a')).rejects.toThrow('database unavailable');
    unavailable = false;
    const claimed = await store.claim('retry', 'session-a');
    expect(claimed?.claimToken).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('prevents stale owner A from mutating replacement owner B', async () => {
    const db = await createDatabase();
    const store = createPGLiteQueuedPromptsStore(db as any);
    await store.create({ id: 'race', sessionId: 'session-a', prompt: 'race' });

    const ownerA = await store.claim('race', 'session-a');
    expect(ownerA?.claimToken).toBeTruthy();
    expect(await store.sweepExecutingForSession('session-a')).toMatchObject({
      failed: 0,
      rolledBack: 1,
      rolledBackIds: ['race'],
    });
    expect((await store.get('race'))?.claimToken).toBeUndefined();

    const ownerB = await store.claim('race', 'session-a');
    expect(ownerB?.claimToken).toBeTruthy();
    expect(ownerB?.claimToken).not.toBe(ownerA?.claimToken);
    await expect(
      store.completeAfterDispatch('race', 'session-a', ownerA!.claimToken!),
    ).resolves.toMatchObject({ outcome: 'stale_owner' });
    await expect(
      store.failAfterDispatch('race', 'late A', 'session-a', ownerA!.claimToken!),
    ).resolves.toMatchObject({ outcome: 'stale_owner' });
    await expect(
      store.beginDispatch('race', 'session-a', ownerB!.claimToken!),
    ).resolves.toMatchObject({ outcome: 'settled' });
    await expect(
      store.completeAfterDispatch('race', 'session-a', ownerB!.claimToken!),
    ).resolves.toMatchObject({ outcome: 'settled' });
    await expect(
      store.completeAfterDispatch('race', 'session-a', ownerB!.claimToken!),
    ).resolves.toMatchObject({ outcome: 'idempotent_same_claim' });
  });

  it('classifies wrong identity, recovery, and terminal conflicts without mutation', async () => {
    const db = await createDatabase();
    const store = createPGLiteQueuedPromptsStore(db as any);
    await store.create({ id: 'owned', sessionId: 'session-a', prompt: 'owned' });
    const claim = await store.claim('owned', 'session-a');
    const token = claim!.claimToken!;
    await expect(store.beginDispatch('owned', 'session-a', token)).resolves.toMatchObject({
      outcome: 'settled',
    });
    await expect(store.completeAfterDispatch('owned', 'session-b', token)).resolves.toMatchObject({
      outcome: 'stale_owner',
    });
    await expect(store.completeAfterDispatch('owned', 'session-a', 'random')).resolves.toMatchObject({
      outcome: 'stale_owner',
    });

    await db.query(
      `UPDATE ai_sessions
       SET metadata = '{"modelChangeReconciliation":{"status":"pending"}}'::jsonb
       WHERE id = $1`,
      ['session-a'],
    );
    await expect(store.completeAfterDispatch('owned', 'session-a', token)).resolves.toMatchObject({
      outcome: 'recovery_blocked',
    });
    await db.query(`UPDATE ai_sessions SET metadata = '{}'::jsonb WHERE id = $1`, ['session-a']);

    await expect(
      store.failAfterDispatch('owned', SWEEP_UNANSWERED_ERROR, 'session-a', token),
    ).resolves.toMatchObject({ outcome: 'settled' });
    await expect(store.completeAfterDispatch('owned', 'session-a', token)).resolves.toMatchObject({
      outcome: 'terminal_conflict',
    });
    await expect(
      store.failAfterDispatch('owned', 'different duplicate text', 'session-a', token),
    ).resolves.toMatchObject({ outcome: 'idempotent_same_claim' });
    await expect(store.get('owned')).resolves.toMatchObject({
      status: 'failed',
      settlementProvenance: 'dispatch_failed',
      errorMessage: SWEEP_UNANSWERED_ERROR,
    });
  });

  it('uses one token-fenced sweep statement and admits same-token late success only', async () => {
    const db = await createDatabase();
    const store = createPGLiteQueuedPromptsStore(db as any);
    await store.create({ id: 'started', sessionId: 'session-a', prompt: 'started' });
    await store.create({ id: 'not-started', sessionId: 'session-a', prompt: 'not started' });
    await db.query(
      `INSERT INTO queued_prompts (id, session_id, prompt)
       VALUES ('blocked-row', 'blocked', 'blocked')`,
    );
    const started = await store.claim('started', 'session-a');
    const notStarted = await store.claim('not-started', 'session-a');
    const blocked = await db.query<{ claim_token: string }>(
      `UPDATE queued_prompts
       SET status = 'executing', claim_token = 'blocked-token', claimed_at = CURRENT_TIMESTAMP
       WHERE id = 'blocked-row'
       RETURNING claim_token`,
    );
    expect(blocked.rows[0].claim_token).toBe('blocked-token');
    await store.beginDispatch('started', 'session-a', started!.claimToken!);
    await db.query(
      `INSERT INTO ai_agent_messages (session_id, source, direction, content)
       VALUES ('session-a', 'unrelated', 'input', 'not either queued prompt')`,
    );

    const sweep = await store.sweepExecutingForSession('session-a');
    expect(sweep).toEqual({
      completed: 0,
      failed: 1,
      rolledBack: 1,
      completedIds: [],
      failedIds: ['started'],
      rolledBackIds: ['not-started'],
    });
    await expect(store.get('started')).resolves.toMatchObject({
      status: 'failed',
      claimToken: started!.claimToken,
      settlementProvenance: 'sweep_interrupt',
    });
    await expect(store.get('not-started')).resolves.toMatchObject({
      status: 'pending',
      claimToken: undefined,
      settlementProvenance: undefined,
    });
    await expect(store.get('blocked-row')).resolves.toMatchObject({ status: 'executing' });
    await expect(
      store.completeAfterDispatch('started', 'session-a', notStarted!.claimToken!),
    ).resolves.toMatchObject({ outcome: 'stale_owner' });
    await expect(
      store.completeAfterDispatch('started', 'session-a', started!.claimToken!),
    ).resolves.toMatchObject({ outcome: 'settled' });
  });

  it('persists the non-CLI handler terminal boundary without minting a second time or sequence', async () => {
    const db = await createDatabase();
    const store = createPGLiteQueuedPromptsStore(db as any);
    await store.create({ id: 'bound-terminal', sessionId: 'session-a', prompt: 'bound' });
    const claim = await store.claim('bound-terminal', 'session-a');
    await store.beginDispatch('bound-terminal', 'session-a', claim!.claimToken!);

    const terminalAt = Date.parse('2026-08-03T00:02:00.000Z');
    await expect(store.completeAfterDispatch('bound-terminal', 'session-a', claim!.claimToken!, {
      lifecycle: 'completed', terminalAt, eventSequence: 9,
    })).resolves.toMatchObject({ outcome: 'settled' });
    await expect(store.get('bound-terminal')).resolves.toMatchObject({
      status: 'completed', terminalStatus: 'completed', terminalAt, streamEventSequence: 9,
    });
  });

  it('atomically admits create, pending replacement, and expected-session delete', async () => {
    const db = await createDatabase();
    const store = createPGLiteQueuedPromptsStore(db as any);
    await expect(
      store.create({ id: 'blocked-create', sessionId: 'blocked', prompt: 'no' }),
    ).rejects.toThrow('not admitted');
    await expect(
      store.create({ id: 'malformed-create', sessionId: 'malformed', prompt: 'no' }),
    ).rejects.toThrow('not admitted');
    await expect(
      store.create({ id: 'missing-create', sessionId: 'missing', prompt: 'no' }),
    ).rejects.toThrow('not admitted');

    await store.create({
      id: 'editable',
      sessionId: 'session-a',
      prompt: 'first',
      attachments: [{ id: 'a' }],
      documentContext: { filePath: 'a.ts', content: 'a' },
    });
    await expect(
      store.replacePending({
        id: 'editable',
        sessionId: 'session-b',
        prompt: 'wrong',
      }),
    ).resolves.toBeNull();
    await expect(
      store.replacePending({
        id: 'editable',
        sessionId: 'session-a',
        prompt: 'first\n\nsecond',
        attachments: [{ id: 'a' }, { id: 'b' }],
        documentContext: { filePath: 'b.ts', content: 'b' },
      }),
    ).resolves.toMatchObject({
      id: 'editable',
      prompt: 'first\n\nsecond',
      attachments: [{ id: 'a' }, { id: 'b' }],
    });
    await expect(store.deletePending('editable', 'session-b')).resolves.toBe(false);
    await expect(store.deletePending('editable', 'session-a')).resolves.toBe(true);

    await store.create({ id: 'claimed', sessionId: 'session-a', prompt: 'claimed' });
    await store.claim('claimed', 'session-a');
    await expect(store.deletePending('claimed', 'session-a')).resolves.toBe(false);
    await expect(store.replacePending({ id: 'claimed', sessionId: 'session-a', prompt: 'lost' })).resolves.toBeNull();
    await expect(store.get('claimed')).resolves.toMatchObject({ prompt: 'claimed', status: 'executing' });
  });
});

describe('PGLiteQueuedPromptsStore boot re-drive helpers', () => {
  it('listSessionIdsWithPending returns each session once, pending rows only', async () => {
    const query = vi.fn(async (sql: string, params?: any[]) => {
      expect(sql).toContain('DISTINCT session_id');
      expect(sql).toContain("status = 'pending'");
      expect(params).toBeUndefined();
      return { rows: [{ session_id: 'session-a' }, { session_id: 'session-b' }] };
    });
    const db: DbStub = { query: query as any };

    const store = createPGLiteQueuedPromptsStore(db);

    expect(await store.listSessionIdsWithPending()).toEqual(['session-a', 'session-b']);
  });

  it('failAllPendingForSession fails only that session\'s pending rows', async () => {
    const query = vi.fn(async (sql: string, params?: any[]) => {
      expect(sql).toContain("SET status = 'failed'");
      // Must not touch an executing row: that prompt is already in the
      // conversation and failing it would contradict the boot sweep.
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain('session_id = $1');
      expect(params).toEqual(['session-gone', 'Project folder is no longer available at /gone']);
      return { rows: [{ id: 'p1' }, { id: 'p2' }] };
    });
    const db: DbStub = { query: query as any };

    const store = createPGLiteQueuedPromptsStore(db);

    expect(
      await store.failAllPendingForSession(
        'session-gone',
        'Project folder is no longer available at /gone',
      ),
    ).toBe(2);
  });
});
