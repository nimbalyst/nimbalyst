// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';
import { TeamSyncProvider } from '../TeamSync';
import type { TeamSyncConfig, TypePlacementNode } from '../teamSyncTypes';

function placement(typeId: string, projectId: string, parentFolderId: string | null = null): TypePlacementNode {
  return { typeId, projectId, parentFolderId, sortOrder: 0, createdBy: 'user-1', createdAt: 1, updatedAt: 1 };
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

describe('TeamSyncProvider tracker-type placements', () => {
  it('keeps only its own project, applies broadcasts, and refreshes from the server list', async () => {
    const onTypePlacementsLoaded = vi.fn();
    const onTypePlacementChanged = vi.fn();
    const onTypePlacementsRemoved = vi.fn();
    // No configured project: the primary project comes from the teamSync metadata.
    const provider = createProvider({ onTypePlacementsLoaded, onTypePlacementChanged, onTypePlacementsRemoved });
    const sent: Array<Record<string, unknown>> = [];
    (provider as any).send = (message: Record<string, unknown>) => { sent.push(message); };

    await receive(provider, {
      type: 'teamSyncResponse',
      team: {
        metadata: { orgId: 'org-1', name: 'Org', gitRemoteHash: null, teamProjectId: 'p1', createdBy: 'u', createdAt: 1 },
        members: [],
        documents: [],
        typePlacements: [placement('module', 'p1', 'kb'), placement('module', 'p2')],
      },
    });
    expect(provider.getTypePlacements()).toEqual([placement('module', 'p1', 'kb')]);
    expect(onTypePlacementsLoaded).toHaveBeenLastCalledWith([placement('module', 'p1', 'kb')]);

    await receive(provider, { type: 'typePlacementBroadcast', placement: placement('library', 'p2') });
    await receive(provider, { type: 'typePlacementBroadcast', placement: placement('module', 'p1') });
    expect(onTypePlacementChanged).toHaveBeenCalledTimes(1);
    expect(provider.getTypePlacements()).toEqual([placement('module', 'p1')]);

    await receive(provider, { type: 'typePlacementRemoveBroadcast', projectId: 'p2', typeIds: ['module'] });
    expect(provider.getTypePlacements()).toHaveLength(1);
    await receive(provider, { type: 'typePlacementRemoveBroadcast', projectId: 'p1', typeIds: ['module'] });
    expect(provider.getTypePlacements()).toEqual([]);
    expect(onTypePlacementsRemoved).toHaveBeenCalledWith(['module']);

    (provider as any).send = (message: Record<string, unknown>) => {
      sent.push(message);
      if (message.type === 'typePlacementIndexSync') {
        void receive(provider, { type: 'typePlacementIndexSyncResponse', placements: [placement('competitor', 'p1')] });
      }
    };
    await expect(provider.refreshTypePlacements(100)).resolves.toEqual([placement('competitor', 'p1')]);
    provider.destroy();
  });

  it('treats an absent teamSync list as unknown, not as empty', async () => {
    const onTypePlacementsLoaded = vi.fn();
    const provider = createProvider({ teamProjectId: 'p1', onTypePlacementsLoaded });
    (provider as any).send = () => {};
    const teamSync = (typePlacements?: TypePlacementNode[]) => receive(provider, {
      type: 'teamSyncResponse',
      team: { metadata: null, members: [], documents: [], ...(typePlacements ? { typePlacements } : {}) },
    });

    await teamSync();
    expect(provider.getTypePlacements()).toBeNull();
    expect(onTypePlacementsLoaded).not.toHaveBeenCalled();

    await teamSync([placement('module', 'p1')]);
    await teamSync();
    expect(provider.getTypePlacements()).toEqual([placement('module', 'p1')]);
    expect(onTypePlacementsLoaded).toHaveBeenCalledTimes(1);
    provider.destroy();
  });

  it('re-reads the list when the server refuses an unconfirmed placement mutation', async () => {
    const onTypePlacementsLoaded = vi.fn();
    const provider = createProvider({ teamProjectId: 'p1', onTypePlacementsLoaded });
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    (provider as any).ws = socket;
    const sentTypes = () => socket.send.mock.calls.map(([raw]) => JSON.parse(raw).type);
    const refusal = { type: 'error', code: 'folder_not_found', message: 'Folder missing not found' };

    // Confirmed by its broadcast: a later unrelated error must not trigger a re-read.
    provider.setTypePlacement('module', null);
    await receive(provider, { type: 'typePlacementBroadcast', placement: placement('module', 'p1') });
    await receive(provider, refusal);
    expect(sentTypes()).toEqual(['typePlacementSet']);

    provider.setTypePlacement('competitor', 'missing');
    await receive(provider, refusal);
    expect(sentTypes()).toEqual(['typePlacementSet', 'typePlacementSet', 'typePlacementIndexSync']);

    await receive(provider, { type: 'typePlacementIndexSyncResponse', placements: [placement('module', 'p1')] });
    expect(onTypePlacementsLoaded).toHaveBeenLastCalledWith([placement('module', 'p1')]);
    (provider as any).ws = null;
    provider.destroy();
  });

  it('queues only the last placement intent per type while offline', () => {
    const provider = createProvider({ teamProjectId: 'p1' });

    provider.setTypePlacement('module', 'kb', 3);
    provider.setTypePlacement('technology', null);
    provider.removeTypePlacement('module');

    expect((provider as any).pendingOfflineMessages).toEqual([
      { type: 'typePlacementSet', typeId: 'technology', parentFolderId: null, sortOrder: 0, projectId: 'p1' },
      { type: 'typePlacementRemove', typeId: 'module', projectId: 'p1' },
    ]);
    provider.destroy();
  });
});
