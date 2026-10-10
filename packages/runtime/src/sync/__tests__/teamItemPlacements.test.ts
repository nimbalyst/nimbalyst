// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';
import { TeamSyncProvider } from '../TeamSync';
import type { ItemPlacementNode, TeamSyncConfig } from '../teamSyncTypes';

function placement(itemId: string, projectId: string, parentId: string | null = null): ItemPlacementNode {
  return { itemId, projectId, parentId, sortOrder: 0, createdBy: 'user-1', createdAt: 1, updatedAt: 1 };
}

function createProvider(overrides: Partial<TeamSyncConfig> = {}): TeamSyncProvider {
  return new TeamSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => asTeamJwt('token'),
    orgId: 'org-1',
    teamMemberId: asTeamMemberId('user-1'),
    ...overrides,
  });
}

function receive(provider: TeamSyncProvider, message: Record<string, unknown>): Promise<void> {
  return (provider as any).handleMessage({ data: JSON.stringify(message) });
}

const metadata = { orgId: 'org-1', name: 'Org', gitRemoteHash: null, teamProjectId: 'p1', createdBy: 'u', createdAt: 1 };

describe('TeamSyncProvider tracker-item placements', () => {
  it('keeps only its own project, applies broadcasts, refreshes, and reads the page-tree flag', async () => {
    const onItemPlacementsLoaded = vi.fn();
    const onItemPlacementChanged = vi.fn();
    const onItemPlacementsRemoved = vi.fn();
    const provider = createProvider({ onItemPlacementsLoaded, onItemPlacementChanged, onItemPlacementsRemoved });
    const sent: Array<Record<string, unknown>> = [];
    (provider as any).send = (message: Record<string, unknown>) => { sent.push(message); };

    // An older server: no list and no flag means unknown, not empty.
    await receive(provider, { type: 'teamSyncResponse', team: { metadata, members: [], documents: [] } });
    expect(provider.getItemPlacements()).toBeNull();
    expect(provider.isPageTree()).toBe(false);
    expect(onItemPlacementsLoaded).not.toHaveBeenCalled();

    await receive(provider, {
      type: 'teamSyncResponse',
      team: {
        metadata, members: [], documents: [], pageTree: true,
        itemPlacements: [placement('NIM-1', 'p1', 'kb'), placement('NIM-1', 'p2')],
      },
    });
    expect(provider.isPageTree()).toBe(true);
    expect(provider.getItemPlacements()).toEqual([placement('NIM-1', 'p1', 'kb')]);
    expect(onItemPlacementsLoaded).toHaveBeenLastCalledWith([placement('NIM-1', 'p1', 'kb')]);

    await receive(provider, { type: 'itemPlacementBroadcast', placement: placement('NIM-2', 'p2') });
    await receive(provider, { type: 'itemPlacementBroadcast', placement: placement('NIM-1', 'p1') });
    expect(onItemPlacementChanged).toHaveBeenCalledTimes(1);
    expect(provider.getItemPlacements()).toEqual([placement('NIM-1', 'p1')]);

    await receive(provider, { type: 'itemPlacementRemoveBroadcast', projectId: 'p2', itemIds: ['NIM-1'] });
    expect(provider.getItemPlacements()).toHaveLength(1);
    await receive(provider, { type: 'itemPlacementRemoveBroadcast', projectId: 'p1', itemIds: ['NIM-1'] });
    expect(provider.getItemPlacements()).toEqual([]);
    expect(onItemPlacementsRemoved).toHaveBeenCalledWith(['NIM-1']);

    (provider as any).send = (message: Record<string, unknown>) => {
      sent.push(message);
      if (message.type === 'itemPlacementIndexSync') {
        void receive(provider, { type: 'itemPlacementIndexSyncResponse', placements: [placement('NIM-3', 'p1')] });
      }
    };
    await expect(provider.refreshItemPlacements(100)).resolves.toEqual([placement('NIM-3', 'p1')]);
    provider.destroy();
  });

  it('sends set and remove for its project, re-reads after a refusal, and keeps only the last intent offline', async () => {
    const provider = createProvider({ teamProjectId: 'p1' });
    const socketSends: Array<Record<string, unknown>> = [];
    (provider as any).ws = { readyState: WebSocket.OPEN, send: (data: string) => socketSends.push(JSON.parse(data)) };

    provider.setItemPlacement('NIM-1', 'kb', 2);
    expect(socketSends.at(-1)).toEqual({ type: 'itemPlacementSet', itemId: 'NIM-1', parentId: 'kb', sortOrder: 2, projectId: 'p1' });
    provider.setItemPlacement('NIM-2', 'NIM-1', 0, 'item');
    expect(socketSends.at(-1)).toEqual({ type: 'itemPlacementSet', itemId: 'NIM-2', parentId: 'NIM-1', sortOrder: 0, parentKind: 'item', projectId: 'p1' });
    await receive(provider, { type: 'error', code: 'folder_not_found', message: 'Page kb not found' });
    expect(socketSends.at(-1)).toEqual({ type: 'itemPlacementIndexSync' });

    (provider as any).ws = null;
    provider.setItemPlacement('NIM-1', 'a');
    provider.removeItemPlacement('NIM-1');
    expect((provider as any).pendingOfflineMessages).toEqual([{ type: 'itemPlacementRemove', itemId: 'NIM-1', projectId: 'p1' }]);
    provider.destroy();
  });
});
