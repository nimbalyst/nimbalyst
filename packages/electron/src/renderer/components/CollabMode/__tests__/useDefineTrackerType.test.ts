// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { defineTrackerTypeOverIpc } from '../useDefineTrackerType';

function fakeRegistry() {
  const types = new Set<string>();
  const listeners = new Set<() => void>();
  return {
    get: (type: string) => (types.has(type) ? { type } : undefined),
    onChange: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    add: (type: string) => { types.add(type); listeners.forEach((fn) => fn()); },
  };
}

describe('defineTrackerTypeOverIpc', () => {
  it('resolves once this window registry has the type, so Set type can offer it', async () => {
    const registry = fakeRegistry();
    const defineType = vi.fn(async () => ({ success: true, type: 'customer' }));
    let settled = false;
    const done = defineTrackerTypeOverIpc({ defineType }, registry, '/ws', { type: 'customer' }).then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(defineType).toHaveBeenCalledWith({ workspacePath: '/ws', schema: { type: 'customer' } });
    expect(settled).toBe(false);
    registry.add('customer');
    await done;
    expect(settled).toBe(true);
  });

  it("passes on that the team has not confirmed the type yet", async () => {
    const registry = fakeRegistry();
    registry.add('customer');
    const defineType = vi.fn(async () => ({ success: true, type: 'customer', status: 'syncing' as const }));
    await expect(defineTrackerTypeOverIpc({ defineType }, registry, '/ws', { type: 'customer' }))
      .resolves.toEqual({ status: 'syncing' });
  });

  it('rejects with the main process refusal', async () => {
    const defineType = vi.fn(async () => ({ success: false, error: 'A type named "customer" already exists.' }));
    await expect(defineTrackerTypeOverIpc({ defineType }, fakeRegistry(), '/ws', { type: 'customer' }))
      .rejects.toThrow('A type named "customer" already exists.');
  });
});
