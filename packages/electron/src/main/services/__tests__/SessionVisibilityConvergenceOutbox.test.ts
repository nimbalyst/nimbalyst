import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SessionVisibilityConvergenceOutbox,
  type SessionVisibilityDeliveryDescriptor,
} from '../SessionVisibilityConvergenceOutbox';
import type { SessionVisibilityAuditEvent } from '../SessionVisibilityControlService';

const auditEvent: SessionVisibilityAuditEvent = {
  event: 'session_visibility_control',
  auditId: 'audit-restart',
  timestamp: '2026-07-20T00:00:00.000Z',
  source: 'mcp-host',
  operation: 'session_set_pinned',
  outcome: 'changed',
  actorSessionId: 'actor',
  actorKind: 'session',
  targetSessionId: 'target',
  workspaceId: 'ws-redacted',
  before: { pinned: false },
  after: { pinned: true },
  reasonCode: null,
  correlationId: 'correlation-restart',
};

const delivery: SessionVisibilityDeliveryDescriptor = {
  auditId: 'audit-restart',
  operation: 'session_set_pinned',
  targetSessionId: 'target',
  workspaceId: 'ws-redacted',
  before: { pinned: false },
  after: { pinned: true },
};

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe('SessionVisibilityConvergenceOutbox', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  it('survives reconstruction and autonomously retries audit plus renderer delivery', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-outbox-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'convergence.jsonl');

    const first = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 10,
      audit: async () => { throw new Error('audit unavailable'); },
      deliver: async () => { throw new Error('renderer unavailable'); },
    });
    await first.start();
    await first.enqueueAudit(auditEvent);
    await first.enqueueDelivery(delivery);
    await first.flush();
    expect(await first.pendingCount()).toBe(2);
    await first.close();

    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).toContain('audit-restart');
    expect(persisted).not.toContain('C:\\repo');

    const audit = vi.fn(async () => undefined);
    const deliver = vi.fn(async () => undefined);
    const reconstructed = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 10,
      audit,
      deliver,
    });
    await reconstructed.start();

    await eventually(() => {
      expect(audit).toHaveBeenCalledWith(auditEvent);
      expect(deliver).toHaveBeenCalledWith(delivery);
    });
    await eventually(() => expect(reconstructed.pendingCountSync()).toBe(0));
    await reconstructed.close();
  });

  it('recovers a reserved intent as committed after a crash-window reconstruction', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-outbox-intent-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'convergence.jsonl');
    const intent = {
      auditId: 'audit-crash-window',
      operation: 'session_set_pinned' as const,
      phase: 'reserved' as const,
      targetSessionId: 'target',
      workspaceId: 'ws-redacted',
      beforeStateId: 'before-state',
      afterStateId: 'after-state',
      mutationIdentity: 'crash-window-mutation-identity',
      audit: { ...auditEvent, auditId: 'audit-crash-window' },
      delivery: { ...delivery, auditId: 'audit-crash-window' },
    };
    const first = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 60_000,
      audit: async () => undefined,
      deliver: async () => undefined,
      resolveReservedMutation: async () => 'pending',
    });
    await first.reserveMutation(intent);
    await first.close();

    const audit = vi.fn(async () => undefined);
    const deliver = vi.fn(async () => undefined);
    const reconstructed = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 10,
      audit,
      deliver,
      resolveReservedMutation: async (candidate) =>
        candidate.afterStateId === 'after-state' ? 'committed' : 'pending',
    });
    await reconstructed.start();

    await eventually(() => {
      expect(audit).toHaveBeenCalledWith(intent.audit);
      expect(deliver).toHaveBeenCalledWith(intent.delivery);
    });
    await eventually(() => expect(reconstructed.pendingCountSync()).toBe(0));
    await reconstructed.close();
  });

  it('does not discard the oldest required event when the queue grows', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-outbox-growth-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'convergence.jsonl');
    const outbox = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 60_000,
      audit: async () => { throw new Error('offline'); },
      deliver: async () => undefined,
    });
    await outbox.start();

    for (let index = 0; index < 1_025; index += 1) {
      await outbox.enqueueAudit({ ...auditEvent, auditId: `audit-${index}` });
    }

    expect(await outbox.pendingCount()).toBe(1_025);
    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).toContain('"auditId":"audit-0"');
    expect(persisted).toContain('"auditId":"audit-1024"');
    await outbox.close();
  });

  it('repairs a torn final fragment before the next append and survives another restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-outbox-torn-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'convergence.jsonl');
    const offline = async () => { throw new Error('offline'); };

    const first = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 60_000,
      audit: offline,
      deliver: async () => undefined,
    });
    await first.enqueueAudit({ ...auditEvent, auditId: 'before-torn-write' });
    await first.close();
    await appendFile(filePath, '{"action":"put","entry":', 'utf8');

    const repaired = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 60_000,
      audit: offline,
      deliver: async () => undefined,
    });
    await repaired.start();
    await repaired.enqueueAudit({ ...auditEvent, auditId: 'after-torn-write' });
    await repaired.close();

    const restarted = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 60_000,
      audit: offline,
      deliver: async () => undefined,
    });
    await expect(restarted.start()).resolves.toBeUndefined();
    expect(await restarted.pendingCount()).toBe(2);
    await restarted.close();
  });

  it('isolates default journals by the injected instance storage root', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-outbox-instances-'));
    tempDirectories.push(directory);
    const firstRoot = path.join(directory, 'instance-a');
    const secondRoot = path.join(directory, 'instance-b');
    const offline = async () => { throw new Error('offline'); };
    const first = new SessionVisibilityConvergenceOutbox({
      storageRoot: firstRoot,
      retryIntervalMs: 60_000,
      audit: offline,
      deliver: async () => undefined,
    });
    const second = new SessionVisibilityConvergenceOutbox({
      storageRoot: secondRoot,
      retryIntervalMs: 60_000,
      audit: offline,
      deliver: async () => undefined,
    });

    await first.enqueueAudit({ ...auditEvent, auditId: 'instance-a-only' });
    await second.start();
    expect(await first.pendingCount()).toBe(1);
    expect(await second.pendingCount()).toBe(0);
    await first.close();
    await second.close();
  });

  it('coalesces overlapping flush requests while a slow handler is in flight', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-outbox-slow-'));
    tempDirectories.push(directory);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const audit = vi.fn(() => blocked);
    const outbox = new SessionVisibilityConvergenceOutbox({
      filePath: path.join(directory, 'convergence.jsonl'),
      retryIntervalMs: 10,
      audit,
      deliver: async () => undefined,
    });
    await outbox.enqueueAudit(auditEvent);
    const flushes = Array.from({ length: 20 }, () => outbox.flush());

    await eventually(() => expect(audit).toHaveBeenCalledTimes(1));
    expect(new Set(flushes).size).toBe(1);
    release();
    await Promise.all(flushes);
    await outbox.close();
  });

  it('backs off boundedly instead of hot-looping a persistent failure', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-outbox-backoff-'));
    tempDirectories.push(directory);
    const audit = vi.fn(async () => { throw new Error('still offline'); });
    const outbox = new SessionVisibilityConvergenceOutbox({
      filePath: path.join(directory, 'convergence.jsonl'),
      retryIntervalMs: 10,
      maxRetryIntervalMs: 40,
      audit,
      deliver: async () => undefined,
    });
    await outbox.enqueueAudit(auditEvent);
    await new Promise((resolve) => setTimeout(resolve, 85));

    expect(audit.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(audit.mock.calls.length).toBeLessThanOrEqual(4);
    expect(await outbox.pendingCount()).toBe(1);
    await outbox.close();
  });

  it('keeps exactly one replay in flight without timer continuation growth while a handler never settles', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-outbox-hung-'));
    tempDirectories.push(directory);
    let release!: () => void;
    const neverDuringSchedule = new Promise<void>((resolve) => { release = resolve; });
    const audit = vi.fn(() => neverDuringSchedule);
    const outbox = new SessionVisibilityConvergenceOutbox({
      filePath: path.join(directory, 'convergence.jsonl'),
      retryIntervalMs: 10,
      audit,
      deliver: async () => undefined,
    });
    await outbox.enqueueAudit(auditEvent);

    const first = outbox.flush();
    const overlaps = Array.from({ length: 50 }, () => outbox.flush());
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(new Set([first, ...overlaps]).size).toBe(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(outbox.pendingCountSync()).toBe(1);

    release();
    await first;
    await outbox.close();
  });

  it('persists retry ownership across restart instead of resetting into an immediate retry storm', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-outbox-retry-restart-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'convergence.jsonl');
    let now = 10_000;
    const firstAudit = vi.fn(async () => { throw new Error('offline'); });
    const first = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 1_000,
      maxRetryIntervalMs: 1_000,
      now: () => now,
      audit: firstAudit,
      deliver: async () => undefined,
    });
    await first.enqueueAudit(auditEvent);
    await first.flush();
    expect(firstAudit).toHaveBeenCalledTimes(1);
    await first.close();

    const restartedAudit = vi.fn(async () => { throw new Error('offline'); });
    const restarted = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 1_000,
      maxRetryIntervalMs: 1_000,
      now: () => now,
      audit: restartedAudit,
      deliver: async () => undefined,
    });
    await restarted.start();
    expect(restartedAudit).not.toHaveBeenCalled();
    expect(restarted.pendingCountSync()).toBe(1);

    now += 1_000;
    await restarted.flush();
    expect(restartedAudit).toHaveBeenCalledTimes(1);
    await restarted.close();
  });

  it('compacts restart history to every nonterminal obligation without dropping reservations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-outbox-compaction-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'convergence.jsonl');
    const first = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 60_000,
      compactionRecordThreshold: 2,
      audit: async () => undefined,
      deliver: async () => undefined,
      resolveReservedMutation: async () => 'pending',
    });
    for (const auditId of ['retain-a', 'retain-b', 'retain-c']) {
      await first.reserveMutation({
        auditId,
        operation: 'session_set_pinned',
        phase: 'reserved',
        reservationOwnerId: 'dead-owner',
        targetSessionId: 'target',
        workspaceId: 'ws-redacted',
        beforeStateId: 'before-state',
        afterStateId: 'after-state',
        mutationIdentity: `${auditId}-mutation-identity`,
        audit: { ...auditEvent, auditId },
        delivery: null,
      });
    }
    await first.close();

    const reconstructed = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 60_000,
      compactionRecordThreshold: 2,
      audit: async () => undefined,
      deliver: async () => undefined,
      resolveReservedMutation: async () => 'pending',
    });
    await reconstructed.start();
    expect(reconstructed.pendingCountSync()).toBe(3);
    await reconstructed.close();

    const compacted = await readFile(filePath, 'utf8');
    for (const auditId of ['retain-a', 'retain-b', 'retain-c']) {
      expect(compacted).toContain(`\"auditId\":\"${auditId}\"`);
    }
    expect(compacted.trim().split('\n')).toHaveLength(3);
  });
});
