// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type { TeamSyncConfig } from '@nimbalyst/runtime/sync';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import { asTeamJwt, asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { ElectronCollabDocumentsDataSource } from '../ElectronCollabDocumentsDataSource';

const scope: CollabScope = {
  scopeKey: 'scope-one',
  orgId: 'org-one',
  indexConfig: {
    serverUrl: 'wss://example.test',
    teamProjectId: 'project-one',
    teamMemberId: asTeamMemberId('member-one'),
  },
};

describe('ElectronCollabDocumentsDataSource', () => {
  it('projects provider snapshots/events and routes commands through the provider', async () => {
    let config!: TeamSyncConfig;
    const observeStatus = vi.fn();
    const provider = {
      connect: vi.fn(async () => undefined),
      getStatus: vi.fn(() => 'connected' as const),
      getDocuments: vi.fn(() => [{
        documentId: 'doc-1',
        projectId: 'project-owned',
        title: 'One',
        documentType: 'markdown',
        createdBy: 'member-one',
        createdAt: 1,
        updatedAt: 2,
      }]),
      getFolders: vi.fn(() => [{
        folderId: 'folder-1',
        parentFolderId: null,
        name: 'Folder',
        sortOrder: 1,
        createdBy: 'member-one',
        createdAt: 1,
        updatedAt: 2,
      }]),
      getTeamState: vi.fn(() => ({ members: [] })),
      updateDocumentTitle: vi.fn(async () => undefined),
      refreshFolders: vi.fn(async () => []),
      destroy: vi.fn(),
    };
    const source = new ElectronCollabDocumentsDataSource({
      scope,
      getJwt: async () => asTeamJwt('team-jwt'),
      events: { observeStatus },
      createProvider: (nextConfig) => {
        config = nextConfig;
        return provider as any;
      },
    });
    const changes: string[] = [];
    source.subscribe((change) => changes.push(change.type));

    await expect(source.snapshot()).resolves.toEqual({
      items: [expect.objectContaining({
        documentId: 'doc-1',
        title: 'One',
        teamProjectId: 'project-owned',
      })],
      containers: [expect.objectContaining({ folderId: 'folder-1', name: 'Folder' })],
    });
    config.onDocumentChanged?.({
      documentId: 'doc-2',
      projectId: 'project-two',
      title: 'Two',
      documentType: 'markdown',
      createdBy: 'member-two',
      createdAt: 3,
      updatedAt: 4,
    });
    config.onFoldersRemoved?.(['folder-1'], ['doc-1']);
    config.onStatusChange?.('connected');
    await source.command({ type: 'update-document-title', documentId: 'doc-1', title: 'Renamed' });

    expect(changes).toEqual(['items-upserted', 'containers-removed', 'status']);
    expect(observeStatus).toHaveBeenCalledWith('connected');
    expect(provider.updateDocumentTitle).toHaveBeenCalledWith('doc-1', 'Renamed');
    expect(provider.connect).toHaveBeenCalledTimes(1);
    source.dispose();
    expect(provider.destroy).toHaveBeenCalledTimes(1);
  });

  // The team socket must not be opened with the browser WebSocket: Chromium
  // stamps an Origin header the sync server rejects for non-allowlisted origins
  // (the dev renderer is http://localhost:5273), which surfaces only as an
  // opaque 1006 close and leaves Shared Docs stuck on "Disconnected".
  it('opens the team socket through the main-process proxy when it is available', () => {
    const wsConnect = vi.fn(async () => ({ success: true, wsId: 'ws-1' }));
    const onWsEvent = vi.fn(() => () => {});
    vi.stubGlobal('window', { electronAPI: { documentSync: { wsConnect, onWsEvent } } });
    try {
      let config!: TeamSyncConfig;
      new ElectronCollabDocumentsDataSource({
        scope,
        getJwt: async () => asTeamJwt('team-jwt'),
        createProvider: (nextConfig) => {
          config = nextConfig;
          return { getStatus: () => 'disconnected' } as any;
        },
      });
      // Not just "some function": driving it must reach the main-process IPC
      // rather than constructing a browser WebSocket, whose Origin header the
      // sync server rejects with a 403 the renderer only sees as a 1006.
      config.createWebSocket!('wss://sync.nimbalyst.test/sync/room');
      expect(wsConnect).toHaveBeenCalledWith('wss://sync.nimbalyst.test/sync/room');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to the platform WebSocket when no proxy IPC is exposed', () => {
    let config!: TeamSyncConfig;
    new ElectronCollabDocumentsDataSource({
      scope,
      getJwt: async () => asTeamJwt('team-jwt'),
      createProvider: (nextConfig) => {
        config = nextConfig;
        return { getStatus: () => 'disconnected' } as any;
      },
    });
    expect(config.createWebSocket).toBeUndefined();
  });
});
