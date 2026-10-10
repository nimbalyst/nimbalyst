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
  it('confirms a rename only from the stored title, and exposes refusal, lost acknowledgement and old servers', async () => {
    vi.useFakeTimers();
    let config!: TeamSyncConfig;
    const provider = {
      connect: vi.fn(async () => undefined), getStatus: () => 'connected',
      echoesTitleWrites: vi.fn(() => true), updateDocumentTitle: vi.fn(async (_id: string, _title: string, _options: { requestId: string }) => undefined), destroy: vi.fn(),
    };
    const source = new ElectronCollabDocumentsDataSource({
      scope, getJwt: async () => asTeamJwt('team-jwt'), placementConfirmTimeoutMs: 100,
      createProvider: (next) => { config = next; return provider as any; },
    });
    const rename = () => source.command({ type: 'update-document-title', documentId: 'page-1', title: 'Design' });
    const row = { documentId: 'page-1', title: 'design', documentType: 'markdown', createdBy: 'member', createdAt: 1, updatedAt: 2 };
    try {
      let done = false;
      const pending = rename().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      config.onDocumentChanged?.(row);
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      config.onDocumentChanged?.({ ...row, title: 'Design' });
      await pending;
      expect(done).toBe(true);

      const refused = rename().catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(0);
      const requestId = provider.updateDocumentTitle.mock.calls.at(-1)![2].requestId;
      config.onWriteRefused?.(requestId, { code: 'forbidden', message: 'Access removed' });
      expect(await refused).toMatch(/Access removed/);

      const lost = rename().catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(100);
      expect(await lost).toMatch(/did not confirm the rename/);
      provider.echoesTitleWrites.mockReturnValue(false);
      const sent = provider.updateDocumentTitle.mock.calls.length;
      await expect(rename()).rejects.toThrow(/server.*rename/i);
      expect(provider.updateDocumentTitle).toHaveBeenCalledTimes(sent);
    } finally {
      source.dispose();
      vi.useRealTimers();
    }
  });

  it('stores page fields only on a server that says so, confirmed by the echo that holds the patch', async () => {
    vi.useFakeTimers();
    let config!: TeamSyncConfig;
    const provider = {
      connect: vi.fn(async () => undefined), getStatus: () => 'connected', storesPageFields: vi.fn(() => true),
      setDocumentFields: vi.fn((_id: string, _fields: Record<string, unknown>, _options: { requestId: string }) => undefined),
      getDocuments: () => [], getFolders: () => [], getTypePlacements: () => null, getItemPlacements: () => null,
      getTeamState: () => null, isPageTree: () => true, destroy: vi.fn(),
    };
    const source = new ElectronCollabDocumentsDataSource({
      scope, getJwt: async () => asTeamJwt('team-jwt'), placementConfirmTimeoutMs: 100,
      createProvider: (next) => { config = next; return provider as any; },
    });
    const setFields = () => source.command({ type: 'set-document-fields', documentId: 'page-1', fields: { status: 'current', owner: null } });
    const row = { documentId: 'page-1', title: 'Design', documentType: 'markdown', createdBy: 'member', createdAt: 1, updatedAt: 2 };
    try {
      expect((await source.snapshot()).pageFields).toBe(true);
      let done = false;
      const pending = setFields().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.setDocumentFields).toHaveBeenCalledWith('page-1', { status: 'current', owner: null }, { requestId: expect.any(String) });
      // A teammate's echo that does not hold the patch yet is not the confirmation.
      config.onDocumentChanged?.({ ...row, fields: { status: 'draft', owner: 'ana@example.com' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      // Another key set meanwhile does not stop the patch from being recognized.
      config.onDocumentChanged?.({ ...row, fields: { status: 'current', tags: ['sync'] } });
      await pending;

      const refused = setFields().catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(0);
      config.onWriteRefused?.(provider.setDocumentFields.mock.calls.at(-1)![2].requestId, { code: 'forbidden', message: 'Read only' });
      expect(await refused).toMatch(/Read only/);

      provider.storesPageFields.mockReturnValue(false);
      expect((await source.snapshot()).pageFields).toBeUndefined();
      const sent = provider.setDocumentFields.mock.calls.length;
      await expect(setFields()).rejects.toThrow(/page fields/);
      expect(provider.setDocumentFields).toHaveBeenCalledTimes(sent);
    } finally {
      source.dispose();
      vi.useRealTimers();
    }
  });

  it('projects provider snapshots/events and routes commands through the provider', async () => {
    let config!: TeamSyncConfig;
    const observeStatus = vi.fn();
    const onDocumentFeedbackIndex = vi.fn();
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
        parentFolderId: 'item-9',
        parentKind: 'item',
        sortOrder: 1024,
        hasContent: false,
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
      getTypePlacements: vi.fn(() => [{
        typeId: 'module',
        projectId: 'project-one',
        parentFolderId: 'folder-1',
        sortOrder: 1,
        createdBy: 'member-one',
        createdAt: 1,
        updatedAt: 2,
      }]),
      getItemPlacements: vi.fn(() => [{
        itemId: 'item-1',
        projectId: 'project-one',
        parentId: 'doc-1',
        parentKind: 'page',
        sortOrder: 2,
        createdBy: 'member-one',
        createdAt: 1,
        updatedAt: 2,
      }]),
      isPageTree: vi.fn(() => true),
      setItemPlacement: vi.fn(),
      removeItemPlacement: vi.fn(),
      refreshItemPlacements: vi.fn(async () => null),
      registerDocument: vi.fn(async () => true),
      moveDocument: vi.fn(),
      getTeamState: vi.fn(() => ({ members: [], metadata: { teamProjectId: 'project-primary' } })),
      echoesTitleWrites: vi.fn(() => true),
      updateDocumentTitle: vi.fn(async (documentId: string, title: string) => {
        config.onDocumentChanged?.({ documentId, title, documentType: 'markdown', createdBy: 'member-one', createdAt: 1, updatedAt: 5 });
      }),
      refreshFolders: vi.fn(async () => []),
      setTypePlacement: vi.fn(),
      removeTypePlacement: vi.fn(),
      refreshTypePlacements: vi.fn(async () => null),
      destroy: vi.fn(),
    };
    const source = new ElectronCollabDocumentsDataSource({
      scope,
      getJwt: async () => asTeamJwt('team-jwt'),
      events: { observeStatus, onDocumentFeedbackIndex },
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
        parentFolderId: 'item-9',
        parentKind: 'item',
        sortOrder: 1024,
        hasContent: false,
      })],
      containers: [expect.objectContaining({ folderId: 'folder-1', name: 'Folder' })],
      // Rows from an older server carry no parent kind: a page.
      typePlacements: [expect.objectContaining({ typeId: 'module', parentFolderId: 'folder-1', parentKind: 'page' })],
      itemPlacements: [expect.objectContaining({ itemId: 'item-1', parentId: 'doc-1', parentKind: 'page', sortOrder: 2 })],
      pageTree: true,
      // The session splits other projects off; a null-project row is the primary's.
      primaryProjectId: 'project-primary',
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
    // Placement changes reach the session as snapshots carrying typePlacements.
    config.onTypePlacementsRemoved?.(['module']);
    config.onStatusChange?.('connected');
    const inventory = { epoch: 'socket', sequence: 1, generation: 1, status: 'ready' as const, entries: [] };
    config.onDocumentFeedbackIndex?.(inventory);
    expect(onDocumentFeedbackIndex).toHaveBeenCalledWith(inventory);
    await source.command({ type: 'update-document-title', documentId: 'doc-1', title: 'Renamed' });
    await source.command({ type: 'set-type-placement', typeId: 'module', parentFolderId: 'item-9', parentKind: 'item', sortOrder: 4 });
    await source.command({
      type: 'register-document', documentId: 'doc-3', title: 'Three', documentType: 'markdown',
      parentFolderId: 'item-9', parentKind: 'item', sortOrder: 2048,
    });
    await source.command({ type: 'move-document', documentId: 'doc-3', parentFolderId: null, sortOrder: 5 });
    expect(provider.registerDocument).toHaveBeenCalledWith(
      'doc-3', 'Three', 'markdown', 'item-9', undefined, undefined, { parentKind: 'item', sortOrder: 2048 },
    );
    expect(provider.moveDocument).toHaveBeenCalledWith('doc-3', null, { sortOrder: 5 });
    await source.command({ type: 'remove-type-placement', typeId: 'module' });
    await expect(source.command({ type: 'refresh-type-placements' }))
      .resolves.toEqual({ ok: true, typePlacements: null });
    await expect(source.command({ type: 'refresh-item-placements' }))
      .resolves.toEqual({ ok: true, itemPlacements: null });

    expect(changes).toEqual(['items-upserted', 'containers-removed', 'snapshot', 'status', 'items-upserted']);
    expect(provider.setTypePlacement).toHaveBeenCalledWith('module', 'item-9', 4, 'item');
    expect(provider.removeTypePlacement).toHaveBeenCalledWith('module');
    // No server list yet (older server): the snapshot must not claim an empty one.
    provider.getTypePlacements.mockReturnValueOnce(null as never);
    provider.getItemPlacements.mockReturnValueOnce(null as never);
    provider.isPageTree.mockReturnValueOnce(false);
    const olderServer = await source.snapshot();
    expect(olderServer).not.toHaveProperty('typePlacements');
    expect(olderServer).not.toHaveProperty('itemPlacements');
    expect(olderServer).not.toHaveProperty('pageTree');
    expect(observeStatus).toHaveBeenCalledWith('connected');
    expect(provider.updateDocumentTitle).toHaveBeenCalledWith('doc-1', 'Renamed', { requestId: expect.any(String) });
    expect(provider.connect).toHaveBeenCalledTimes(1);
    source.dispose();
    expect(provider.destroy).toHaveBeenCalledTimes(1);
  });

  it('settles an item placement write on the server\'s broadcast, a refusal, or a timeout', async () => {
    vi.useFakeTimers();
    try {
      let config!: TeamSyncConfig;
      const placement = (itemId: string, parentId: string | null) => ({
        itemId, projectId: 'project-one', parentId, sortOrder: 0, createdBy: 'm', createdAt: 1, updatedAt: 1,
      });
      const provider = {
        connect: vi.fn(async () => undefined),
        getStatus: vi.fn(() => 'connected' as const),
        getDocuments: vi.fn(() => []),
        getFolders: vi.fn(() => []),
        getTypePlacements: vi.fn(() => null),
        getItemPlacements: vi.fn(() => null),
        isPageTree: vi.fn(() => true),
        getTeamState: vi.fn(() => null),
        setItemPlacement: vi.fn(),
        removeItemPlacement: vi.fn(),
        destroy: vi.fn(),
      };
      const source = new ElectronCollabDocumentsDataSource({
        scope,
        getJwt: async () => asTeamJwt('team-jwt'),
        createProvider: (nextConfig) => {
          config = nextConfig;
          return provider as any;
        },
      });
      const settled = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: Error) => error.message);

      // Confirmed by the broadcast for this item, not by an unrelated one.
      const set = settled(source.command({ type: 'set-item-placement', itemId: 'i1', parentId: 'page-1', sortOrder: 0 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.setItemPlacement).toHaveBeenCalledWith('i1', 'page-1', 0, undefined);
      config.onItemPlacementChanged?.(placement('other', 'page-1') as never);
      config.onItemPlacementChanged?.(placement('i1', 'page-1') as never);
      expect(await set).toBe('ok');

      const remove = settled(source.command({ type: 'remove-item-placement', itemId: 'i1' }));
      await vi.advanceTimersByTimeAsync(0);
      config.onItemPlacementsRemoved?.(['i1']);
      expect(await remove).toBe('ok');

      // A refusal: TeamSync re-reads the list after a server error, and the
      // list does not hold the change.
      const refused = settled(source.command({ type: 'set-item-placement', itemId: 'i2', parentId: 'page-2', sortOrder: 0 }));
      await vi.advanceTimersByTimeAsync(0);
      config.onItemPlacementsLoaded?.([placement('i2', null)] as never);
      expect(await refused).toMatch(/refused/);

      // No answer within 6 seconds.
      const silent = settled(source.command({ type: 'remove-item-placement', itemId: 'i3' }));
      await vi.advanceTimersByTimeAsync(6000);
      expect(await silent).toMatch(/did not confirm/);
      source.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a confirmed page move or type placement on the server\'s echo, a refusal, or a timeout', async () => {
    vi.useFakeTimers();
    try {
      let config!: TeamSyncConfig;
      const provider = {
        connect: vi.fn(async () => undefined),
        getStatus: vi.fn(() => 'connected' as const),
        getDocuments: vi.fn(() => []),
        getFolders: vi.fn(() => []),
        getTypePlacements: vi.fn(() => null),
        getItemPlacements: vi.fn(() => null),
        isPageTree: vi.fn(() => true),
        getTeamState: vi.fn(() => null),
        // A server that sends the author its own page writes says so.
        echoesAuthorWrites: vi.fn(() => true),
        moveDocument: vi.fn(),
        removeDocument: vi.fn(),
        removeFolder: vi.fn(),
        setTypePlacement: vi.fn(),
        destroy: vi.fn(),
      };
      const source = new ElectronCollabDocumentsDataSource({
        scope,
        getJwt: async () => asTeamJwt('team-jwt'),
        createProvider: (nextConfig) => {
          config = nextConfig;
          return provider as any;
        },
      });
      const settled = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: Error) => error.message);
      const refuse = (requestId: string, message: string) =>
        (config as { onWriteRefused?: (id: string, error: { code: string; message: string }) => void })
          .onWriteRefused?.(requestId, { code: 'forbidden', message });
      const lastRequestId = (method: ReturnType<typeof vi.fn>) => {
        const args = method.mock.calls.at(-1)!;
        return (args[args.length - 1] as { requestId: string }).requestId;
      };

      // A delete waits for the author's own removal broadcast, or its refusal by request id.
      const removed = settled(source.command({ type: 'remove-document', documentId: 'page-1' }));
      await vi.advanceTimersByTimeAsync(0);
      config.onDocumentRemoved?.('page-1');
      expect(await removed).toBe('ok');
      // A server that moves a live page to Trash instead answers with the trashed row.
      const trashedInstead = settled(source.command({ type: 'remove-document', documentId: 'page-5' }));
      await vi.advanceTimersByTimeAsync(0);
      config.onDocumentChanged?.({
        documentId: 'page-5', projectId: 'p', title: 't', documentType: 'markdown', createdBy: 'm', createdAt: 1, updatedAt: 2, trashedAt: 2,
      } as never);
      expect(await trashedInstead).toBe('ok');
      const subtree = settled(source.command({ type: 'remove-folder', folderId: 'page-2' }));
      await vi.advanceTimersByTimeAsync(0);
      config.onFoldersRemoved?.(['page-2'], ['page-2', 'page-3']);
      expect(await subtree).toBe('ok');
      const forbidden = settled(source.command({ type: 'remove-document', documentId: 'page-4' }));
      await vi.advanceTimersByTimeAsync(0);
      refuse('another-request', 'Not yours');
      refuse(lastRequestId(provider.removeDocument), 'Viewers cannot delete pages');
      expect(await forbidden).toMatch(/refused.*Viewers cannot delete pages/);
      const movedAway = settled(source.command({ type: 'move-document', documentId: 'page-1', parentFolderId: 'mod_3', confirm: true }));
      await vi.advanceTimersByTimeAsync(0);
      refuse(lastRequestId(provider.moveDocument), 'Parent not found');
      expect(await movedAway).toMatch(/refused.*Parent not found/);

      const doc = (parentFolderId: string | null, parentKind: 'page' | 'item') => ({
        documentId: 'page-1', projectId: 'p', title: 't', documentType: 'markdown', createdBy: 'm', createdAt: 1, updatedAt: 1,
        parentFolderId, parentKind, sortOrder: null,
      });
      const typeRow = (parentFolderId: string | null, parentKind?: 'item') => ({
        typeId: 'decision', projectId: 'p', parentFolderId, sortOrder: 0, createdBy: 'm', createdAt: 1, updatedAt: 1,
        ...(parentKind ? { parentKind } : {}),
      });

      // Confirmed by the echo of this page under the typed page, not by an older server's echo without the kind.
      const moved = settled(source.command({ type: 'move-document', documentId: 'page-1', parentFolderId: 'mod_1', parentKind: 'item', confirm: true }));
      await vi.advanceTimersByTimeAsync(0);
      config.onDocumentChanged?.(doc('mod_1', 'page') as never);
      config.onDocumentChanged?.(doc('mod_1', 'item') as never);
      expect(await moved).toBe('ok');

      // No echo (an older server refused the parent): a failure, never a success.
      const silent = settled(source.command({ type: 'move-document', documentId: 'page-1', parentFolderId: 'mod_2', parentKind: 'item', confirm: true }));
      await vi.advanceTimersByTimeAsync(6000);
      expect(await silent).toMatch(/did not confirm/);

      const placed = settled(source.command({ type: 'set-type-placement', typeId: 'decision', parentFolderId: 'mod_1', parentKind: 'item', sortOrder: 0, confirm: true }));
      await vi.advanceTimersByTimeAsync(0);
      config.onTypePlacementChanged?.(typeRow('mod_1', 'item') as never);
      expect(await placed).toBe('ok');

      // A refusal: TeamSync re-reads the list after a server error.
      const refused = settled(source.command({ type: 'set-type-placement', typeId: 'decision', parentFolderId: 'mod_2', parentKind: 'item', sortOrder: 0, confirm: true }));
      await vi.advanceTimersByTimeAsync(0);
      config.onTypePlacementsLoaded?.([typeRow('mod_1', 'item')] as never);
      expect(await refused).toMatch(/refused/);
      source.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait for an echo from a server that never sends the author its page writes', async () => {
    vi.useFakeTimers();
    try {
      const provider = {
        connect: vi.fn(async () => undefined),
        getStatus: vi.fn(() => 'connected' as const),
        getDocuments: vi.fn(() => []),
        getFolders: vi.fn(() => []),
        getTypePlacements: vi.fn(() => null),
        getItemPlacements: vi.fn(() => null),
        isPageTree: vi.fn(() => true),
        getTeamState: vi.fn(() => null),
        moveDocument: vi.fn(),
        removeDocument: vi.fn(),
        removeFolder: vi.fn(),
        destroy: vi.fn(),
      };
      const source = new ElectronCollabDocumentsDataSource({
        scope,
        getJwt: async () => asTeamJwt('team-jwt'),
        createProvider: () => provider as any,
      });
      const outcome = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: Error) => error.message);
      const moved = outcome(source.command({ type: 'move-document', documentId: 'page-1', parentFolderId: 'mod_1', parentKind: 'item', confirm: true }));
      const removed = outcome(source.command({ type: 'remove-document', documentId: 'page-2' }));
      const purged = outcome(source.command({ type: 'remove-document', documentId: 'page-3', purge: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(await moved).toBe('ok');
      expect(await removed).toBe('ok');
      expect(await purged).toBe('ok');
      // Only Trash's permanent delete carries purge onto the wire.
      expect(provider.removeDocument.mock.calls).toEqual([['page-2'], ['page-3', { purge: true }]]);
      expect(provider.moveDocument).toHaveBeenCalledWith('page-1', 'mod_1', { parentKind: 'item' });
      source.dispose();
    } finally {
      vi.useRealTimers();
    }
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
