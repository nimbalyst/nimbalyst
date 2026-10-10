import { expect, it, vi } from 'vitest';
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: vi.fn() } }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { warn: vi.fn() } } }));
import { createHierarchyPublisher } from '../../sync/sessionHierarchyPublication';

it('retains an unpublished canonical rejection and reads fresh state on named retry', async () => {
  let parentSessionId: string | null = null;
  const push = vi.fn().mockResolvedValueOnce({ published: false, retryable: true }).mockResolvedValue({ published: true });
  const publisher = createHierarchyPublisher({ get: async () => ({ parentSessionId, createdBySessionId: parentSessionId, isArchived: false }) as any, push, warn: vi.fn() });
  try {
    await publisher.publish('child');
    expect(push.mock.calls[0]).toEqual(['child', { parentSessionId: null, createdBySessionId: null, isArchived: false }, expect.any(Function)]);
    expect(publisher.pendingCount()).toBe(1);
    parentSessionId = 'newer-manager';
    await publisher.retry();
    expect(push.mock.calls[1][1]).toMatchObject({ parentSessionId: 'newer-manager', createdBySessionId: 'newer-manager' });
    expect(publisher.pendingCount()).toBe(0);
  } finally { publisher.pause(); }
});

it('does no database work while the transport cannot publish, then drains pending ids one at a time', async () => {
  let ready = false;
  let inFlight = 0;
  let maxInFlight = 0;
  const get = vi.fn(async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 0));
    inFlight--;
    return { parentSessionId: 'manager', createdBySessionId: 'manager', isArchived: false } as any;
  });
  const listPending = vi.fn(async () => Array.from({ length: 50 }, (_, i) => `s${i}`));
  const push = vi.fn().mockResolvedValue({ published: true });
  const publisher = createHierarchyPublisher({ get, push, listPending, canPublish: () => ready, warn: vi.fn() });
  try {
    await publisher.publish('child');
    await publisher.retry();
    expect(get).not.toHaveBeenCalled();
    expect(listPending).not.toHaveBeenCalled();
    expect(publisher.pendingCount()).toBe(1);
    ready = true;
    await publisher.retry();
    expect(get).toHaveBeenCalledTimes(51);
    expect(maxInFlight).toBe(1);
    expect(publisher.pendingCount()).toBe(0);
  } finally { publisher.pause(); }
});

it('drops a durable intent for a session outside index retention instead of retrying it forever', async () => {
  const intent = { revision: 'r1', parentSessionId: 'manager', createdBySessionId: 'manager' };
  const row = { id: 'old', parentSessionId: 'manager', createdBySessionId: 'manager', isArchived: false, updatedAt: 1, metadata: { hierarchySyncIntent: intent } } as any;
  const push = vi.fn().mockResolvedValue({ published: false, reason: 'index publication deferred', retryable: true });
  const dropIntent = vi.fn(async () => {});
  const warn = vi.fn();
  const publisher = createHierarchyPublisher({ get: async () => row, push, listPending: async () => ['old'], isRetained: r => r.updatedAt > 1, dropIntent, warn });
  try {
    await publisher.retry();
    expect(push).not.toHaveBeenCalled();
    expect(dropIntent).toHaveBeenCalledWith(row);
    expect(warn).not.toHaveBeenCalled();
    expect(publisher.pendingCount()).toBe(0);
  } finally { publisher.pause(); }
});
