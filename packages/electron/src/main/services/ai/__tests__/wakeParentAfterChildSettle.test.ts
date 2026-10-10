// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { wakeParentAfterChildSettle } from '../wakeParentAfterChildSettle';

const parent = { id: 'parent', workspacePath: '/ws' };

async function run(child: Record<string, unknown>, opts: { errored?: boolean; parentStatus?: string } = {}) {
  const requestQueueDrive = vi.fn();
  const sessions = new Map<string, any>([
    ['child', { id: 'child', createdBySessionId: 'parent', ...child }],
    ['parent', parent],
  ]);
  await wakeParentAfterChildSettle({
    childSessionId: 'child',
    source: 'test',
    settledChildErrored: opts.errored ?? false,
    getSession: async (id) => sessions.get(id) ?? null,
    getSessionStatus: () => opts.parentStatus ?? 'idle',
    requestQueueDrive,
    logInfo: () => {},
  });
  return requestQueueDrive;
}

describe('wakeParentAfterChildSettle', () => {
  it('re-drives an idle parent for an ordinary child', async () => {
    expect(await run({ metadata: {} })).toHaveBeenCalledWith('parent', '/ws');
  });

  it('does not re-drive for opted-out, owner-routed, errored, or busy cases', async () => {
    const routed = { sessionOwner: { extensionId: 'com.example.owner', key: 'ada', routeChildUpdatesToOwner: true } };
    expect(await run({ metadata: { notifyParent: false } })).not.toHaveBeenCalled();
    expect(await run({ metadata: routed })).not.toHaveBeenCalled();
    expect(await run({ metadata: {} }, { errored: true })).not.toHaveBeenCalled();
    expect(await run({ metadata: {} }, { parentStatus: 'running' })).not.toHaveBeenCalled();
    // Owned without the routing opt-in keeps the default parent behavior.
    expect(await run({ metadata: { sessionOwner: { extensionId: 'com.example.owner', key: 'ada' } } })).toHaveBeenCalled();
  });
});
