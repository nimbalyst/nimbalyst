import { createHash } from 'crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';
import {
  createPGLiteQueuedPromptsStore as createProductionQueuedPromptsStore,
} from '../PGLiteQueuedPromptsStore';
import { createPriorityPromptDeliveryService } from '../PriorityPromptDeliveryService';
import { resolveQueuedPromptDispatchTarget } from '../ai/queuedPromptDispatcher';
import { runInterruptCurrentTurnForSession } from '../ai/interruptCurrentTurnForSession';

type DbStub = { query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }> };

const unitAuthorityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-store-unit-authority-'));
afterAll(() => fs.rmSync(unitAuthorityRoot, { recursive: true, force: true }));
const createPGLiteQueuedPromptsStore = (
  ...args: Parameters<typeof createProductionQueuedPromptsStore>
) => createProductionQueuedPromptsStore(args[0], args[1], {
  storeIdentity: { storeId: 'queued-store-unit', authorityRoot: unitAuthorityRoot },
  ...args[2],
});

type QueuedPromptRow = {
  id: string;
  session_id: string;
  prompt: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  attachments: string | null;
  document_context: string | null;
  delivery_class: 'ordinary' | 'control';
  priority_rank: number;
  producer: string | null;
  idempotency_key: string | null;
  request_digest: string | null;
  control_operation: string | null;
  interrupt_target_generation: string | null;
  interrupt_reservation_owner: string | null;
  interrupt_lease_expires_at: Date | null;
  interrupt_operation_id: string | null;
  interrupt_fence: number;
  interrupt_application_state: 'not_started' | 'unknown' | 'not_applied' | 'applied' | 'legacy_unknown';
  interrupt_started_at: Date | null;
  interrupt_applied_at: Date | null;
  interrupt_application_receipt: string | null;
  interrupt_cleanup_state: 'pending' | 'claimed' | 'complete';
  interrupt_cleanup_fence: number;
  interrupt_receipt: string | null;
  created_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  error_message: string | null;
};

/** Stateful query-interface stub used for queue ordering/idempotency behavior tests. */
function createQueueDbStub(options?: { createdAtBase?: number }): DbStub {
  const rows: QueuedPromptRow[] = [];
  let timestampOffset = 0;
  const oldBase = options?.createdAtBase ?? Date.now() - 60_000;

  const query: DbStub['query'] = async <T = any>(sql: string, params?: any[]) => {
    if (sql.includes('INSERT INTO queued_prompts') && sql.includes('ON CONFLICT')) {
      const [id, sessionId, prompt, producer, idempotencyKey, controlOperation, requestDigest] = params!;
      const canonicalJson = JSON.stringify({ sessionId, prompt, producer, controlOperation });
      const expectedDigest = createHash('sha256').update(canonicalJson).digest('hex');
      if (requestDigest !== expectedDigest) {
        throw new Error('Control request digest was not computed from the canonical request');
      }
      const existing = rows.find((row) => row.idempotency_key === idempotencyKey);
      if (existing) {
        const identical = existing.request_digest === requestDigest;
        return { rows: (identical ? [structuredClone(existing)] : []) as T[] };
      }

      const row: QueuedPromptRow = {
        id,
        session_id: sessionId,
        prompt,
        status: 'pending',
        attachments: null,
        document_context: null,
        delivery_class: 'control',
        priority_rank: 100,
        producer,
        idempotency_key: idempotencyKey,
        request_digest: requestDigest,
        control_operation: controlOperation,
        interrupt_target_generation: null,
        interrupt_reservation_owner: null,
        interrupt_lease_expires_at: null,
        interrupt_operation_id: null,
        interrupt_fence: 0,
        interrupt_application_state: 'not_started',
        interrupt_started_at: null,
        interrupt_applied_at: null,
        interrupt_application_receipt: null,
        interrupt_cleanup_state: 'pending',
        interrupt_cleanup_fence: 0,
        interrupt_receipt: null,
        created_at: new Date(oldBase + timestampOffset++),
        claimed_at: null,
        completed_at: null,
        error_message: null,
      };
      rows.push(row);
      return { rows: [structuredClone(row)] as T[] };
    }

    if (sql.includes('INSERT INTO queued_prompts')) {
      const [id, sessionId, prompt, attachments, documentContext] = params!;
      const row: QueuedPromptRow = {
        id,
        session_id: sessionId,
        prompt,
        status: 'pending',
        attachments,
        document_context: documentContext,
        delivery_class: 'ordinary',
        priority_rank: 0,
        producer: null,
        idempotency_key: null,
        request_digest: null,
        control_operation: null,
        interrupt_target_generation: null,
        interrupt_reservation_owner: null,
        interrupt_lease_expires_at: null,
        interrupt_operation_id: null,
        interrupt_fence: 0,
        interrupt_application_state: 'not_started',
        interrupt_started_at: null,
        interrupt_applied_at: null,
        interrupt_application_receipt: null,
        interrupt_cleanup_state: 'pending',
        interrupt_cleanup_fence: 0,
        interrupt_receipt: null,
        created_at: new Date(oldBase + timestampOffset++),
        claimed_at: null,
        completed_at: null,
        error_message: null,
      };
      rows.push(row);
      return { rows: [structuredClone(row)] as T[] };
    }

    if (sql.includes("WHERE session_id = $1 AND status = 'pending'")) {
      const pending = rows
        .filter((row) => row.session_id === params![0] && row.status === 'pending')
        .sort((a, b) => b.priority_rank - a.priority_rank
          || a.created_at.getTime() - b.created_at.getTime()
          || a.id.localeCompare(b.id));
      return { rows: structuredClone(pending) as T[] };
    }

    if (sql.includes('WHERE idempotency_key = $1')) {
      const matches = rows.filter((row) => row.idempotency_key === params![0]);
      return { rows: structuredClone(matches) as T[] };
    }

    if (sql.includes('SET interrupt_target_generation = $2')) {
      const row = rows.find((candidate) => (
        candidate.id === params![0] && candidate.interrupt_target_generation === null
      ));
      if (!row) return { rows: [] };
      row.interrupt_target_generation = params![1];
      row.interrupt_reservation_owner = params![2];
      row.interrupt_lease_expires_at = params![4];
      row.interrupt_operation_id = params![5];
      row.interrupt_fence += 1;
      return { rows: [structuredClone(row)] as T[] };
    }

    if (sql.includes('SET interrupt_reservation_owner = $3')) {
      const now = (params![3] as Date).getTime();
      const row = rows.find((candidate) => (
        candidate.id === params![0]
        && candidate.interrupt_receipt === null
        && candidate.interrupt_lease_expires_at !== null
        && candidate.interrupt_lease_expires_at.getTime() <= now
        && candidate.interrupt_reservation_owner === params![5]
        && candidate.interrupt_operation_id === params![7]
        && candidate.interrupt_fence === params![8]
        && candidate.interrupt_application_state === params![10]
      ));
      if (!row) return { rows: [] };
      row.interrupt_reservation_owner = params![2];
      row.interrupt_lease_expires_at = params![4];
      row.interrupt_fence = params![9];
      if (row.interrupt_cleanup_state === 'claimed') row.interrupt_cleanup_state = 'pending';
      return { rows: [structuredClone(row)] as T[] };
    }

    if (sql.includes("SET interrupt_application_state = 'unknown'")) {
      const row = rows.find((candidate) => (
        candidate.id === params![0]
        && candidate.interrupt_target_generation === params![1]
        && candidate.interrupt_reservation_owner === params![2]
        && candidate.interrupt_operation_id === params![4]
        && candidate.interrupt_fence === params![5]
        && candidate.interrupt_application_state === 'not_started'
        && candidate.interrupt_receipt === null
        && candidate.interrupt_lease_expires_at!.getTime() > (params![3] as Date).getTime()
      ));
      if (!row) return { rows: [] };
      row.interrupt_application_state = 'unknown';
      row.interrupt_started_at = params![3];
      return { rows: [structuredClone(row)] as T[] };
    }

    if (sql.includes('SET interrupt_application_state = $8')) {
      const row = rows.find((candidate) => (
        candidate.id === params![0]
        && candidate.interrupt_target_generation === params![1]
        && candidate.interrupt_reservation_owner === params![2]
        && candidate.interrupt_operation_id === params![5]
        && candidate.interrupt_fence === params![6]
        && candidate.interrupt_application_state === 'unknown'
        && candidate.interrupt_receipt === null
        && candidate.interrupt_lease_expires_at!.getTime() > (params![4] as Date).getTime()
      ));
      if (!row) return { rows: [] };
      row.interrupt_application_state = params![7];
      row.interrupt_application_receipt = params![3];
      row.interrupt_applied_at = params![4];
      return { rows: [structuredClone(row)] as T[] };
    }

    if (sql.includes("SET interrupt_cleanup_state = 'claimed'")) {
      const row = rows.find((candidate) => (
        candidate.id === params![0]
        && candidate.interrupt_target_generation === params![1]
        && candidate.interrupt_reservation_owner === params![2]
        && candidate.interrupt_operation_id === params![3]
        && candidate.interrupt_fence === params![4]
        && candidate.interrupt_receipt === null
      ));
      if (!row) return { rows: [] };
      row.interrupt_cleanup_state = 'claimed';
      row.interrupt_cleanup_fence = params![4];
      return { rows: [structuredClone(row)] as T[] };
    }

    if (sql.includes('SET interrupt_receipt = $2')) {
      const row = rows.find((candidate) => (
        candidate.id === params![0]
        && candidate.interrupt_target_generation === params![2]
        && candidate.interrupt_reservation_owner === params![3]
        && candidate.interrupt_operation_id === params![4]
        && candidate.interrupt_fence === params![5]
        && candidate.interrupt_receipt === null
        && candidate.interrupt_cleanup_state === 'claimed'
        && candidate.interrupt_cleanup_fence === params![5]
      ));
      if (!row) return { rows: [] };
      row.interrupt_receipt = params![1];
      row.interrupt_reservation_owner = null;
      row.interrupt_lease_expires_at = null;
      row.interrupt_cleanup_state = 'complete';
      return { rows: [structuredClone(row)] as T[] };
    }

    if (sql.includes("SET status = 'completed'") && sql.includes("NOW() - INTERVAL '1 day'")) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const completed = rows.filter((row) => (
        row.status === 'pending'
        && row.delivery_class !== 'control'
        && row.created_at.getTime() < cutoff
      ));
      for (const row of completed) {
        row.status = 'completed';
        row.completed_at = new Date();
      }
      return { rows: structuredClone(completed.map(({ id }) => ({ id }))) as T[] };
    }

    if (sql.includes("SET status = 'failed'") && sql.includes("WHERE status = 'executing'")) {
      return { rows: [] };
    }

    if (sql.includes("SET status = 'pending'") && sql.includes("WHERE status = 'executing'")) {
      const executing = rows.filter((row) => row.status === 'executing');
      for (const row of executing) {
        row.status = 'pending';
        row.claimed_at = null;
      }
      return { rows: structuredClone(executing.map(({ id }) => ({ id }))) as T[] };
    }

    if (sql.includes("SET status = 'executing'") && sql.includes("WHERE id = $1 AND status = 'pending'")) {
      const row = rows.find((candidate) => candidate.id === params![0] && candidate.status === 'pending');
      if (!row) return { rows: [] };
      row.status = 'executing';
      row.claimed_at = new Date(oldBase + timestampOffset++);
      return { rows: [structuredClone(row)] as T[] };
    }

    if (sql.includes("SET status = 'completed'") && sql.includes('WHERE id = $1')) {
      const row = rows.find((candidate) => candidate.id === params![0]);
      if (row) {
        row.status = 'completed';
        row.completed_at = new Date(oldBase + timestampOffset++);
        row.error_message = null;
      }
      return { rows: [] };
    }

    if (sql.includes('WITH deleted AS')) {
      const cutoff = (params![0] as Date).getTime();
      const deleted = rows.filter((row) => (
        (row.status === 'completed' || row.status === 'failed')
        && row.delivery_class !== 'control'
        && row.completed_at !== null
        && row.completed_at.getTime() < cutoff
      ));
      for (const row of deleted) {
        rows.splice(rows.indexOf(row), 1);
      }
      return { rows: [{ count: String(deleted.length) }] as T[] };
    }

    if (sql.includes('WHERE id = $1')) {
      const matches = rows.filter((row) => row.id === params![0]);
      return { rows: structuredClone(matches) as T[] };
    }

    if (sql.trim().startsWith('SELECT')) {
      return { rows: structuredClone(rows) as T[] };
    }

    throw new Error(`Unexpected query: ${sql}`);
  };

  return { query };
}

function interruptReservation(
  id: string,
  reservationOwner: string,
  nowMs = Date.parse('2026-07-20T10:00:00.000Z'),
) {
  return {
    id,
    expectedGeneration: 'generation-1',
    reservationOwner,
    now: new Date(nowMs),
    leaseExpiresAt: new Date(nowMs + 1_000),
  };
}

function boundedBarrier(name: string, timeoutMs = 500) {
  let release!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolve, rejectPromise) => {
    release = resolve;
    reject = rejectPromise;
  });
  const timer = setTimeout(() => reject(new Error(`barrier_timeout:${name}`)), timeoutMs);
  return {
    promise,
    release: () => { clearTimeout(timer); release(); },
    dispose: () => { clearTimeout(timer); release(); },
  };
}

describe('PGLiteQueuedPromptsStore priority control queue', () => {
  it('preserves ordinary create/listPending FIFO ordering byte-for-byte', async () => {
    const db = createQueueDbStub();
    const store = createPGLiteQueuedPromptsStore(db);

    await store.create({ id: 'ordinary-1', sessionId: 'session-1', prompt: 'first' });
    await store.create({ id: 'ordinary-2', sessionId: 'session-1', prompt: 'second' });
    await store.create({ id: 'ordinary-3', sessionId: 'session-1', prompt: 'third' });

    const pending = await store.listPending('session-1');
    expect(pending.map(({ id, prompt }) => ({ id, prompt }))).toEqual([
      { id: 'ordinary-1', prompt: 'first' },
      { id: 'ordinary-2', prompt: 'second' },
      { id: 'ordinary-3', prompt: 'third' },
    ]);
    expect(pending.map(({ deliveryClass, priorityRank }) => ({ deliveryClass, priorityRank }))).toEqual([
      { deliveryClass: 'ordinary', priorityRank: 0 },
      { deliveryClass: 'ordinary', priorityRank: 0 },
      { deliveryClass: 'ordinary', priorityRank: 0 },
    ]);
  });

  it('sorts a later control row before pending ordinary rows', async () => {
    const db = createQueueDbStub();
    const store = createPGLiteQueuedPromptsStore(db);

    await store.create({ id: 'ordinary-1', sessionId: 'session-1', prompt: 'first' });
    await store.create({ id: 'ordinary-2', sessionId: 'session-1', prompt: 'second' });
    const control = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-1',
      prompt: 'inspect obligation',
      idempotencyKey: 'watcher:event-1',
      producer: 'watcher_obligation_event',
      controlOperation: 'terminal_observed',
    });

    expect((await store.listPending('session-1')).map((row) => row.id)).toEqual([
      control.id,
      'ordinary-1',
      'ordinary-2',
    ]);
  });

  it('returns one row for concurrent identical idempotent creates', async () => {
    const db = createQueueDbStub();
    const store = createPGLiteQueuedPromptsStore(db);
    const request = {
      sessionId: 'session-1',
      prompt: 'inspect obligation',
      idempotencyKey: 'watcher:event-concurrent',
      producer: 'watcher_obligation_event',
      controlOperation: 'liveness_breach',
    };

    const [first, second] = await Promise.all([
      store.createPriorityControlQueuedPrompt(request),
      store.createPriorityControlQueuedPrompt(request),
    ]);

    expect(first.id).toBe(second.id);
    const direct = await db.query<{ id: string }>(
      'SELECT id FROM queued_prompts WHERE idempotency_key = $1',
      [request.idempotencyKey],
    );
    expect(direct.rows).toHaveLength(1);
    expect(direct.rows[0].id).toBe(first.id);
  });

  it('persists the same canonical request digest for identical idempotent creates', async () => {
    const db = createQueueDbStub();
    const store = createPGLiteQueuedPromptsStore(db);
    const request = {
      sessionId: 'session-digest',
      prompt: 'inspect the durable request',
      idempotencyKey: 'watcher:event-digest',
      producer: 'watcher_obligation_event',
      controlOperation: 'terminal_observed',
    };
    const expectedDigest = createHash('sha256').update(JSON.stringify({
      sessionId: request.sessionId,
      prompt: request.prompt,
      producer: request.producer,
      controlOperation: request.controlOperation,
    })).digest('hex');

    const first = await store.createPriorityControlQueuedPrompt(request);
    const second = await store.createPriorityControlQueuedPrompt(request);
    const stored = await db.query<QueuedPromptRow>(
      'SELECT * FROM queued_prompts WHERE idempotency_key = $1',
      [request.idempotencyKey],
    );

    expect(first.requestDigest).toBe(expectedDigest);
    expect(second.requestDigest).toBe(expectedDigest);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].request_digest).toBe(expectedDigest);
  });

  it('rejects conflicting reuse without creating or mutating a row', async () => {
    const db = createQueueDbStub();
    const store = createPGLiteQueuedPromptsStore(db);
    const request = {
      sessionId: 'session-1',
      prompt: 'original prompt',
      idempotencyKey: 'watcher:event-conflict',
      producer: 'watcher_obligation_event',
      controlOperation: 'terminal_observed',
    };
    await store.createPriorityControlQueuedPrompt(request);
    const before = await db.query('SELECT * FROM queued_prompts');

    await expect(store.createPriorityControlQueuedPrompt({
      ...request,
      prompt: 'different prompt',
    })).rejects.toThrow(/^idempotency_conflict:/);

    const after = await db.query('SELECT * FROM queued_prompts');
    expect(after.rows).toEqual(before.rows);
  });

  it('gets a row by idempotency key and returns null for an unknown key', async () => {
    const db = createQueueDbStub();
    const store = createPGLiteQueuedPromptsStore(db);
    const created = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-1',
      prompt: 'inspect obligation',
      idempotencyKey: 'watcher:event-get',
      producer: 'watcher_obligation_event',
      controlOperation: 'terminal_observed',
    });

    expect(await store.getByIdempotencyKey('watcher:event-get')).toEqual(created);
    expect(await store.getByIdempotencyKey('watcher:unknown')).toBeNull();
  });

  it('atomically reserves exactly one interrupt across concurrent callers', async () => {
    const db = createQueueDbStub();
    const store = createPGLiteQueuedPromptsStore(db);
    const control = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-1',
      prompt: 'inspect obligation',
      idempotencyKey: 'watcher:event-reserve-concurrent',
      producer: 'watcher_obligation_event',
      controlOperation: 'terminal_observed',
    });

    const results = await Promise.all([
      store.reserveInterrupt(interruptReservation(control.id, 'owner-a')),
      store.reserveInterrupt(interruptReservation(control.id, 'owner-b')),
    ]);

    expect(results.map((result) => result.reserved).sort()).toEqual([false, true]);
    const direct = await db.query<QueuedPromptRow>(
      'SELECT * FROM queued_prompts WHERE id = $1',
      [control.id],
    );
    expect(direct.rows).toHaveLength(1);
    expect(direct.rows[0].interrupt_target_generation).toBe('generation-1');
  });

  it('allows exactly one deterministic takeover after the interrupt lease expires', async () => {
    const db = createQueueDbStub();
    const store = createPGLiteQueuedPromptsStore(db);
    const control = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-1',
      prompt: 'inspect obligation',
      idempotencyKey: 'watcher:event-takeover',
      producer: 'watcher_obligation_event',
      controlOperation: 'terminal_observed',
    });
    await store.reserveInterrupt(interruptReservation(control.id, 'dead-owner'));

    const takeoverAt = Date.parse('2026-07-20T10:00:01.000Z');
    const results = await Promise.all([
      store.reserveInterrupt(interruptReservation(control.id, 'takeover-a', takeoverAt)),
      store.reserveInterrupt(interruptReservation(control.id, 'takeover-b', takeoverAt)),
    ]);

    expect(results.filter((result) => result.takenOver)).toHaveLength(1);
    expect(results.filter((result) => result.reserved)).toHaveLength(1);
    expect(results.find((result) => result.takenOver)?.row.interruptTargetGeneration)
      .toBe('generation-1');
  });

  it('persists a bounded application fact before the terminal interrupt receipt', async () => {
    const db = createQueueDbStub();
    const store = createPGLiteQueuedPromptsStore(db);
    const control = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-1',
      prompt: 'inspect obligation',
      idempotencyKey: 'watcher:event-application',
      producer: 'watcher_obligation_event',
      controlOperation: 'terminal_observed',
    });
    const reservation = await store.reserveInterrupt(interruptReservation(control.id, 'owner-a'));
    const startedAt = new Date('2026-07-20T10:00:00.500Z');
    expect((await store.beginInterruptApplication({
      id: control.id,
      expectedGeneration: 'generation-1',
      reservationOwner: 'owner-a',
      operationId: reservation.row.interruptOperationId!,
      fence: reservation.row.interruptFence!,
      now: startedAt,
    })).started).toBe(true);
    const receipt = {
      success: true,
      method: 'provider-interrupt',
      error: null,
      generation: 'generation-1',
      attemptedAt: startedAt.toISOString(),
      resultAt: startedAt.toISOString(),
    };
    const applied = await store.recordInterruptApplication({
      id: control.id,
      expectedGeneration: 'generation-1',
      reservationOwner: reservation.row.interruptReservationOwner!,
      operationId: reservation.row.interruptOperationId!,
      fence: reservation.row.interruptFence!,
      certainty: 'applied',
      receipt,
      appliedAt: startedAt,
    });

    expect(applied).toMatchObject({
      interruptApplicationState: 'applied',
      interruptApplicationReceipt: receipt,
      interruptReceipt: undefined,
    });
    await expect(store.recordInterruptApplication({
      id: control.id,
      expectedGeneration: 'generation-1',
      reservationOwner: reservation.row.interruptReservationOwner!,
      operationId: reservation.row.interruptOperationId!,
      fence: reservation.row.interruptFence!,
      certainty: 'applied',
      receipt: { ...receipt, method: 'different-persisted-bytes' },
      appliedAt: startedAt,
    })).rejects.toThrow('interrupt_application_receipt_conflict');
  });

  it('never overwrites an existing reservation with a different generation', async () => {
    const db = createQueueDbStub();
    const store = createPGLiteQueuedPromptsStore(db);
    const control = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-1',
      prompt: 'inspect obligation',
      idempotencyKey: 'watcher:event-reserve-conflict',
      producer: 'watcher_obligation_event',
      controlOperation: 'liveness_breach',
    });

    expect((await store.reserveInterrupt({
      ...interruptReservation(control.id, 'owner-a'),
      expectedGeneration: 'original-generation',
    })).reserved).toBe(true);
    const replay = await store.reserveInterrupt({
      ...interruptReservation(control.id, 'owner-b'),
      expectedGeneration: 'replacement-generation',
    });

    expect(replay.reserved).toBe(false);
    expect(replay.row.interruptTargetGeneration).toBe('original-generation');
    const direct = await db.query<QueuedPromptRow>('SELECT * FROM queued_prompts WHERE id = $1', [control.id]);
    expect(direct.rows[0].interrupt_target_generation).toBe('original-generation');
  });

  it('rejects interrupt reservation for an unknown row', async () => {
    const store = createPGLiteQueuedPromptsStore(createQueueDbStub());

    await expect(store.reserveInterrupt({
      ...interruptReservation('missing-control', 'owner-a'),
    })).rejects.toThrow('queued prompt missing-control does not exist');
  });

  it('records a bounded interrupt receipt and rejects an oversized receipt without mutation', async () => {
    const db = createQueueDbStub();
    const store = createPGLiteQueuedPromptsStore(db);
    const control = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-1',
      prompt: 'inspect obligation',
      idempotencyKey: 'watcher:event-receipt',
      producer: 'watcher_obligation_event',
      controlOperation: 'terminal_observed',
    });
    const receipt = {
      generation: 'generation-1',
      method: 'provider-interrupt',
      outcome: 'interrupted',
    };

    const reserved = await store.reserveInterrupt(interruptReservation(control.id, 'owner-a'));
    await store.claimInterruptCleanup({
      id: control.id,
      expectedGeneration: 'generation-1',
      reservationOwner: reserved.row.interruptReservationOwner!,
      operationId: reserved.row.interruptOperationId!,
      fence: reserved.row.interruptFence!,
    });
    const recorded = await store.recordInterruptReceipt({
      id: control.id,
      expectedGeneration: 'generation-1',
      reservationOwner: reserved.row.interruptReservationOwner!,
      operationId: reserved.row.interruptOperationId!,
      fence: reserved.row.interruptFence!,
      receipt,
      finalizedAt: new Date('2026-07-20T10:00:00.500Z'),
    });
    expect(recorded.interruptReceipt).toEqual(receipt);
    const beforeOversized = await db.query<QueuedPromptRow>(
      'SELECT * FROM queued_prompts WHERE id = $1',
      [control.id],
    );

    await expect(store.recordInterruptReceipt({
      id: control.id,
      expectedGeneration: 'generation-1',
      reservationOwner: 'owner-a',
      operationId: reserved.row.interruptOperationId!,
      fence: reserved.row.interruptFence!,
      receipt: { detail: 'x'.repeat(4097) },
      finalizedAt: new Date('2026-07-20T10:00:00.500Z'),
    })).rejects.toThrow('serialized receipt exceeds 4096 bytes');

    const afterOversized = await db.query<QueuedPromptRow>(
      'SELECT * FROM queued_prompts WHERE id = $1',
      [control.id],
    );
    expect(afterOversized.rows).toEqual(beforeOversized.rows);
  });

  it('rejects an interrupt receipt for an unknown row', async () => {
    const store = createPGLiteQueuedPromptsStore(createQueueDbStub());

    await expect(store.recordInterruptReceipt({
      id: 'missing-control',
      expectedGeneration: 'generation-1',
      reservationOwner: 'owner-a',
      operationId: 'missing-operation',
      fence: 1,
      receipt: { outcome: 'failed' },
      finalizedAt: new Date('2026-07-20T10:00:00.500Z'),
    })).rejects.toThrow('queued prompt missing-control does not exist');
  });

  it('cleans up terminal ordinary rows but retains old pending/executing control rows', async () => {
    const db = createQueueDbStub();
    const store = createPGLiteQueuedPromptsStore(db);
    await store.create({ id: 'ordinary-completed', sessionId: 'session-1', prompt: 'done' });
    await store.complete('ordinary-completed');
    const pendingControl = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-1',
      prompt: 'pending control',
      idempotencyKey: 'watcher:event-pending',
      producer: 'watcher_obligation_event',
      controlOperation: 'terminal_observed',
    });
    const executingControl = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-1',
      prompt: 'executing control',
      idempotencyKey: 'watcher:event-executing',
      producer: 'watcher_obligation_event',
      controlOperation: 'liveness_breach',
    });
    await store.claim(executingControl.id);

    expect(await store.cleanup(1)).toBe(1);
    const direct = await db.query<QueuedPromptRow>('SELECT * FROM queued_prompts');
    expect(direct.rows.map((row) => ({ id: row.id, status: row.status }))).toEqual([
      { id: pendingControl.id, status: 'pending' },
      { id: executingControl.id, status: 'executing' },
    ]);
  });

  it('retains old terminal control rows while deleting equally-old terminal ordinary rows', async () => {
    const db = createQueueDbStub({ createdAtBase: Date.now() - 48 * 60 * 60 * 1000 });
    const store = createPGLiteQueuedPromptsStore(db);
    await store.create({ id: 'ordinary-completed', sessionId: 'session-1', prompt: 'ordinary done' });
    const control = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-1',
      prompt: 'control done',
      idempotencyKey: 'watcher:event-completed',
      producer: 'watcher_obligation_event',
      controlOperation: 'terminal_observed',
    });
    await store.complete('ordinary-completed');
    await store.complete(control.id);
    const controlBeforeCleanup = await store.get(control.id);

    expect(await store.cleanup(24 * 60 * 60 * 1000)).toBe(1);
    expect(await store.get('ordinary-completed')).toBeNull();
    expect(await store.get(control.id)).toEqual(controlBeforeCleanup);
  });

  it('does not abandon old pending control rows during the boot sweep', async () => {
    const db = createQueueDbStub({ createdAtBase: Date.now() - 25 * 60 * 60 * 1000 });
    const store = createPGLiteQueuedPromptsStore(db);
    await store.create({ id: 'old-ordinary', sessionId: 'session-1', prompt: 'ordinary' });
    const control = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-1',
      prompt: 'control',
      idempotencyKey: 'watcher:event-old-control',
      producer: 'watcher_obligation_event',
      controlOperation: 'terminal_observed',
    });

    expect(await store.sweepExecutingOnBoot()).toEqual({ completed: 1, failed: 0, rolledBack: 0 });
    const direct = await db.query<QueuedPromptRow>('SELECT * FROM queued_prompts');
    expect(direct.rows.map((row) => ({ id: row.id, status: row.status }))).toEqual([
      { id: 'old-ordinary', status: 'completed' },
      { id: control.id, status: 'pending' },
    ]);
  });
});

describe('QueuedPromptsStore interrupt leases across both database adapters', () => {
  let pglite: PGlite;
  let sqlite: SQLiteDatabase;
  let tempDir: string;
  let pgliteStore: ReturnType<typeof createPGLiteQueuedPromptsStore>;
  let sqliteStore: ReturnType<typeof createPGLiteQueuedPromptsStore>;

  beforeAll(async () => {
    pglite = new PGlite();
    await (pglite as unknown as { waitReady: Promise<void> }).waitReady;
    await pglite.exec(`
      CREATE TABLE queued_prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attachments JSONB,
        document_context JSONB,
        delivery_class TEXT NOT NULL DEFAULT 'ordinary',
        priority_rank INTEGER NOT NULL DEFAULT 0,
        producer TEXT,
        idempotency_key TEXT,
        request_digest TEXT,
        control_operation TEXT,
        interrupt_target_generation TEXT,
        interrupt_reservation_owner TEXT,
        interrupt_lease_expires_at TIMESTAMPTZ,
        interrupt_operation_id TEXT,
        interrupt_fence INTEGER NOT NULL DEFAULT 0,
        interrupt_application_state TEXT NOT NULL DEFAULT 'not_started',
        interrupt_started_at TIMESTAMPTZ,
        interrupt_applied_at TIMESTAMPTZ,
        interrupt_application_receipt JSONB,
        interrupt_cleanup_state TEXT NOT NULL DEFAULT 'pending',
        interrupt_cleanup_fence INTEGER NOT NULL DEFAULT 0,
        interrupt_receipt JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        claimed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_message TEXT
      );
      CREATE UNIQUE INDEX idx_test_queued_prompts_idempotency
        ON queued_prompts(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE host_control_store_identity (
        singleton INTEGER PRIMARY KEY,
        store_id TEXT NOT NULL UNIQUE,
        authority_root TEXT NOT NULL
      );
    `);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-interrupt-leases-'));
    await pglite.query(
      `INSERT INTO host_control_store_identity (singleton, store_id, authority_root)
       VALUES (1, $1, $2)`,
      ['pglite-queued-prompts-test', path.join(tempDir, 'pglite-authority')],
    );
    sqlite = new SQLiteDatabase({
      dbDir: tempDir,
      schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();
    sqlite.getRawHandle()!.prepare(
      'INSERT OR IGNORE INTO ai_sessions(id, provider) VALUES (?, ?)',
    ).run('session-lease', 'claude');
    pgliteStore = createProductionQueuedPromptsStore(pglite);
    sqliteStore = createProductionQueuedPromptsStore(createSQLiteStoreAdapter(sqlite));
  });

  beforeEach(async () => {
    await pglite.exec('DELETE FROM queued_prompts;');
    sqlite.getRawHandle()!.exec('DELETE FROM queued_prompts;');
  });

  afterAll(async () => {
    await sqlite.close();
    await pglite.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s grants one expired-lease takeover and preserves generation A', async (_name, getStore) => {
    const store = getStore();
    const row = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-lease',
      prompt: 'bounded control prompt',
      idempotencyKey: `lease:${_name}`,
      producer: 'test',
      controlOperation: 'test',
    });
    const original = await store.reserveInterrupt(interruptReservation(row.id, 'dead-owner'));
    if (_name === 'PGLite') {
      await pglite.query('UPDATE queued_prompts SET interrupt_lease_expires_at = NOW() WHERE id = $1', [row.id]);
    } else {
      await createSQLiteStoreAdapter(sqlite).query(
        'UPDATE queued_prompts SET interrupt_lease_expires_at = NOW() WHERE id = $1',
        [row.id],
      );
    }
    const takeoverAt = Date.now() + 60_000;
    const results = await Promise.all([
      store.reserveInterrupt(interruptReservation(row.id, 'owner-a', takeoverAt)),
      store.reserveInterrupt(interruptReservation(row.id, 'owner-b', takeoverAt)),
    ]);

    expect(results.filter((result) => result.takenOver)).toHaveLength(1);
    expect(results.filter((result) => result.reserved)).toHaveLength(1);
    expect(results.find((result) => result.takenOver)?.row.interruptTargetGeneration)
      .toBe('generation-1');
    const winner = results.find((result) => result.takenOver)!;
    expect(winner.row.interruptFence).toBe((original.row.interruptFence ?? 0) + 1);
    expect((await store.beginInterruptApplication({
      id: row.id,
      expectedGeneration: 'generation-1',
      reservationOwner: 'dead-owner',
      operationId: original.row.interruptOperationId!,
      fence: original.row.interruptFence!,
      now: new Date(takeoverAt + 1),
    })).started).toBe(false);
    expect((await store.beginInterruptApplication({
      id: row.id,
      expectedGeneration: 'generation-1',
      reservationOwner: winner.row.interruptReservationOwner!,
      operationId: winner.row.interruptOperationId!,
      fence: winner.row.interruptFence!,
      now: new Date(takeoverAt + 1),
    })).started).toBe(true);
    await expect(store.recordInterruptApplication({
      id: row.id,
      expectedGeneration: 'generation-1',
      reservationOwner: 'dead-owner',
      operationId: original.row.interruptOperationId!,
      fence: original.row.interruptFence!,
      certainty: 'applied',
      receipt: { success: true },
      appliedAt: new Date(takeoverAt + 2),
    })).rejects.toThrow('interrupt_application_ownership_lost');
    await expect(store.recordInterruptReceipt({
      id: row.id,
      expectedGeneration: 'generation-1',
      reservationOwner: 'dead-owner',
      operationId: original.row.interruptOperationId!,
      fence: original.row.interruptFence!,
      receipt: { success: false },
      finalizedAt: new Date(takeoverAt + 2),
    })).rejects.toThrow('interrupt_receipt_ownership_lost');
    await store.recordInterruptApplication({
      id: row.id,
      expectedGeneration: 'generation-1',
      reservationOwner: winner.row.interruptReservationOwner!,
      operationId: winner.row.interruptOperationId!,
      fence: winner.row.interruptFence!,
      certainty: 'not_applied',
      receipt: { certainty: 'not_applied', winner: 'persisted' },
      appliedAt: new Date(takeoverAt + 2),
    });
    await expect(store.recordInterruptApplication({
      id: row.id,
      expectedGeneration: 'generation-1',
      reservationOwner: winner.row.interruptReservationOwner!,
      operationId: winner.row.interruptOperationId!,
      fence: winner.row.interruptFence!,
      certainty: 'not_applied',
      receipt: { certainty: 'not_applied', winner: 'different' },
      appliedAt: new Date(takeoverAt + 2),
    })).rejects.toThrow('interrupt_application_receipt_conflict');
  });

  it.each([
    ['PGLite', () => pgliteStore, 'before-native'],
    ['SQLite', () => sqliteStore, 'before-native'],
    ['PGLite', () => pgliteStore, 'after-entry-before-fact'],
    ['SQLite', () => sqliteStore, 'after-entry-before-fact'],
    ['PGLite', () => pgliteStore, 'after-fact-before-terminal'],
    ['SQLite', () => sqliteStore, 'after-fact-before-terminal'],
  ] as const)(
    '%s reconstructs the %s process-loss gap on one real durable row',
    async (_name, getStore, gap) => {
      const store = getStore();
      let now = Date.now() + 60_000;
      const providerInterrupt = vi.fn(async () => ({ method: 'provider-interrupt' }));
      const makeDeps = (owner: string, queueStore: any, replacementB: boolean) => {
        const activeGeneration = replacementB ? 'generation-b' : 'generation-1';
        return {
          getSession: vi.fn(async () => ({
            id: 'session-lease', workspacePath: 'D:\\workspace', isArchived: false,
          })),
          resolveDispatchTarget: resolveQueuedPromptDispatchTarget,
          queueStore,
          getCurrentAttentionGeneration: vi.fn(async () => activeGeneration),
          getSessionStatus: vi.fn(async () => 'running' as const),
          interruptCurrentTurnForSession: (sessionId: string, options: any) => (
            runInterruptCurrentTurnForSession({
              getSession: async () => ({ provider: 'test-provider' }),
              setSessionPendingPrompt: vi.fn(),
              cancelAllAttentionForSession: vi.fn(),
              isTerminalActive: () => false,
              writeToTerminal: vi.fn(),
              getProvider: () => ({ interruptCurrentTurn: providerInterrupt }),
              deleteFromProcessingQueue: vi.fn(),
              sweepExecutingForSession: vi.fn(),
              getCurrentAttentionGeneration: () => activeGeneration,
              getSessionStatus: () => 'running',
              logInfo: vi.fn(),
              logError: vi.fn(),
            } as any, sessionId, options)
          ),
          triggerQueuedPromptProcessingForSession: vi.fn(async () => true),
          now: () => now,
          createInterruptReservationOwner: () => owner,
          interruptReservationLeaseMs: 1_000,
        };
      };
      const delivery = {
        sessionId: 'session-lease', workspacePath: 'D:\\workspace',
        prompt: `crash gap ${gap}`, idempotencyKey: `${_name}:${gap}`,
        producer: 'test', controlOperation: 'race-reconciliation',
      };
      let firstStore: any = store;
      if (gap === 'after-entry-before-fact') {
        firstStore = {
          ...store,
          recordInterruptApplication: vi.fn(async () => {
            throw new Error('simulated_process_loss_after_entry');
          }),
        };
      }
      const firstDeps: any = makeDeps('owner-a', firstStore, false);
      if (gap === 'before-native') {
        firstDeps.onInterruptReconciliationPoint = vi.fn(async (point: string) => {
          if (point === 'after_interrupt_reserved') throw new Error('simulated_process_loss_before_native');
        });
      } else if (gap === 'after-fact-before-terminal') {
        firstDeps.onInterruptReconciliationPoint = vi.fn(async (point: string) => {
          if (point === 'after_interrupt_application_recorded') {
            throw new Error('simulated_process_loss_after_fact');
          }
        });
      }

      await expect(createPriorityPromptDeliveryService(firstDeps).deliverPriorityPrompt(delivery))
        .rejects.toThrow('simulated_process_loss');
      const callsBeforeRecovery = providerInterrupt.mock.calls.length;
      expect(callsBeforeRecovery).toBe(gap === 'before-native' ? 0 : 1);

      if (_name === 'PGLite') {
        await pglite.query('UPDATE queued_prompts SET interrupt_lease_expires_at = NOW() WHERE idempotency_key = $1', [delivery.idempotencyKey]);
      } else {
        await createSQLiteStoreAdapter(sqlite).query(
          'UPDATE queued_prompts SET interrupt_lease_expires_at = NOW() WHERE idempotency_key = $1',
          [delivery.idempotencyKey],
        );
      }
      now += 120_000;
      const recoveryDeps: any = makeDeps('owner-b', store, true);
      const recovered = await createPriorityPromptDeliveryService(recoveryDeps)
        .deliverPriorityPrompt(delivery);
      const durable = await store.getByIdempotencyKey(delivery.idempotencyKey);

      expect(providerInterrupt.mock.calls.length).toBe(callsBeforeRecovery);
      expect(recovered.interrupt?.generation).toBe('generation-1');
      expect(durable?.interruptReceipt).toEqual(expect.objectContaining({
        generation: 'generation-1',
      }));
      expect(durable?.interruptFence).toBe(2);
    },
  );

  it.each([
    ['PGLite', 'claude-code', () => pglite as any],
    ['PGLite', 'claude-code-cli', () => pglite as any],
    ['SQLite', 'claude-code', () => createSQLiteStoreAdapter(sqlite) as any],
    ['SQLite', 'claude-code-cli', () => createSQLiteStoreAdapter(sqlite) as any],
  ] as const)('%s/%s excludes O1 while O2 is paused after takeover CAS commit and before fence publication', async (_name, providerType, getDb) => {
    const db = getDb();
    const operationLockDirectory = path.join(tempDir, `interrupt-lock-${_name}-${providerType}`);
    const storeIdentity = {
      storeId: `interrupt-entry-store-${_name}-${providerType}`,
      authorityRoot: operationLockDirectory,
    };
    vi.resetModules();
    const ownerOneCoordinatorModule = await import('../HostControlMutationCoordinator');
    vi.resetModules();
    const ownerTwoCoordinatorModule = await import('../HostControlMutationCoordinator');
    expect(ownerOneCoordinatorModule).not.toBe(ownerTwoCoordinatorModule);
    const store = createPGLiteQueuedPromptsStore(db, undefined, {
      mutationCoordinator: ownerOneCoordinatorModule.createHostControlMutationCoordinator({
        acquireTimeoutMs: 500,
      }),
      storeIdentity,
    });
    const base = Date.now() + 60_000;
    const row = await store.createPriorityControlQueuedPrompt({
      sessionId: 'session-lease',
      prompt: 'exact entry-fence schedule',
      idempotencyKey: `entry-fence:${_name}`,
      producer: 'test',
      controlOperation: 'race-reconciliation',
    });
    const first = await store.reserveInterrupt({
      id: row.id,
      expectedGeneration: 'generation-1',
      reservationOwner: 'owner-a',
      now: new Date(base),
      leaseExpiresAt: new Date(base + 1_000),
    });
    await store.beginInterruptApplication({
      id: row.id,
      expectedGeneration: 'generation-1',
      reservationOwner: 'owner-a',
      operationId: first.row.interruptOperationId!,
      fence: first.row.interruptFence!,
      now: new Date(base),
    });
    await db.query('UPDATE queued_prompts SET interrupt_lease_expires_at = NOW() WHERE id = $1', [row.id]);

    const atTakeoverCommit = boundedBarrier('interrupt_takeover_committed');
    const resumeTakeover = boundedBarrier('interrupt_takeover_resume');
    const takeoverStore = createPGLiteQueuedPromptsStore(db, undefined, {
      mutationCoordinator: ownerTwoCoordinatorModule.createHostControlMutationCoordinator({
        acquireTimeoutMs: 500,
      }),
      storeIdentity,
      afterInterruptReservationCommitted: async ({ takenOver }) => {
        if (!takenOver) return;
        atTakeoverCommit.release();
        await resumeTakeover.promise;
      },
    });
    const takeoverPromise = takeoverStore.reserveInterrupt({
      id: row.id,
      expectedGeneration: 'generation-1',
      reservationOwner: 'owner-b',
      now: new Date(base + 1_000),
      leaseExpiresAt: new Date(base + 2_000),
    });
    const providerInterrupt = vi.fn(async () => ({ method: 'provider-interrupt' }));
    const terminalWrite = vi.fn();
    let pending: ReturnType<typeof runInterruptCurrentTurnForSession> | undefined;
    try {
      await atTakeoverCommit.promise;
      pending = runInterruptCurrentTurnForSession({
        getSession: async () => ({ provider: providerType }),
        setSessionPendingPrompt: vi.fn(),
        cancelAllAttentionForSession: vi.fn(),
        isTerminalActive: () => true,
        writeToTerminal: terminalWrite,
        getProvider: () => ({ interruptCurrentTurn: providerInterrupt }),
        deleteFromProcessingQueue: vi.fn(),
        sweepExecutingForSession: vi.fn(),
        getCurrentAttentionGeneration: () => 'generation-1',
        getSessionStatus: () => 'running',
        logInfo: vi.fn(),
        logError: vi.fn(),
      } as any, 'session-lease', {
        expectedGeneration: 'generation-1',
        priorityRowId: row.id,
        operationId: first.row.interruptOperationId!,
        fence: first.row.interruptFence!,
        assertInterruptFence: () => store.verifyInterruptApplication({
          id: row.id,
          expectedGeneration: 'generation-1',
          reservationOwner: 'owner-a',
          operationId: first.row.interruptOperationId!,
          fence: first.row.interruptFence!,
          now: new Date(base + 1_000),
        }),
        enterInterruptApplication: (action) => store.enterInterruptApplication!({
          id: row.id,
          expectedGeneration: 'generation-1',
          reservationOwner: 'owner-a',
          operationId: first.row.interruptOperationId!,
          fence: first.row.interruptFence!,
        }, action),
      });
      await Promise.resolve();
      expect(providerInterrupt).not.toHaveBeenCalled();
      expect(terminalWrite).not.toHaveBeenCalled();

      resumeTakeover.release();
      const takeover = await takeoverPromise;
      expect(takeover.takenOver).toBe(true);
      await expect(pending).resolves.toMatchObject({
        success: false,
        nativeCertainty: 'not_applied',
        nativeEntered: false,
      });
      expect(providerInterrupt).not.toHaveBeenCalled();
      expect(terminalWrite).not.toHaveBeenCalled();
      expect((await store.get(row.id))?.interruptFence).toBe(2);
    } finally {
      resumeTakeover.release();
      atTakeoverCommit.dispose();
      resumeTakeover.dispose();
      await takeoverPromise.catch(() => undefined);
      if (pending) await pending.catch(() => undefined);
    }
  });

  it('executes the production PGLite queued-row upgrade and fences legacy unknown application', async () => {
    const legacy = new PGlite();
    await (legacy as unknown as { waitReady: Promise<void> }).waitReady;
    try {
      await legacy.exec(`
        CREATE TABLE queued_prompts (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', interrupt_target_generation TEXT,
          interrupt_receipt JSONB
        );
        INSERT INTO queued_prompts(
          id, session_id, prompt, interrupt_target_generation, interrupt_receipt)
        VALUES ('legacy-unknown', 'session', 'prompt', 'generation-a', NULL);
      `);
      const workerSource = fs.readFileSync(
        path.resolve(__dirname, '../../database/worker.js'),
        'utf8',
      );
      const productionUpgrade = workerSource.match(
        /ALTER TABLE queued_prompts ADD COLUMN IF NOT EXISTS interrupt_reservation_owner[\s\S]*?UPDATE queued_prompts[\s\S]*?AND interrupt_operation_id IS NULL;/,
      )?.[0];
      expect(productionUpgrade).toBeTruthy();
      await legacy.exec(productionUpgrade!);
      const result = await legacy.query<any>(`
        SELECT interrupt_reservation_owner, interrupt_lease_expires_at,
               interrupt_operation_id, interrupt_fence, interrupt_application_state
        FROM queued_prompts WHERE id = 'legacy-unknown'
      `);
      expect(result.rows[0]).toMatchObject({
        interrupt_reservation_owner: 'legacy-orphan',
        interrupt_operation_id: 'legacy-interrupt:legacy-unknown:generation-a',
        interrupt_fence: 0,
        interrupt_application_state: 'legacy_unknown',
      });
      expect(new Date(result.rows[0].interrupt_lease_expires_at).getTime()).toBe(0);

      await legacy.exec(`
        INSERT INTO queued_prompts(
          id, session_id, prompt, interrupt_target_generation,
          interrupt_reservation_owner, interrupt_lease_expires_at,
          interrupt_operation_id, interrupt_fence, interrupt_application_state,
          interrupt_cleanup_state, interrupt_cleanup_fence)
        VALUES
          ('modern-not-started', 'session', 'prompt', 'generation-modern',
           'owner-modern', TIMESTAMPTZ '2026-07-20 10:00:00+00',
           'priority-interrupt:modern-1', 7, 'not_started', 'claimed', 7),
          ('modern-unknown', 'session', 'prompt', 'generation-modern',
           'owner-modern', TIMESTAMPTZ '2026-07-20 10:00:00+00',
           'priority-interrupt:modern-2', 8, 'unknown', 'pending', 0),
          ('modern-applied', 'session', 'prompt', 'generation-modern',
           'owner-modern', TIMESTAMPTZ '2026-07-20 10:00:00+00',
           'priority-interrupt:modern-3', 9, 'applied', 'complete', 9);
      `);
      await legacy.exec(productionUpgrade!);
      const modern = await legacy.query<any>(`
        SELECT id, interrupt_reservation_owner, interrupt_operation_id,
               interrupt_fence, interrupt_application_state,
               interrupt_cleanup_state, interrupt_cleanup_fence
        FROM queued_prompts WHERE id LIKE 'modern-%' ORDER BY id
      `);
      expect(modern.rows).toEqual([
        expect.objectContaining({
          id: 'modern-applied', interrupt_reservation_owner: 'owner-modern',
          interrupt_operation_id: 'priority-interrupt:modern-3',
          interrupt_fence: 9, interrupt_application_state: 'applied',
          interrupt_cleanup_state: 'complete', interrupt_cleanup_fence: 9,
        }),
        expect.objectContaining({
          id: 'modern-not-started', interrupt_reservation_owner: 'owner-modern',
          interrupt_operation_id: 'priority-interrupt:modern-1',
          interrupt_fence: 7, interrupt_application_state: 'not_started',
          interrupt_cleanup_state: 'claimed', interrupt_cleanup_fence: 7,
        }),
        expect.objectContaining({
          id: 'modern-unknown', interrupt_reservation_owner: 'owner-modern',
          interrupt_operation_id: 'priority-interrupt:modern-2',
          interrupt_fence: 8, interrupt_application_state: 'unknown',
          interrupt_cleanup_state: 'pending', interrupt_cleanup_fence: 0,
        }),
      ]);
    } finally {
      await legacy.close();
    }
  });
});

describe('PGLiteQueuedPromptsStore.rollbackExecuting', () => {
  it('resets executing rows for the given session back to pending', async () => {
    const query = vi.fn(async (sql: string, params?: any[]) => {
      expect(sql).toContain("SET status = 'pending'");
      expect(sql).toContain('claimed_at = NULL');
      expect(sql).toContain("status = 'executing'");
      expect(sql).toContain('WHERE session_id = $1');
      expect(params).toEqual(['session-abc']);
      return { rows: [{ id: 'prompt-1' }, { id: 'prompt-2' }] };
    });
    const db: DbStub = { query: query as any };

    const store = createPGLiteQueuedPromptsStore(db);
    const rolledBack = await store.rollbackExecuting('session-abc');

    expect(rolledBack).toBe(2);
    expect(query).toHaveBeenCalledOnce();
  });

  it('returns 0 when no rows are stuck in executing', async () => {
    const db: DbStub = { query: (async () => ({ rows: [] })) as any };

    const store = createPGLiteQueuedPromptsStore(db);
    const rolledBack = await store.rollbackExecuting('session-no-rows');

    expect(rolledBack).toBe(0);
  });

  it('is scoped to the given session id only', async () => {
    let capturedParams: any[] | undefined;
    const db: DbStub = {
      query: (async (_sql: string, params?: any[]) => {
        capturedParams = params;
        return { rows: [] };
      }) as any,
    };

    const store = createPGLiteQueuedPromptsStore(db);
    await store.rollbackExecuting('session-only-this-one');

    expect(capturedParams).toEqual(['session-only-this-one']);
  });
});

describe('PGLiteQueuedPromptsStore.rollbackAllExecuting', () => {
  it('resets every executing row across all sessions', async () => {
    const query = vi.fn(async (sql: string, params?: any[]) => {
      expect(sql).toContain("SET status = 'pending'");
      expect(sql).toContain('claimed_at = NULL');
      expect(sql).toContain("status = 'executing'");
      expect(sql).not.toContain('session_id');
      expect(params).toBeUndefined();
      return { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    });
    const db: DbStub = { query: query as any };

    const store = createPGLiteQueuedPromptsStore(db);
    const rolledBack = await store.rollbackAllExecuting();

    expect(rolledBack).toBe(3);
  });

  it('is idempotent when the table has no stuck rows', async () => {
    const db: DbStub = { query: (async () => ({ rows: [] })) as any };

    const store = createPGLiteQueuedPromptsStore(db);
    expect(await store.rollbackAllExecuting()).toBe(0);
    expect(await store.rollbackAllExecuting()).toBe(0);
  });
});

describe('PGLiteQueuedPromptsStore.sweepExecutingOnBoot', () => {
  it('completes answered rows, fails delivered-but-unanswered ones, rolls back undelivered ones', async () => {
    const calls: { sql: string; params?: any[] }[] = [];
    const db: DbStub = {
      query: (async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        // Pass 1: completed-update returns rows with delivery AND output evidence
        if (sql.includes("SET status = 'completed'")) {
          return { rows: [{ id: 'answered-1' }, { id: 'answered-2' }] };
        }
        // Pass 2: failed-update returns delivered rows with no output evidence
        if (sql.includes("SET status = 'failed'")) {
          return { rows: [{ id: 'unanswered-1' }] };
        }
        // Pass 3: rollback-update returns the remaining stuck rows
        if (sql.includes("SET status = 'pending'") && sql.includes('claimed_at = NULL')) {
          return { rows: [{ id: 'undelivered-1' }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }) as any,
    };

    const store = createPGLiteQueuedPromptsStore(db);
    const result = await store.sweepExecutingOnBoot();

    expect(result).toEqual({ completed: 2, failed: 1, rolledBack: 1 });
    expect(calls).toHaveLength(3);

    // First pass: executing rows need BOTH the delivered input row AND
    // output evidence after claimed_at to count as completed (#783: a
    // delivered input alone does not prove the agent ever responded).
    // Pending-with-content-match and 24h-abandoned branches stay.
    expect(calls[0].sql).toContain("SET status = 'completed'");
    expect(calls[0].sql).toContain("status = 'executing'");
    expect(calls[0].sql).toContain("status = 'pending'");
    expect(calls[0].sql).toContain('claimed_at IS NOT NULL');
    expect(calls[0].sql).toContain('ai_agent_messages');
    expect(calls[0].sql).toContain("direction = 'input'");
    expect(calls[0].sql).toContain("direction = 'output'");
    expect(calls[0].sql).toContain('m.created_at >= queued_prompts.claimed_at');
    expect(calls[0].sql).toContain('m.created_at >= queued_prompts.created_at');
    expect(calls[0].sql).toContain('POSITION(queued_prompts.prompt IN m.content)');

    // Second pass: delivered-but-unanswered rows become a VISIBLE terminal
    // state, never 'completed' (silent success) and never 'pending'
    // (re-claim would re-send the delivered input, regressing NIM-615).
    // The pass re-checks output absence itself (NOT EXISTS) so it stays
    // correct even if an output row commits between the two statements.
    expect(calls[1].sql).toContain("SET status = 'failed'");
    expect(calls[1].sql).toContain('error_message');
    expect(calls[1].sql).toContain("status = 'executing'");
    expect(calls[1].sql).toContain('claimed_at IS NOT NULL');
    expect(calls[1].sql).toContain("direction = 'input'");
    expect(calls[1].sql).toContain('NOT EXISTS');
    expect(calls[1].sql).toContain("direction = 'output'");

    // Third pass: rolls back anything still executing (i.e. undelivered)
    expect(calls[2].sql).toContain("SET status = 'pending'");
    expect(calls[2].sql).toContain('claimed_at = NULL');
    expect(calls[2].sql).toContain("status = 'executing'");
  });

  it('fails a delivered executing row with no output after claimed_at instead of completing it (#783)', async () => {
    // Karl's forensic case: input row logged after claim, app quit
    // SIGTERM'd the provider, zero output events persisted. The old sweep
    // marked the row completed and the session looked answered-and-idle.
    const calls: { sql: string; params?: any[] }[] = [];
    const db: DbStub = {
      query: (async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        if (sql.includes("SET status = 'completed'")) {
          return { rows: [] };
        }
        if (sql.includes("SET status = 'failed'")) {
          return { rows: [{ id: 'local-1783443721220-i0jrwc8' }] };
        }
        if (sql.includes("SET status = 'pending'")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }) as any,
    };

    const store = createPGLiteQueuedPromptsStore(db);
    const result = await store.sweepExecutingOnBoot();

    expect(result).toEqual({ completed: 0, failed: 1, rolledBack: 0 });
  });

  it('returns zeros when nothing was executing', async () => {
    const db: DbStub = { query: (async () => ({ rows: [] })) as any };

    const store = createPGLiteQueuedPromptsStore(db);
    expect(await store.sweepExecutingOnBoot()).toEqual({ completed: 0, failed: 0, rolledBack: 0 });
  });

  it('completes pending rows that match a delivered input message (leftover-corruption cleanup)', async () => {
    // Simulates the leftover state after a pre-fix build's
    // rollbackAllExecuting boot sweep set already-delivered rows back to
    // pending. The new sweep should catch them by matching prompt text
    // against ai_agent_messages content.
    let completedSql = '';
    const db: DbStub = {
      query: (async (sql: string) => {
        if (sql.includes("SET status = 'completed'")) {
          completedSql = sql;
          return { rows: [{ id: 'leftover-1' }, { id: 'leftover-2' }, { id: 'leftover-3' }] };
        }
        if (sql.includes("SET status = 'failed'") || sql.includes("SET status = 'pending'")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }) as any,
    };

    const store = createPGLiteQueuedPromptsStore(db);
    const result = await store.sweepExecutingOnBoot();

    expect(result).toEqual({ completed: 3, failed: 0, rolledBack: 0 });
    // The combined query must contain both branches so an existing
    // pending row whose prompt text already appears in the conversation
    // gets cleaned up alongside the executing-but-delivered case.
    expect(completedSql).toContain("status = 'pending'");
    expect(completedSql).toContain('POSITION(queued_prompts.prompt IN m.content)');
  });

  it('completes pending rows older than 24h regardless of content match (abandoned cleanup)', async () => {
    let completedSql = '';
    const db: DbStub = {
      query: (async (sql: string) => {
        if (sql.includes("SET status = 'completed'")) {
          completedSql = sql;
          return { rows: [{ id: 'abandoned-1' }, { id: 'abandoned-2' }] };
        }
        if (sql.includes("SET status = 'failed'") || sql.includes("SET status = 'pending'")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }) as any,
    };

    const store = createPGLiteQueuedPromptsStore(db);
    const result = await store.sweepExecutingOnBoot();

    expect(result).toEqual({ completed: 2, failed: 0, rolledBack: 0 });
    // Age branch: ordinary pending rows older than 24h are completed.
    // Handles content-match false negatives caused by JSON escaping
    // (newlines / quotes / attachments) and genuinely abandoned prompts,
    // while leaving durable control rows for their producer to finalize.
    expect(completedSql).toContain("status = 'pending'");
    expect(completedSql).toContain("delivery_class != 'control'");
    expect(completedSql).toContain("created_at < NOW() - INTERVAL '1 day'");
  });
});

describe('PGLiteQueuedPromptsStore.complete', () => {
  it('clears error_message so a turn resolving after a provisional sweep-fail does not keep the stale error', async () => {
    const query = vi.fn(async (sql: string, params?: any[]) => {
      expect(sql).toContain("SET status = 'completed'");
      expect(sql).toContain('error_message = NULL');
      expect(params).toEqual(['prompt-1']);
      return { rows: [] };
    });
    const db: DbStub = { query: query as any };

    const store = createPGLiteQueuedPromptsStore(db);
    await store.complete('prompt-1');

    expect(query).toHaveBeenCalledOnce();
  });
});

describe('PGLiteQueuedPromptsStore.sweepExecutingForSession', () => {
  it('scopes all three passes to the given session id', async () => {
    const calls: { sql: string; params?: any[] }[] = [];
    const db: DbStub = {
      query: (async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        if (sql.includes("SET status = 'completed'")) {
          return { rows: [{ id: 'answered-1' }] };
        }
        if (sql.includes("SET status = 'failed'")) {
          return { rows: [{ id: 'unanswered-1' }] };
        }
        if (sql.includes("SET status = 'pending'")) {
          return { rows: [{ id: 'undelivered-1' }, { id: 'undelivered-2' }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }) as any,
    };

    const store = createPGLiteQueuedPromptsStore(db);
    const result = await store.sweepExecutingForSession('session-xyz');

    expect(result).toEqual({ completed: 1, failed: 1, rolledBack: 2 });
    expect(calls).toHaveLength(3);

    // Pass 1: completion needs input AND output evidence, session-scoped
    // (#790: an interrupt sweep marked a delivered-but-never-answered
    // prompt completed on the input row alone).
    expect(calls[0].sql).toContain("SET status = 'completed'");
    expect(calls[0].sql).toContain("session_id = $1");
    expect(calls[0].sql).toContain('claimed_at IS NOT NULL');
    expect(calls[0].sql).toContain('ai_agent_messages');
    expect(calls[0].sql).toContain("direction = 'input'");
    expect(calls[0].sql).toContain("direction = 'output'");
    expect(calls[0].sql).toContain('m.created_at >= queued_prompts.claimed_at');
    expect(calls[0].params).toEqual(['session-xyz']);

    // Pass 2: delivered-but-unanswered rows go to a visible failed state,
    // with an independent no-output recheck (NOT EXISTS)
    expect(calls[1].sql).toContain("SET status = 'failed'");
    expect(calls[1].sql).toContain('error_message');
    expect(calls[1].sql).toContain('session_id = $1');
    expect(calls[1].sql).toContain('NOT EXISTS');
    expect(calls[1].params?.[0]).toBe('session-xyz');
    expect(calls[1].params?.[1]).toContain('interrupted before a response was recorded');

    // Pass 3: roll back undelivered executing rows for the same session
    expect(calls[2].sql).toContain("SET status = 'pending'");
    expect(calls[2].sql).toContain('claimed_at = NULL');
    expect(calls[2].sql).toContain("status = 'executing'");
    expect(calls[2].sql).toContain('session_id = $1');
    expect(calls[2].params).toEqual(['session-xyz']);
  });

  it('returns zeros when the session has no executing rows', async () => {
    const db: DbStub = { query: (async () => ({ rows: [] })) as any };

    const store = createPGLiteQueuedPromptsStore(db);
    expect(await store.sweepExecutingForSession('session-clean')).toEqual({
      completed: 0,
      failed: 0,
      rolledBack: 0,
    });
  });
});
