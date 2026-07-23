import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';
import { createPGLiteQueuedPromptsStore } from '../PGLiteQueuedPromptsStore';

describe('PGLiteQueuedPromptsStore priority control rows on SQLite', () => {
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
      `INSERT INTO ai_sessions (id, workspace_id, provider, title)
       VALUES ($1, $2, $3, $4)`,
      ['session-1', 'D:\\repo', 'openai-codex', 'Target'],
    );
  });

  afterEach(async () => {
    await database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps ordinary prompts FIFO while control rows sort first', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    await store.create({ id: 'ordinary-1', sessionId: 'session-1', prompt: 'first' });
    await store.create({ id: 'ordinary-2', sessionId: 'session-1', prompt: 'second' });
    await store.createPriorityControlPrompt({
      id: 'control-1',
      sessionId: 'session-1',
      prompt: 'priority',
      producer: 'send_prompt_now:caller',
      idempotencyKey: 'priority:key-1',
      requestDigest: 'digest-1',
      controlOperation: 'operator_directive',
    });

    expect((await store.listPending('session-1')).map((row) => row.id)).toEqual([
      'ordinary-1',
      'ordinary-2',
    ]);
    await expect(store.claim('control-1')).resolves.toBeNull();
    await store.reservePriorityInterrupt({
      promptId: 'control-1',
      generation: 'idle:10:20',
      owner: 'owner-1',
    });
    await store.recordPriorityInterruptReceipt({
      promptId: 'control-1',
      generation: 'idle:10:20',
      receipt: {
        generation: 'idle:10:20',
        attempted: false,
        success: true,
        method: 'not-required',
        error: null,
        nativeEntered: false,
        recordedAt: 30,
      },
    });
    expect((await store.listPending('session-1')).map((row) => row.id)).toEqual([
      'control-1',
      'ordinary-1',
      'ordinary-2',
    ]);
    expect(await store.listPendingSessionIds({ deliveryClass: 'ordinary' }))
      .toEqual(['session-1']);
  });

  it('replays the same durable row and rejects idempotency-key reuse', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
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
      row: { id: 'control-1', deliveryClass: 'control', priorityRank: 100 },
    });
    await expect(store.createPriorityControlPrompt({ ...input, id: 'control-2' }))
      .resolves.toMatchObject({
        replayed: true,
        row: { id: 'control-1' },
      });
    await expect(store.createPriorityControlPrompt({
      ...input,
      id: 'control-3',
      requestDigest: 'different-digest',
    })).rejects.toThrow(/idempotency_conflict/);
  });

  it('reserves and records one interrupt receipt durably', async () => {
    const store = createPGLiteQueuedPromptsStore(createSQLiteStoreAdapter(database));
    await store.createPriorityControlPrompt({
      id: 'control-1',
      sessionId: 'session-1',
      prompt: 'priority',
      producer: 'send_prompt_now:caller',
      idempotencyKey: 'priority:key-1',
      requestDigest: 'digest-1',
      controlOperation: 'operator_directive',
    });

    await expect(store.reservePriorityInterrupt({
      promptId: 'control-1',
      generation: 'running:10:20',
      owner: 'owner-1',
    })).resolves.toMatchObject({
      reserved: true,
      row: {
        interruptTargetGeneration: 'running:10:20',
        interruptReservationOwner: 'owner-1',
      },
    });
    await expect(store.reservePriorityInterrupt({
      promptId: 'control-1',
      generation: 'running:10:20',
      owner: 'owner-2',
    })).resolves.toMatchObject({ reserved: false });

    const receipt = {
      generation: 'running:10:20',
      attempted: true,
      success: true,
      method: 'interrupt',
      error: null,
      nativeEntered: true,
      recordedAt: 30,
    };
    await expect(store.recordPriorityInterruptReceipt({
      promptId: 'control-1',
      generation: receipt.generation,
      receipt,
    })).resolves.toMatchObject({ interruptReceipt: receipt });
    await expect(store.listPending('session-1')).resolves.toMatchObject([
      { id: 'control-1', deliveryReady: true },
    ]);
    await expect(store.get('control-1')).resolves.toMatchObject({
      interruptReceipt: receipt,
    });
  });
});
