import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';
import { createPGLiteQueuedPromptsStore } from '../PGLiteQueuedPromptsStore';

describe('PGLiteQueuedPromptsStore SQLite parity', () => {
  let tmpDir: string;
  let database: SQLiteDatabase;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-priority-queue-'));
    database = new SQLiteDatabase({
      dbDir: tmpDir,
      schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await database.initialize();
    await database.query(
      `INSERT INTO ai_sessions (id, workspace_id, provider, title, metadata)
       VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
      [
        'session-1', 'D:\\repo', 'openai-codex', 'Target', '{}',
        'blocked', 'D:\\repo', 'openai-codex', 'Blocked',
        '{"modelChangeReconciliation":{"status":"pending"}}',
      ],
    );
  });

  afterEach(async () => {
    await database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps ordinary FIFO and durable priority-control ordering', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    await store.create({ id: 'ordinary-1', sessionId: 'session-1', prompt: 'first' });
    await store.create({ id: 'ordinary-2', sessionId: 'session-1', prompt: 'second' });
    const input = {
      id: 'control-1',
      sessionId: 'session-1',
      prompt: 'priority',
      producer: 'send_prompt_now:caller',
      idempotencyKey: 'priority:key-1',
      requestDigest: 'digest-1',
      controlOperation: 'operator_directive',
    };
    await expect(store.createPriorityControlPrompt(input)).resolves.toMatchObject({
      replayed: false,
      row: { id: 'control-1', deliveryReady: false },
    });
    await expect(
      store.createPriorityControlPrompt({ ...input, id: 'control-replay' }),
    ).resolves.toMatchObject({ replayed: true, row: { id: 'control-1' } });
    await expect(
      store.createPriorityControlPrompt({ ...input, id: 'control-conflict', requestDigest: 'other' }),
    ).rejects.toThrow(/idempotency_conflict/);

    await store.reservePriorityInterrupt({
      promptId: 'control-1',
      generation: 'running:10:20',
      owner: 'owner-1',
    });
    await store.recordPriorityInterruptReceipt({
      promptId: 'control-1',
      generation: 'running:10:20',
      receipt: {
        generation: 'running:10:20', attempted: true, success: true,
        method: 'interrupt', error: null, nativeEntered: true, recordedAt: 30,
      },
    });
    expect((await store.listPending('session-1')).map((row) => row.id)).toEqual([
      'control-1',
      'ordinary-1',
      'ordinary-2',
    ]);
  });

  it('allocates after migrated rows and atomically replays stable client submissions', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    await database.query(
      `INSERT INTO queued_prompts (
         id, session_id, prompt, client_submission_id, source_session_id,
         source_room_id, submission_sequence, payload_utf8_bytes,
         payload_unicode_scalars, payload_sha256
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      ['legacy', 'session-1', 'legacy', 'legacy', 'session-1', 'session-1', 7, 6, 6, 'legacy-unverified'],
    );

    await expect(
      store.create({
        id: 'first-row', clientSubmissionId: 'stable-client', sessionId: 'session-1',
        prompt: 'same payload', producer: 'test',
      }),
    ).resolves.toMatchObject({ id: 'first-row', submissionSequence: 8 });
    await expect(
      store.create({
        id: 'first-row', clientSubmissionId: 'stable-client', sessionId: 'session-1',
        prompt: 'same payload', producer: 'test',
      }),
    ).resolves.toMatchObject({ id: 'first-row', clientSubmissionId: 'stable-client' });
    await expect(
      store.create({
        id: 'retry-row', clientSubmissionId: 'stable-client', sessionId: 'session-1',
        prompt: 'same payload', producer: 'test',
      }),
    ).resolves.toMatchObject({ id: 'first-row', clientSubmissionId: 'stable-client' });
    await expect(
      store.create({
        id: 'payload-conflict', clientSubmissionId: 'stable-client', sessionId: 'session-1',
        prompt: 'different', producer: 'test',
      }),
    ).rejects.toThrow('payload receipt mismatch');
    await expect(
      store.create({
        id: 'session-conflict', clientSubmissionId: 'stable-client', sessionId: 'blocked',
        prompt: 'same payload', producer: 'test',
      }),
    ).rejects.toThrow('submission identity conflict');
  });

  it('fences stale claims, supports provisional late success, and reports duplicate settlement', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    await store.create({ id: 'replaceable', sessionId: 'session-1', prompt: 'replaceable' });
    const ownerA = await store.claim('replaceable', 'session-1');
    expect(ownerA?.claimToken).toBeTruthy();
    expect(await store.sweepExecutingForSession('session-1')).toMatchObject({
      failed: 0,
      rolledBack: 1,
      rolledBackIds: ['replaceable'],
    });
    const ownerB = await store.claim('replaceable', 'session-1');
    await expect(
      store.beginDispatch('replaceable', 'session-1', ownerB!.claimToken!),
    ).resolves.toMatchObject({ outcome: 'settled' });
    await expect(
      store.completeAfterDispatch('replaceable', 'session-1', ownerA!.claimToken!),
    ).resolves.toMatchObject({ outcome: 'stale_owner' });

    const swept = await store.sweepExecutingForSession('session-1');
    expect(swept).toMatchObject({ failed: 1, failedIds: ['replaceable'], rolledBack: 0 });
    await expect(
      store.completeAfterDispatch('replaceable', 'session-1', ownerB!.claimToken!),
    ).resolves.toMatchObject({ outcome: 'settled' });
    await expect(
      store.completeAfterDispatch('replaceable', 'session-1', ownerB!.claimToken!),
    ).resolves.toMatchObject({ outcome: 'idempotent_same_claim' });
  });

  it('matches PGLite recovery, wrong-owner, ordinary-failure, and CRUD behavior', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    await expect(
      store.create({ id: 'blocked-create', sessionId: 'blocked', prompt: 'blocked' }),
    ).rejects.toThrow('not admitted');
    await store.create({ id: 'owned', sessionId: 'session-1', prompt: 'owned' });
    const claimed = await store.claim('owned', 'session-1');
    const token = claimed!.claimToken!;
    await store.beginDispatch('owned', 'session-1', token);
    await expect(store.completeAfterDispatch('owned', 'wrong-session', token)).resolves.toMatchObject({
      outcome: 'stale_owner',
    });
    await database.query(`UPDATE ai_sessions SET metadata = $1 WHERE id = $2`, [
      '{"modelChangeReconciliation":{"status":"pending"}}',
      'session-1',
    ]);
    await expect(store.completeAfterDispatch('owned', 'session-1', token)).resolves.toMatchObject({
      outcome: 'recovery_blocked',
    });
    await database.query(`UPDATE ai_sessions SET metadata = $1 WHERE id = $2`, ['{}', 'session-1']);
    await expect(
      store.failAfterDispatch('owned', 'permanent failure', 'session-1', token),
    ).resolves.toMatchObject({ outcome: 'settled' });
    await expect(store.completeAfterDispatch('owned', 'session-1', token)).resolves.toMatchObject({
      outcome: 'terminal_conflict',
    });

    await store.create({ id: 'editable', sessionId: 'session-1', prompt: 'one' });
    await expect(
      store.replacePending({ id: 'editable', sessionId: 'session-1', prompt: 'one\n\ntwo' }),
    ).resolves.toMatchObject({ id: 'editable', prompt: 'one\n\ntwo' });
    await expect(store.deletePending('editable', 'wrong-session')).resolves.toBe(false);
    await expect(store.deletePending('editable', 'session-1')).resolves.toBe(true);
    await expect(store.deletePending('owned', 'session-1')).resolves.toBe(false);
  });

  it('serializes distinct control rows on one target lifecycle generation', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    for (const [id, key] of [['control-a', 'key-a'], ['control-b', 'key-b']] as const) {
      await store.createPriorityControlPrompt({
        id,
        sessionId: 'session-1',
        prompt: id,
        producer: 'test',
        idempotencyKey: key,
        requestDigest: `digest-${id}`,
        controlOperation: 'priority',
      });
    }
    const generation = 'running:10:20';
    const reservations = await Promise.all([
      store.reservePriorityInterrupt({ promptId: 'control-a', generation, owner: 'owner-a' }),
      store.reservePriorityInterrupt({ promptId: 'control-b', generation, owner: 'owner-b' }),
    ]);
    expect(reservations.filter((entry) => entry.reserved)).toHaveLength(1);

    const winner = reservations.find((entry) => entry.reserved)!.row;
    const loserId = winner.id === 'control-a' ? 'control-b' : 'control-a';
    await expect(store.get(loserId)).resolves.toMatchObject({
      deliveryReady: false,
      interruptReservationOwner: winner.interruptReservationOwner,
    });
    await store.recordPriorityInterruptReceipt({
      promptId: winner.id,
      generation,
      receipt: {
        generation, attempted: true, success: true, method: 'interrupt',
        error: null, nativeEntered: true, recordedAt: 30,
      },
    });
    await expect(store.get(loserId)).resolves.toMatchObject({
      id: loserId,
      deliveryReady: true,
      interruptReceipt: { success: true },
    });
  });

  it('atomically copies a receipt settled before the loser association executes', async () => {
    const adapter = createSQLiteStoreAdapter(database);
    const store = createPGLiteQueuedPromptsStore(adapter);
    for (const [id, key] of [['control-a', 'key-a'], ['control-b', 'key-b']] as const) {
      await store.createPriorityControlPrompt({
        id,
        sessionId: 'session-1',
        prompt: id,
        producer: 'test',
        idempotencyKey: key,
        requestDigest: `digest-${id}`,
        controlOperation: 'priority',
      });
    }

    const generation = 'running:10:20';
    await expect(store.reservePriorityInterrupt({
      promptId: 'control-a', generation, owner: 'winner-owner',
    })).resolves.toMatchObject({ reserved: true });

    let associationObserved!: () => void;
    let releaseAssociation!: () => void;
    const observed = new Promise<void>((resolve) => { associationObserved = resolve; });
    const gate = new Promise<void>((resolve) => { releaseAssociation = resolve; });
    const gatedStore = createPGLiteQueuedPromptsStore({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SET interrupt_reservation_owner = incumbent.interrupt_reservation_owner')) {
          associationObserved();
          await gate;
        }
        return adapter.query(sql, params);
      },
    } as any);
    const losingReservation = gatedStore.reservePriorityInterrupt({
      promptId: 'control-b', generation, owner: 'loser-owner',
    });
    await observed;

    await store.recordPriorityInterruptReceipt({
      promptId: 'control-a',
      generation,
      receipt: {
        generation, attempted: true, success: true, method: 'interrupt',
        error: null, nativeEntered: true, recordedAt: 30,
      },
    });
    releaseAssociation();

    await expect(losingReservation).resolves.toMatchObject({
      reserved: false,
      row: {
        id: 'control-b',
        interruptReservationOwner: 'winner-owner',
        deliveryReady: true,
        interruptReceipt: { success: true },
      },
    });
    await expect(store.get('control-b')).resolves.toMatchObject({
      deliveryReady: true,
      interruptReceipt: { success: true },
    });
  });
});
