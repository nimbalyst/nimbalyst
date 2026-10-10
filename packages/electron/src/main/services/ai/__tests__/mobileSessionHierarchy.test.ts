import { describe, expect, it, vi } from 'vitest';
import { applyMobileSessionParent } from '../mobileSessionHierarchy';

describe('mobile hierarchy authority', () => {
  it('serializes concurrent decisions and canonical publications for a session', async () => {
    let parent: string | null = null;
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const authority = {
      get: vi.fn(async () => ({ id: 'child', parentSessionId: parent, createdBySessionId: parent }) as any),
      updateMetadata: vi.fn(async (_id, patch) => { if (patch.parentSessionId === 'first') await paused; parent = patch.parentSessionId; }),
      publish: vi.fn(async (_id: string, _patch: { parentSessionId: string | null }) => {}),
    };
    const first = applyMobileSessionParent(authority, 'child', 'first');
    await vi.waitFor(() => expect(authority.updateMetadata).toHaveBeenCalledTimes(1));
    const second = applyMobileSessionParent(authority, 'child', 'second');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(authority.updateMetadata).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(parent).toBe('second');
    expect(authority.publish.mock.calls.map(([, patch]) => patch.parentSessionId)).toEqual(['first', 'second']);
  });

  it('does not apply a stale queued snapshot after a newer cache row arrives', async () => {
    const authority = { get: vi.fn(async () => ({ id: 'child', parentSessionId: null }) as any), updateMetadata: vi.fn(), publish: vi.fn() };
    const result = await applyMobileSessionParent(authority, 'child', 'stale', () => false);
    expect(result.accepted).toBe(false);
    expect(authority.updateMetadata).not.toHaveBeenCalled();
    expect(authority.publish).not.toHaveBeenCalled();
  });
});
