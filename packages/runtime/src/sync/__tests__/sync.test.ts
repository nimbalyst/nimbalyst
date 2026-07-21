import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSyncedSessionStore } from '../SyncedSessionStore';
import { AISessionsRepository } from '../../storage/repositories/AISessionsRepository';
import type { SessionStore } from '../../ai/adapters/sessionStore';
import type { SyncProvider, SessionChange
 } from '../types';

describe('SyncedSessionStore', () => {
  let mockBaseStore: SessionStore;
  let mockSyncProvider: SyncProvider;
  let capturedChanges: { sessionId: string; change: SessionChange }[];
  let persistedSessions: Map<string, any>;

  beforeEach(() => {
    capturedChanges = [];
    persistedSessions = new Map();

    mockBaseStore = {
      ensureReady: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(async (payload: any) => {
        const existing = persistedSessions.get(payload.id);
        if (existing) {
          const incomingMetadata = { ...(payload.metadata ?? {}) };
          delete incomingMetadata.__nimbalystVisibilityMutationIds;
          persistedSessions.set(payload.id, {
            ...existing,
            ...payload,
            workspacePath: existing.workspacePath,
            title: existing.title,
            parentSessionId: existing.parentSessionId,
            isPinned: existing.isPinned,
            hasBeenNamed: existing.hasBeenNamed,
            metadata: {
              ...incomingMetadata,
              ...(existing.metadata?.__nimbalystVisibilityMutationIds && {
                __nimbalystVisibilityMutationIds:
                  existing.metadata.__nimbalystVisibilityMutationIds,
              }),
            },
          });
        } else {
          persistedSessions.set(payload.id, {
            ...payload,
            workspacePath: payload.workspaceId,
            messages: [],
            createdAt: payload.createdAt ?? 1,
            updatedAt: payload.updatedAt ?? 1,
          });
        }
      }),
      updateMetadata: vi.fn().mockResolvedValue(undefined),
      applyVisibilityMutation: vi.fn().mockResolvedValue(true),
      hasVisibilityMutation: vi.fn().mockResolvedValue(true),
      get: vi.fn(async (sessionId: string) => persistedSessions.get(sessionId) ?? null),
      list: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      updateTitleIfNotNamed: vi.fn().mockResolvedValue(true),
    };

    mockSyncProvider = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      disconnectAll: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue({ connected: true, syncing: false, lastSyncedAt: Date.now(), error: null }),
      onStatusChange: vi.fn().mockReturnValue(() => {}),
      onRemoteChange: vi.fn().mockReturnValue(() => {}),
      pushChange: vi.fn((sessionId: string, change: SessionChange) => {
        capturedChanges.push({ sessionId, change });
      }),
    };
  });

  it('delegates the atomic visibility identity while syncing only the public field', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
    const mutation = {
      mutationId: 'host-secret-operation-id',
      workspacePath: 'C:\\repo',
      workspaceComparisonPath: 'c:/repo',
      operation: 'session_set_pinned' as const,
      expected: { isPinned: false },
      after: { isPinned: true },
    };

    await expect(syncedStore.applyVisibilityMutation?.('target', mutation)).resolves.toBe(true);
    expect(mockBaseStore.applyVisibilityMutation).toHaveBeenCalledWith('target', mutation);
    expect(capturedChanges).toEqual([{
      sessionId: 'target',
      change: { type: 'metadata_updated', metadata: { isPinned: true } },
    }]);
    expect(JSON.stringify(capturedChanges)).not.toContain('host-secret-operation-id');
    await expect(syncedStore.hasVisibilityMutation?.(
      'target', mutation.mutationId, 'exact-fingerprint',
    )).resolves.toBe(true);
    expect(mockBaseStore.hasVisibilityMutation).toHaveBeenCalledWith(
      'target', mutation.mutationId, 'exact-fingerprint',
    );
  });

  it('should pass title and provider when creating a session', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.create({
      id: 'test-session-123',
      title: 'My Test Session',
      provider: 'claude-code',
      model: 'claude-3-opus',
      mode: 'agent',
      workspaceId: 'workspace-1',
    });

    // Verify base store was called
    expect(mockBaseStore.create).toHaveBeenCalledWith({
      id: 'test-session-123',
      title: 'My Test Session',
      provider: 'claude-code',
      model: 'claude-3-opus',
      mode: 'agent',
      workspaceId: 'workspace-1',
    });

    // Verify sync provider received the metadata
    expect(capturedChanges).toHaveLength(1);
    expect(capturedChanges[0].sessionId).toBe('test-session-123');
    expect(capturedChanges[0].change.type).toBe('metadata_updated');

    if (capturedChanges[0].change.type === 'metadata_updated') {
      const metadata = capturedChanges[0].change.metadata;
      expect(metadata.title).toBe('My Test Session');
      expect(metadata.provider).toBe('claude-code');
      expect(metadata.model).toBe('claude-3-opus');
      expect(metadata.mode).toBe('agent');
    }
  });

  it('create() returns after local persistence even when sync connect is slow', async () => {
    // Regression coverage for GitHub #705: creating a new empty session should
    // only wait for local persistence, not for the session-room WebSocket.
    let resolveConnect!: () => void;
    const connectPromise = new Promise<void>(resolve => {
      resolveConnect = resolve;
    });
    mockSyncProvider.connect = vi.fn().mockReturnValue(connectPromise);

    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    let createResolved = false;
    const createPromise = syncedStore.create({
      id: 'slow-sync-session',
      title: 'Slow Sync Session',
      provider: 'claude-code',
      workspaceId: 'workspace-1',
    } as any).then(() => {
      createResolved = true;
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockBaseStore.create).toHaveBeenCalledWith(expect.objectContaining({
      id: 'slow-sync-session',
    }));
    expect(mockSyncProvider.connect).toHaveBeenCalledWith('slow-sync-session');
    expect(createResolved).toBe(true);
    expect(capturedChanges).toHaveLength(1);
    expect(capturedChanges[0].sessionId).toBe('slow-sync-session');

    resolveConnect();
    await connectPromise;
    await Promise.resolve();

    expect(capturedChanges).toHaveLength(1);

    await createPromise;
  });

  it('should pass title when updating metadata', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    // Pre-connect the session
    await mockSyncProvider.connect('test-session-456');

    await syncedStore.updateMetadata('test-session-456', {
      title: 'Updated Title',
      mode: 'planning',
    });

    // Find the metadata_updated change (skip the connect)
    const metadataChange = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(metadataChange).toBeDefined();

    if (metadataChange?.change.type === 'metadata_updated') {
      expect(metadataChange.change.metadata.title).toBe('Updated Title');
      expect(metadataChange.change.metadata.mode).toBe('planning');
    }
  });

  it('pushes isPinned through updateMetadata without bumping updatedAt', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-pin', { isPinned: true } as any);

    const change = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      expect((change.change.metadata as any).isPinned).toBe(true);
      // isPinned is not sort-relevant; updatedAt must NOT be bumped or the
      // session jumps to the top of the iOS list on every pin/unpin.
      expect(change.change.metadata.updatedAt).toBeUndefined();
    }
  });

  it('pushes parentSessionId reparent (value -> value) through updateMetadata', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-reparent', { parentSessionId: 'new-parent' });

    const change = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      expect((change.change.metadata as any).parentSessionId).toBe('new-parent');
    }
  });

  it('pushes phase and tags from the metadata blob through updateMetadata', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-mcp', {
      metadata: { phase: 'implementing', tags: ['foo', 'bar'] },
    });

    const change = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      expect((change.change.metadata as any).phase).toBe('implementing');
      expect((change.change.metadata as any).tags).toEqual(['foo', 'bar']);
    }
  });

  it('pushes top-level hasBeenNamed through updateMetadata', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-named', {
      hasBeenNamed: true,
    } as any);

    const change = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      expect((change.change.metadata as any).hasBeenNamed).toBe(true);
    }
  });

  it('does NOT push when only local-only fields change', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-local-only', {
      lastDocumentState: { filePath: '/foo.md', contentHash: 'abc' },
    });

    // No metadata_updated should have been pushed.
    const metadataChanges = capturedChanges.filter(c => c.change.type === 'metadata_updated');
    expect(metadataChanges).toHaveLength(0);
    // But the local DB write must still have happened.
    expect(mockBaseStore.updateMetadata).toHaveBeenCalled();
  });

  it('pushes only sync-relevant fields when mixed with local-only fields', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-mixed', {
      isPinned: true,
      lastDocumentState: { filePath: '/foo.md', contentHash: 'abc' },
    } as any);

    const change = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      const m = change.change.metadata as any;
      expect(m.isPinned).toBe(true);
      // lastDocumentState must NOT leak onto the wire.
      expect(m.lastDocumentState).toBeUndefined();
    }
  });

  it('bumps updatedAt for sort-relevant changes (title) but not for pins', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.updateMetadata('s-title', { title: 'Renamed' });
    await syncedStore.updateMetadata('s-pin-only', { isPinned: false } as any);

    const titleChange = capturedChanges.find(c => c.sessionId === 's-title');
    const pinChange = capturedChanges.find(c => c.sessionId === 's-pin-only');
    expect(titleChange?.change.type).toBe('metadata_updated');
    expect(pinChange?.change.type).toBe('metadata_updated');
    if (titleChange?.change.type === 'metadata_updated') {
      expect(typeof titleChange.change.metadata.updatedAt).toBe('number');
    }
    if (pinChange?.change.type === 'metadata_updated') {
      expect(pinChange.change.metadata.updatedAt).toBeUndefined();
    }
  });

  it('create() pushes structural fields and naming metadata from the create payload', async () => {
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider, {
      autoConnect: true,
    });

    await syncedStore.create({
      id: 's-workstream',
      title: 'Workstream Root',
      provider: 'claude-code',
      workspaceId: 'workspace-1',
      sessionType: 'workstream',
      parentSessionId: 'p-1',
      worktreeId: 'wt-1',
      hasBeenNamed: true,
    } as any);

    const change = capturedChanges.find(c => c.change.type === 'metadata_updated');
    expect(change?.change.type).toBe('metadata_updated');
    if (change?.change.type === 'metadata_updated') {
      const m = change.change.metadata as any;
      expect(m.sessionType).toBe('workstream');
      expect(m.parentSessionId).toBe('p-1');
      expect(m.worktreeId).toBe('wt-1');
      expect(m.hasBeenNamed).toBe(true);
      // create() always carries a fresh updatedAt so iOS sorts the new session.
      expect(typeof m.updatedAt).toBe('number');
    }
  });

  it('publishes the authoritative existing-ID upsert row and never its secret ledger', async () => {
    persistedSessions.set('existing', {
      id: 'existing',
      provider: 'claude-code',
      model: 'authoritative-model',
      mode: 'agent',
      title: 'Authoritative title',
      workspacePath: 'C:\\Repo',
      sessionType: 'session',
      parentSessionId: 'authoritative-parent',
      isPinned: true,
      hasBeenNamed: true,
      messages: [],
      createdAt: 1,
      updatedAt: 2,
      metadata: {
        phase: 'validating',
        __nimbalystVisibilityMutationIds: { 'host-operation': 'secret-fingerprint' },
      },
    });
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);

    await syncedStore.create({
      id: 'existing',
      provider: 'claude-code',
      model: 'stale-model',
      title: 'Stale imported title',
      workspaceId: 'c:/repo/',
      parentSessionId: 'stale-parent',
      metadata: {
        phase: 'stale',
        __nimbalystVisibilityMutationIds: { forged: 'caller-controlled' },
      },
    } as any);

    expect(mockBaseStore.get).toHaveBeenCalledWith('existing');
    expect(persistedSessions.get('existing')).toMatchObject({
      title: 'Authoritative title',
      isPinned: true,
      parentSessionId: 'authoritative-parent',
    });
    expect(capturedChanges).toHaveLength(1);
    expect(capturedChanges[0]).toMatchObject({
      sessionId: 'existing',
      change: {
        type: 'metadata_updated',
        metadata: {
          title: 'Authoritative title',
          model: 'stale-model',
          isPinned: true,
          hasBeenNamed: true,
          parentSessionId: 'authoritative-parent',
          phase: 'stale',
          workspaceId: 'C:\\Repo',
        },
      },
    });
    const peerPayload = JSON.stringify(capturedChanges);
    expect(peerPayload).not.toContain('Stale imported title');
    expect(peerPayload).not.toContain('__nimbalystVisibilityMutationIds');
    expect(peerPayload).not.toContain('secret-fingerprint');
    expect(peerPayload).not.toContain('caller-controlled');
  });

  it('holds the per-session writer boundary through delayed authoritative publication', async () => {
    persistedSessions.set('ordered', {
      id: 'ordered', provider: 'claude-code', title: 'S1', workspacePath: '/repo',
      sessionType: 'session', parentSessionId: 'p1', isPinned: false,
      hasBeenNamed: true, messages: [], createdAt: 1, updatedAt: 2, metadata: {},
    });
    let releaseS1!: () => void;
    const s1Gate = new Promise<void>((resolve) => { releaseS1 = resolve; });
    let reachedS1!: () => void;
    const atS1Publication = new Promise<void>((resolve) => { reachedS1 = resolve; });
    const peer = new Map<string, Record<string, unknown>>();
    let publicationCount = 0;
    mockSyncProvider.pushMetadataChangeWithResult = vi.fn(async (
      sessionId: string,
      metadata: Record<string, unknown>,
    ) => {
      publicationCount += 1;
      if (publicationCount === 1) {
        reachedS1();
        await s1Gate;
      }
      peer.set(sessionId, { ...peer.get(sessionId), ...metadata });
      const change = { type: 'metadata_updated', metadata } as SessionChange;
      capturedChanges.push({ sessionId, change });
      return {
        outcome: 'index_frame_written', attempted: true,
        indexFrameWritten: true, skippedReason: null,
      } as const;
    }) as any;
    mockBaseStore.applyVisibilityMutation = vi.fn(async (_sessionId, mutation) => {
      const current = persistedSessions.get('ordered');
      persistedSessions.set('ordered', { ...current, isPinned: mutation.after.isPinned });
      return true;
    });
    const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);

    const create = syncedStore.create({
      id: 'ordered', provider: 'claude-code', title: 'stale import', workspaceId: '/repo',
    });
    await atS1Publication;
    const laterPin = syncedStore.applyVisibilityMutation?.('ordered', {
      mutationId: 'pin-s2', workspacePath: '/repo', workspaceComparisonPath: '/repo',
      operation: 'session_set_pinned', expected: { isPinned: false }, after: { isPinned: true },
    });
    await Promise.resolve();
    expect(mockBaseStore.applyVisibilityMutation).not.toHaveBeenCalled();

    releaseS1();
    await create;
    await laterPin;
    expect(capturedChanges.map(({ change }) => (
      change.type === 'metadata_updated' ? change.metadata.isPinned : undefined
    ))).toEqual([false, true]);
    expect(peer.get('ordered')).toEqual(expect.objectContaining({
      title: 'S1', parentSessionId: 'p1', isPinned: true,
    }));
  });

  it('returns durable create success after a read exception and retries the latest row', async () => {
    vi.useFakeTimers();
    try {
      let releaseRead!: () => void;
      const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
      let reachedRead!: () => void;
      const atRead = new Promise<void>((resolve) => { reachedRead = resolve; });
      let firstRead = true;
      mockBaseStore.get = vi.fn(async (sessionId: string) => {
        if (firstRead) {
          firstRead = false;
          reachedRead();
          await readGate;
          throw new Error('transient authoritative read failure');
        }
        return persistedSessions.get(sessionId) ?? null;
      });
      const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
      const create = syncedStore.create({
        id: 'read-retry', provider: 'claude-code', title: 'Committed', workspaceId: '/repo',
      });
      await atRead;
      releaseRead();
      await expect(create).resolves.toBeUndefined();
      expect(persistedSessions.get('read-retry')?.title).toBe('Committed');
      expect(capturedChanges).toHaveLength(0);

      await vi.runOnlyPendingTimersAsync();
      expect(capturedChanges).toHaveLength(1);
      expect(capturedChanges[0]).toMatchObject({
        sessionId: 'read-retry',
        change: { type: 'metadata_updated', metadata: { title: 'Committed', workspaceId: '/repo' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains an async initial-publication rejection and retries without another mutation', async () => {
    vi.useFakeTimers();
    try {
      mockSyncProvider.pushMetadataChangeWithResult = vi.fn()
        .mockRejectedValueOnce(new Error('delayed encryption failure'))
        .mockImplementation((sessionId: string, metadata: Record<string, unknown>) => {
          const change = { type: 'metadata_updated', metadata } as SessionChange;
          capturedChanges.push({ sessionId, change });
          return {
            outcome: 'index_frame_written', attempted: true,
            indexFrameWritten: true, skippedReason: null,
          };
        });
      const syncedStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
      await expect(syncedStore.create({
        id: 'push-retry', provider: 'claude-code', title: 'Committed', workspaceId: '/repo',
      })).resolves.toBeUndefined();
      expect(capturedChanges).toHaveLength(0);

      await vi.runOnlyPendingTimersAsync();
      expect(capturedChanges).toHaveLength(1);
      expect(capturedChanges[0].sessionId).toBe('push-retry');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps queued create publication durable across reconstruction until an index frame is written', async () => {
    vi.useFakeTimers();
    try {
      const durable = new Map<string, any>();
      mockBaseStore.createWithSyncPublicationObligation = vi.fn(async (payload, obligation) => {
        await mockBaseStore.create(payload);
        durable.set(payload.id, obligation);
      });
      mockBaseStore.listSyncPublicationObligations = vi.fn(async (limit) => (
        [...durable.values()].slice(0, limit)
      ));
      mockBaseStore.clearSyncPublicationObligation = vi.fn(async (sessionId, obligationId) => {
        if (durable.get(sessionId)?.obligationId !== obligationId) return false;
        durable.delete(sessionId);
        return true;
      });
      mockSyncProvider.pushMetadataChangeWithResult = vi.fn(async () => ({
        outcome: 'queued', attempted: false, indexFrameWritten: false,
        skippedReason: 'queued_until_session_indexed',
      })) as any;

      const beforeCrash = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
      await beforeCrash.create({
        id: 'restart-publication', provider: 'claude-code', title: 'Committed', workspaceId: '/repo',
      });
      expect(durable.has('restart-publication')).toBe(true);
      expect(mockBaseStore.clearSyncPublicationObligation).not.toHaveBeenCalled();

      // Process loss drops only timers/maps. The host-only row fact survives.
      vi.clearAllTimers();
      mockSyncProvider.pushMetadataChangeWithResult = vi.fn(async () => ({
        outcome: 'index_frame_written', attempted: true, indexFrameWritten: true,
        skippedReason: null,
      })) as any;
      const afterRestart = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
      await afterRestart.ensureReady();
      await vi.runOnlyPendingTimersAsync();

      expect(mockBaseStore.listSyncPublicationObligations).toHaveBeenCalledWith(100);
      expect(durable.has('restart-publication')).toBe(false);
      expect(mockBaseStore.clearSyncPublicationObligation).toHaveBeenCalledWith(
        'restart-publication', expect.stringMatching(/^syncpub-/),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a durable rotating scan so 100 stuck facts cannot starve fact 101', async () => {
    vi.useFakeTimers();
    try {
      const obligations = Array.from({ length: 101 }, (_, index) => ({
        obligationId: `obligation-${index}`,
        sessionId: `session-${index}`,
        workspaceId: '/repo',
        createdAt: 1,
      }));
      for (const obligation of obligations) {
        persistedSessions.set(obligation.sessionId, {
          id: obligation.sessionId,
          provider: 'claude-code',
          title: obligation.sessionId,
          workspacePath: obligation.workspaceId,
          messages: [],
          createdAt: 1,
          updatedAt: 2,
        });
      }
      const durable = new Map(obligations.map((obligation) => [obligation.sessionId, obligation]));
      // This models the base store's durable cursor: process reconstruction
      // retains the scan position because it lives beside the obligations.
      let durableCursor = -1;
      mockBaseStore.listSyncPublicationObligations = vi.fn(async (limit) => {
        let page = obligations.filter((obligation, index) => (
          index > durableCursor && durable.has(obligation.sessionId)
        )).slice(0, limit);
        if (page.length === 0 && durableCursor >= 0) {
          durableCursor = -1;
          page = obligations.filter((obligation) => durable.has(obligation.sessionId)).slice(0, limit);
        }
        if (page.length > 0) {
          durableCursor = obligations.indexOf(page[page.length - 1]);
        }
        return page;
      });
      mockBaseStore.clearSyncPublicationObligation = vi.fn(async (sessionId, obligationId) => {
        if (durable.get(sessionId)?.obligationId !== obligationId) return false;
        durable.delete(sessionId);
        return true;
      });
      const published: string[] = [];
      mockSyncProvider.pushMetadataChangeWithResult = vi.fn(async (sessionId) => {
        if (sessionId !== 'session-100') return {
          outcome: 'queued', attempted: false, indexFrameWritten: false,
          skippedReason: 'queued_until_session_indexed',
        } as const;
        published.push(sessionId);
        return {
          outcome: 'index_frame_written', attempted: true, indexFrameWritten: true,
          skippedReason: null,
        } as const;
      }) as any;

      const restarted = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
      await restarted.ensureReady();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSyncProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(100);
      expect(durable.size).toBe(101);

      // No mutation and no restart is needed: failed page entries yield their
      // bounded slots, while the durable cursor advances to the next page.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(published).toEqual(['session-100']);
      expect(durable.has('session-100')).toBe(false);
      expect(durable.size).toBe(100);

      // Reconstruction resumes the durable cursor and never republishes the
      // already acknowledged fact, while the stuck facts remain retryable.
      vi.clearAllTimers();
      const afterRestart = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
      await afterRestart.ensureReady();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockBaseStore.listSyncPublicationObligations).toHaveBeenCalledWith(100);
      expect(published).toEqual(['session-100']);
      expect(durable.size).toBe(100);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(101);
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes scans and safely abandons a stale provider without cursor or timer resurrection', async () => {
    vi.useFakeTimers();
    try {
      const obligation = {
        obligationId: 'dispose-obligation',
        sessionId: 'dispose-session',
        workspaceId: '/repo',
        createdAt: 1,
      };
      persistedSessions.set(obligation.sessionId, {
        id: obligation.sessionId,
        provider: 'claude-code',
        title: 'Authoritative',
        workspacePath: '/repo',
        messages: [], createdAt: 1, updatedAt: 2,
      });
      mockSyncProvider.pushMetadataChangeWithResult = vi.fn() as any;
      let releaseScan!: () => void;
      const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
      let scanReached!: () => void;
      const atScan = new Promise<void>((resolve) => { scanReached = resolve; });
      mockBaseStore.listSyncPublicationObligations = vi.fn(async () => {
        scanReached();
        await scanGate;
        return [obligation];
      });
      mockBaseStore.clearSyncPublicationObligation = vi.fn().mockResolvedValue(true);
      const oldStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
      const ready = oldStore.ensureReady();
      await atScan;

      const disposing = oldStore.dispose?.();
      // A hung durable scan is safely abandoned: the persisted obligation is
      // still the restart authority, while replacement is never held hostage.
      let scanReleased = false;
      void scanGate.then(() => { scanReleased = true; });
      const disposalOutcome = Promise.race([
        disposing!.then(() => 'disposed' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await disposalOutcome).toBe('disposed');
      expect(scanReleased).toBe(false);
      releaseScan();
      await ready;
      await disposing;
      expect(mockSyncProvider.pushMetadataChangeWithResult).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      // A provider call already admitted before disposal may settle later, but
      // its obsolete decorator cannot clear the fact or schedule more work.
      let releaseProvider!: (value: any) => void;
      const providerGate = new Promise<any>((resolve) => { releaseProvider = resolve; });
      let providerReached!: () => void;
      const atProvider = new Promise<void>((resolve) => { providerReached = resolve; });
      mockBaseStore.listSyncPublicationObligations = vi.fn().mockResolvedValue([obligation]);
      mockSyncProvider.pushMetadataChangeWithResult = vi.fn(async () => {
        providerReached();
        return providerGate;
      }) as any;
      const staleStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
      await staleStore.ensureReady();
      await vi.advanceTimersByTimeAsync(0);
      await atProvider;
      await staleStore.dispose?.();
      releaseProvider({
        outcome: 'queued', attempted: false, indexFrameWritten: false,
        skippedReason: 'stale-provider',
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(mockBaseStore.clearSyncPublicationObligation).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      const currentProvider = {
        ...mockSyncProvider,
        pushMetadataChangeWithResult: vi.fn().mockResolvedValue({
          outcome: 'index_frame_written', attempted: true,
          indexFrameWritten: true, skippedReason: null,
        }),
      } as any;
      const currentStore = createSyncedSessionStore(mockBaseStore, currentProvider);
      await currentStore.ensureReady();
      await vi.advanceTimersByTimeAsync(0);
      expect(currentProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(1);
      expect(mockBaseStore.clearSyncPublicationObligation).toHaveBeenCalledWith(
        obligation.sessionId, obligation.obligationId,
      );
      await currentStore.dispose?.();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('backs a permanently queued durable fact off instead of retrying every second forever', async () => {
    vi.useFakeTimers();
    try {
      const obligation = {
        obligationId: 'backoff-obligation',
        sessionId: 'backoff-session',
        workspaceId: '/repo',
        createdAt: 1,
      };
      persistedSessions.set(obligation.sessionId, {
        id: obligation.sessionId,
        provider: 'claude-code',
        title: 'Authoritative',
        workspacePath: '/repo',
        messages: [], createdAt: 1, updatedAt: 2,
      });
      mockBaseStore.listSyncPublicationObligations = vi.fn().mockResolvedValue([obligation]);
      mockBaseStore.clearSyncPublicationObligation = vi.fn().mockResolvedValue(false);
      mockSyncProvider.pushMetadataChangeWithResult = vi.fn().mockResolvedValue({
        outcome: 'queued', attempted: false, indexFrameWritten: false,
        skippedReason: 'queued_until_session_indexed',
      }) as any;

      const store = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
      await store.ensureReady();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSyncProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(1);

      // First failure yields the slot and schedules a durable rescan after
      // 100ms. Reloaded work retains that attempt count and waits another
      // 100ms before touching the provider.
      await vi.advanceTimersByTimeAsync(199);
      expect(mockSyncProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockSyncProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(2);

      // The next cycle has doubled both the rescan and per-fact delay; this
      // guards against a fixed one-second retry storm as the outage persists.
      await vi.advanceTimersByTimeAsync(399);
      expect(mockSyncProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockSyncProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1);

      await store.dispose?.();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('cancels create, metadata, and visibility waiters behind a retired never-settling provider', async () => {
    vi.useFakeTimers();
    try {
      const ids = ['queued-create', 'queued-metadata', 'queued-visibility'];
      for (const id of ids) {
        persistedSessions.set(id, {
          id, provider: 'claude-code', title: id, workspacePath: '/repo',
          isPinned: false, messages: [], createdAt: 1, updatedAt: 2,
        });
      }
      mockBaseStore.listSyncPublicationObligations = vi.fn().mockResolvedValue(
        ids.map((sessionId) => ({
          obligationId: `obligation-${sessionId}`,
          sessionId,
          workspaceId: '/repo',
          createdAt: 1,
        })),
      );
      mockBaseStore.clearSyncPublicationObligation = vi.fn().mockResolvedValue(false);
      const never = new Promise<never>(() => undefined);
      mockSyncProvider.pushMetadataChangeWithResult = vi.fn(() => never) as any;
      const oldStore = createSyncedSessionStore(mockBaseStore, mockSyncProvider);
      AISessionsRepository.setStore(oldStore);
      await oldStore.ensureReady();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSyncProvider.pushMetadataChangeWithResult).toHaveBeenCalledTimes(3);

      const oldCreate = AISessionsRepository.create({
        id: ids[0], provider: 'claude-code', title: 'obsolete create', workspaceId: '/repo',
      });
      const oldMetadata = AISessionsRepository.updateMetadata(ids[1], {
        title: 'obsolete metadata',
      });
      const oldVisibility = AISessionsRepository.setPinnedVisibility(
        ids[2], true, 'obsolete-pin', false, '/repo', '/repo',
      );
      await Promise.resolve();
      expect(mockBaseStore.create).not.toHaveBeenCalled();
      expect(mockBaseStore.updateMetadata).not.toHaveBeenCalled();
      expect(mockBaseStore.applyVisibilityMutation).not.toHaveBeenCalled();

      // Disposal is terminal even though all three old provider continuations
      // remain pending. Each queued repository caller is rejected and releases
      // its shared per-session writer tail without entering the base store.
      await oldStore.dispose?.();
      await expect(oldCreate).rejects.toThrow('SYNCED_SESSION_STORE_DISPOSED');
      await expect(oldMetadata).rejects.toThrow('SYNCED_SESSION_STORE_DISPOSED');
      await expect(oldVisibility).rejects.toThrow('SYNCED_SESSION_STORE_DISPOSED');
      expect(mockBaseStore.create).not.toHaveBeenCalled();
      expect(mockBaseStore.updateMetadata).not.toHaveBeenCalled();
      expect(mockBaseStore.applyVisibilityMutation).not.toHaveBeenCalled();

      const currentProvider = {
        ...mockSyncProvider,
        pushMetadataChangeWithResult: vi.fn().mockResolvedValue({
          outcome: 'index_frame_written', attempted: true,
          indexFrameWritten: true, skippedReason: null,
        }),
      } as any;
      const currentStore = createSyncedSessionStore(mockBaseStore, currentProvider);
      AISessionsRepository.setStore(currentStore);
      await expect(AISessionsRepository.create({
        id: ids[0], provider: 'claude-code', title: 'current create', workspaceId: '/repo',
      })).resolves.toBeUndefined();
      await expect(AISessionsRepository.updateMetadata(ids[1], {
        title: 'current metadata',
      })).resolves.toBeUndefined();
      await expect(AISessionsRepository.setPinnedVisibility(
        ids[2], true, 'current-pin', false, '/repo', '/repo',
      )).resolves.toBeUndefined();
      expect(mockBaseStore.create).toHaveBeenCalledTimes(1);
      expect(mockBaseStore.updateMetadata).toHaveBeenCalledTimes(1);
      expect(mockBaseStore.applyVisibilityMutation).toHaveBeenCalledTimes(1);
      await currentStore.dispose?.();
    } finally {
      AISessionsRepository.configureVisibilityStorageFence(null);
      AISessionsRepository.clearStore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('holds the repository tail until an admitted base mutation settles, then lets the successor win', async () => {
    const sessionId = 'admitted-base-mutation';
    persistedSessions.set(sessionId, {
      id: sessionId, provider: 'claude-code', workspacePath: '/repo',
      title: 'initial', messages: [], createdAt: 1, updatedAt: 1,
    });
    let releaseA!: () => void;
    const aCommitGate = new Promise<void>((resolve) => { releaseA = resolve; });
    let enteredA!: () => void;
    const aEnteredBase = new Promise<void>((resolve) => { enteredA = resolve; });
    const baseMutationOrder: string[] = [];
    mockBaseStore.updateMetadata = vi.fn(async (id, metadata) => {
      baseMutationOrder.push(`enter:${String(metadata.title)}`);
      if (metadata.title === 'A') {
        enteredA();
        await aCommitGate;
      }
      persistedSessions.get(id).title = metadata.title;
      baseMutationOrder.push(`commit:${String(metadata.title)}`);
    });
    const oldProvider = {
      ...mockSyncProvider,
      pushChange: vi.fn(),
    } as SyncProvider;
    const oldStore = createSyncedSessionStore(mockBaseStore, oldProvider);
    AISessionsRepository.setStore(oldStore);

    const writeA = AISessionsRepository.updateMetadata(sessionId, { title: 'A' });
    await aEnteredBase;
    let disposalSettled = false;
    const disposing = oldStore.dispose!().then(() => { disposalSettled = true; });
    await Promise.resolve();
    expect(disposalSettled).toBe(false);

    const currentProvider = {
      ...mockSyncProvider,
      pushChange: vi.fn(),
    } as SyncProvider;
    const currentStore = createSyncedSessionStore(mockBaseStore, currentProvider);
    AISessionsRepository.setStore(currentStore);
    const writeB = AISessionsRepository.updateMetadata(sessionId, { title: 'B' });
    await Promise.resolve();

    // B is registered but cannot enter the shared production repository tail
    // while A's already-admitted base statement can still commit.
    expect(baseMutationOrder).toEqual(['enter:A']);
    releaseA();
    await expect(writeA).resolves.toBeUndefined();
    await disposing;
    await expect(writeB).resolves.toBeUndefined();

    expect(baseMutationOrder).toEqual([
      'enter:A', 'commit:A', 'enter:B', 'commit:B',
    ]);
    expect(persistedSessions.get(sessionId).title).toBe('B');
    // A reports its durable local commit but is retired before publication;
    // only B emits the authoritative peer update.
    expect(oldProvider.pushChange).not.toHaveBeenCalled();
    expect(currentProvider.pushChange).toHaveBeenCalledWith(sessionId, {
      type: 'metadata_updated', metadata: { title: 'B', updatedAt: expect.any(Number) },
    });
    await currentStore.dispose?.();
    AISessionsRepository.clearStore();
  });
});
