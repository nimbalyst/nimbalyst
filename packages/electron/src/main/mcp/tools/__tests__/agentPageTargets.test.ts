// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  shared: false,
}));

vi.mock('../../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../trackerToolItemAccess', () => ({ resolveTrackerRowByReference: async () => db.row }));
vi.mock('../trackerToolHandlers', () => ({ rowToTrackerItem: (row: Record<string, unknown>) => row }));
vi.mock('../../../services/TrackerPolicyService', () => ({
  getEffectiveTrackerSharingPolicy: () => 'team',
  shouldSyncTrackerItem: () => db.shared,
}));

import { resolveAgentPageTarget, typedPageItemId } from '../agentPageTargets';

/**
 * A team-shared item's body lives in its room; the local copy is replaced by
 * the room's and is not refreshed by sync, so a Personal URI for it reaches the
 * room instead of being refused with an address the tools could not open (#1879).
 */
describe('resolveAgentPageTarget', () => {
  beforeEach(() => {
    db.row = { id: 'item-7', type: 'plan', title: 'Launch plan', workspace: '/ws' };
    db.shared = false;
  });

  it('sends a Personal URI for a team-shared item to its team body room', async () => {
    db.shared = true;
    await expect(resolveAgentPageTarget('personal://tracker-content/item-7', '/ws'))
      .resolves.toEqual({ uri: 'collab://tracker-content/item-7' });
  });

  it('keeps a Personal URI for an item that is not shared', async () => {
    await expect(resolveAgentPageTarget('personal://tracker-content/item-7', '/ws'))
      .resolves.toEqual({ uri: 'personal://tracker-content/item-7' });
  });

  it('refuses an unknown typed page', async () => {
    db.row = null;
    await expect(resolveAgentPageTarget('personal://tracker-content/missing', '/ws'))
      .resolves.toEqual({ error: "Error: Unknown typed page 'missing'." });
  });

  it('names the item behind both forms of a team body URI', () => {
    expect(typedPageItemId('collab://tracker-content/item-7')).toBe('item-7');
    expect(typedPageItemId('collab://org:org-1:doc:tracker-content/item-7')).toBe('item-7');
  });
});
