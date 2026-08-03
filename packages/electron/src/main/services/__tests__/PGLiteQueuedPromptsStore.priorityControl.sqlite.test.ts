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

  it('terminalizes a failed stale-generation interrupt while preserving its durable receipt for audit', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    await store.createPriorityControlPrompt({
      id: 'stale-control', sessionId: 'session-1', prompt: 'priority', producer: 'test',
      idempotencyKey: 'stale-control-key', requestDigest: 'stale-control-digest', controlOperation: 'operator_directive',
    });
    await store.reservePriorityInterrupt({ promptId: 'stale-control', generation: 'running:old', owner: 'owner-1' });
    const receipt = { generation: 'running:old', attempted: false, success: false, method: null, error: 'stale lifecycle generation', nativeEntered: false, recordedAt: 40 };
    await expect(store.recordPriorityInterruptReceipt({ promptId: 'stale-control', generation: 'running:old', receipt })).resolves.toMatchObject({
      status: 'failed', deliveryReady: false, errorMessage: 'stale lifecycle generation', interruptReceipt: receipt,
    });
    await expect(store.listForSession('session-1')).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'stale-control' })]));
    await expect(store.listForSession('session-1', { includeCompleted: true })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'stale-control', status: 'failed', interruptReceipt: receipt })]));
    await expect(store.recordPriorityInterruptReceipt({ promptId: 'stale-control', generation: 'running:old', receipt })).resolves.toMatchObject({ status: 'failed', interruptReceipt: receipt });
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
});
