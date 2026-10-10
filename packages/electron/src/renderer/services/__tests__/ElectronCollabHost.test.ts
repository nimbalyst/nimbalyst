// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { parseTrackerDeepLink } from '../../../shared/trackerDeepLinks';
import { historyDialogFileAtom } from '../../store/atoms/historyDialog';
import { buildCollabUri } from '@nimbalyst/collab-protocol';

const personalStateMocks = vi.hoisted(() => ({
  getForScope: vi.fn(),
  setFavorite: vi.fn(),
  recordOpened: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));

vi.mock('../RendererTrackerPersonalStateService', () => ({
  trackerPersonalStateService: personalStateMocks,
}));
vi.mock('../CollaborativeDocumentTypeCatalog', () => ({
  getCollaborativeDocumentTypeCatalog: () => ({ getDescriptors: () => [] }),
}));
vi.mock('../ErrorNotificationService', () => ({
  errorNotificationService: { showFromError: vi.fn() },
}));
vi.mock('../orgSettingsClient', () => ({ applyOrgSettingsBroadcast: vi.fn() }));
vi.mock('../conversationDirectoryClient', () => ({ applyConversationDescriptorBroadcast: vi.fn() }));
const dataSources = vi.hoisted(() => [] as Array<{ disposed: boolean }>);
vi.mock('../ElectronCollabDocumentsDataSource', () => ({
  ElectronCollabDocumentsDataSource: class {
    disposed = false;
    constructor() { dataSources.push(this); }
    async snapshot() {
      if (this.disposed) throw new Error('Data source has been disposed');
      return { items: [], containers: [] };
    }
    subscribe() { return () => undefined; }
    status() { return 'connected'; }
    dispose() { this.disposed = true; }
  },
}));

import { ElectronCollabHost } from '../ElectronCollabHost';

describe('ElectronCollabHost personal state', () => {
  const invoke = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    personalStateMocks.getForScope.mockResolvedValue({
      scope: 'org:org-1:tracker:project-1',
      rows: [],
    });
    personalStateMocks.setFavorite.mockImplementation(async (input) => ({
      userEmail: 'person@example.com',
      scope: 'org:org-1:tracker:project-1',
      itemId: input.itemId,
      isFavorite: input.isFavorite,
      favoriteUpdatedAt: input.favoriteUpdatedAt,
      lastOpenedAt: null,
      snoozedUntil: null,
      updatedAt: input.favoriteUpdatedAt,
    }));
    personalStateMocks.recordOpened.mockImplementation(async (input) => ({
      userEmail: 'person@example.com',
      scope: 'org:org-1:tracker:project-1',
      itemId: input.itemId,
      isFavorite: false,
      favoriteUpdatedAt: 0,
      lastOpenedAt: input.lastOpenedAt,
      snoozedUntil: null,
      updatedAt: input.lastOpenedAt,
    }));
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'workspace:get-state') {
        return {
          collabDiscovery: {
            favorites: ['doc-newer', 'doc-older'],
            openedAt: { 'doc-opened': 4_000 },
            treeFilter: 'favorites',
            showUnreadBubbles: false,
          },
        };
      }
      return undefined;
    });
    vi.stubGlobal('window', {
      electronAPI: {
        invoke,
        documentSync: {
          resolveIndexConfig: vi.fn(async () => ({
            success: true,
            config: {
              orgId: 'org-1',
              teamProjectId: 'project-1',
              serverUrl: 'wss://example.test',
              userId: 'member-1',
              userEmail: 'person@example.com',
            },
          })),
          getJwt: vi.fn(async () => ({ success: true, jwt: 'team-jwt' })),
        },
      },
    });
    store.set(historyDialogFileAtom, null);
  });

  it('migrates legacy favorites and opened timestamps once with fixed LWW versions', async () => {
    const host = new ElectronCollabHost({ scopeKey: '/workspace/one' });
    const scope = await host.resolveScope();
    const snapshot = await host.personalState.capability.snapshot(scope);

    expect(personalStateMocks.getForScope).toHaveBeenCalledWith('/workspace/one');
    expect(personalStateMocks.setFavorite.mock.calls.map(([input]) => input)).toEqual([
      {
        workspacePath: '/workspace/one',
        itemId: 'document:doc-newer',
        isFavorite: true,
        favoriteUpdatedAt: 10_000,
      },
      {
        workspacePath: '/workspace/one',
        itemId: 'document:doc-older',
        isFavorite: true,
        favoriteUpdatedAt: 9_999,
      },
    ]);
    expect(personalStateMocks.recordOpened).toHaveBeenCalledWith({
      workspacePath: '/workspace/one',
      itemId: 'document:doc-opened',
      lastOpenedAt: 4_000,
    });
    expect(snapshot.rows.map((row) => row.itemId).sort()).toEqual([
      'doc-newer',
      'doc-older',
      'doc-opened',
    ]);
    expect(invoke).toHaveBeenCalledWith('workspace:update-state', '/workspace/one', {
      collabDiscovery: { personalStateMigrationStartedAt: 10_000 },
    });
    expect(invoke).toHaveBeenCalledWith('workspace:update-state', '/workspace/one', {
      collabDiscovery: {
        favorites: [],
        openedAt: {},
        personalStateMigrationStartedAt: 10_000,
        personalStateMigratedAt: 10_000,
      },
    });
    expect(personalStateMocks.setFavorite.mock.calls[0][0]).not.toHaveProperty('userEmail');
  });

  it('keeps view preferences local and skips completed legacy migration', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'workspace:get-state') {
        return {
          collabDiscovery: {
            favorites: ['legacy-doc'],
            personalStateMigratedAt: 9_000,
            treeFilter: 'updated',
            showUnreadBubbles: false,
          },
        };
      }
      return undefined;
    });
    const host = new ElectronCollabHost({ scopeKey: '/workspace/two' });
    const scope = await host.resolveScope();

    await host.personalState.capability.snapshot(scope);
    expect(personalStateMocks.setFavorite).not.toHaveBeenCalled();
    await expect(host.documents.loadViewPreferences(scope.scopeKey)).resolves.toEqual({
      treeFilter: 'updated',
      showUnreadBubbles: false,
    });
  });

  it('filters remote rows by both resolved scope and host identity', async () => {
    invoke.mockImplementation(async (channel: string) => channel === 'workspace:get-state'
      ? { collabDiscovery: { personalStateMigratedAt: 9_000 } }
      : undefined);
    let remoteListener: ((row: any) => void) | undefined;
    (personalStateMocks.subscribe as any).mockImplementation((listener: (row: any) => void) => {
      remoteListener = listener;
      return () => undefined;
    });
    const host = new ElectronCollabHost({ scopeKey: '/workspace/identity' });
    const scope = await host.resolveScope();
    await host.personalState.capability.snapshot(scope);
    const received = vi.fn();
    host.personalState.capability.subscribe(scope, received);
    const baseRow = {
      scope: 'org:org-1:tracker:project-1',
      itemId: 'document:doc-1',
      isFavorite: true,
      favoriteUpdatedAt: 1,
      lastOpenedAt: null,
      snoozedUntil: null,
      updatedAt: 1,
    };

    remoteListener?.({ ...baseRow, userEmail: 'other@example.com' });
    remoteListener?.({ ...baseRow, scope: 'other-scope', userEmail: 'person@example.com' });
    remoteListener?.({ ...baseRow, userEmail: 'person@example.com' });

    expect(received).toHaveBeenCalledTimes(1);
  });

  it('builds tracker artifact URLs that round-trip to document view', async () => {
    const host = new ElectronCollabHost({ scopeKey: '/workspace/links' });
    const scope = await host.resolveScope();
    const url = host.artifactUrl({ kind: 'tracker', scope, trackerId: 'tracker/one' });

    expect(url).not.toBeNull();
    expect(parseTrackerDeepLink(url!)).toEqual({
      trackerId: 'tracker/one',
      orgId: 'org-1',
      view: 'document',
    });
  });

  it('routes history navigation through the host and opens the history surface', async () => {
    const openArtifact = vi.fn();
    const host = new ElectronCollabHost({ scopeKey: '/workspace/history', openArtifact });
    const scope = await host.resolveScope();
    const ref = {
      kind: 'document' as const,
      scope,
      documentId: 'doc-1',
      teamProjectId: 'project-1',
    };

    host.openArtifact(ref, 'history');

    expect(openArtifact).toHaveBeenCalledWith(ref, 'history', undefined);
    expect(store.get(historyDialogFileAtom)).toBe('collab://org:org-1:doc:doc-1');

    // A typed page's body and a type page's prose are rooms of their own.
    host.openArtifact({ kind: 'tracker', scope, trackerId: 'item-1' }, 'history');
    expect(store.get(historyDialogFileAtom)).toBe(buildCollabUri('org-1', 'tracker-content/item-1'));
    host.openArtifact({ kind: 'type', scope, typeId: 'module' }, 'history');
    expect(store.get(historyDialogFileAtom)).toBe(buildCollabUri('org-1', 'type-page:module'));
  });

  // A window opened before sign-in resolves once, fails non-retryably, and the
  // docs lifecycle stops for good -- so signing in later left Shared Docs, the
  // quick-open Team tab, and "Share to team" hidden until the window reopened.
  it('re-resolves a scope that failed non-retryably when invalidated', async () => {
    const resolveIndexConfig = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'Not authenticated. Sign in first.' })
      .mockResolvedValue({
        success: true,
        config: {
          orgId: 'org-1',
          teamProjectId: 'project-1',
          serverUrl: 'wss://example.test',
          userId: 'member-1',
          userEmail: 'person@example.com',
        },
      });
    (window as any).electronAPI.documentSync.resolveIndexConfig = resolveIndexConfig;
    const host = new ElectronCollabHost({ scopeKey: '/workspace/signed-out' });
    const observed: Array<unknown> = [];
    host.onScopeChanged((scope) => observed.push(scope));

    await expect(host.resolveScope()).rejects.toThrow('Not authenticated');

    host.invalidateScope();

    expect(observed).toEqual([null]);
    await expect(host.resolveScope()).resolves.toMatchObject({
      scopeKey: '/workspace/signed-out',
      orgId: 'org-1',
    });
  });

  // Hosts are window singletons but a docs session is per mount: CollabMode
  // remounting after a renderer error disposed the source through the session
  // and the next session got the same disposed instance ("Data source has been
  // disposed") until the window reloaded.
  it('gives a session created after dispose a live data source', async () => {
    dataSources.length = 0;
    const host = new ElectronCollabHost({ scopeKey: '/workspace/remount' });
    const source = host.documents.dataSource;

    await source.snapshot();
    source.dispose();
    await expect(source.snapshot()).resolves.toEqual({ items: [], containers: [] });
    expect(dataSources.map((s) => s.disposed)).toEqual([true, false]);

    // Disposed while the source is still being created: the late source must
    // not replace the one the next session gets.
    const pending = source.snapshot();
    host.invalidateScope();
    await pending.catch(() => undefined);
    await source.snapshot();
    expect(dataSources.filter((s) => !s.disposed)).toHaveLength(1);
    expect(host.peekInProcessDocumentsDataSource()).toBe(dataSources.find((s) => !s.disposed));
  });

  // An unmounted session's request must be cancelled, not carried into the
  // next generation, or it creates and connects a source nobody owns.
  it('drops a request whose session was disposed while the scope resolved', async () => {
    dataSources.length = 0;
    let finishResolve: () => void = () => undefined;
    const config = {
      success: true,
      config: { orgId: 'org-1', teamProjectId: 'project-1', serverUrl: 'wss://example.test' },
    };
    (window as any).electronAPI.documentSync.resolveIndexConfig = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishResolve = () => resolve(config); }))
      .mockResolvedValue(config);
    const host = new ElectronCollabHost({ scopeKey: '/workspace/pending' });
    const source = host.documents.dataSource;

    const pending = source.snapshot();
    source.dispose();
    finishResolve();

    await expect(pending).rejects.toThrow('disposed');
    expect(dataSources).toHaveLength(0);

    await source.snapshot();
    expect(dataSources).toHaveLength(1);
  });

  // Main answers whether a failed lookup can be retried; the renderer used to
  // decide by substring-matching the message, so a transient team-directory
  // failure that happened to read "No team found" was latched as permanent and
  // Shared Docs stayed hidden for the session.
  it('carries the retryable flag from the resolver instead of reading the message', async () => {
    // Flag and wording deliberately disagree: only reading the flag can pass.
    (window as any).electronAPI.documentSync.resolveIndexConfig = vi.fn(async () => ({
      success: false,
      error: 'No team found for this workspace.',
      retryable: true,
    }));

    const host = new ElectronCollabHost({ scopeKey: '/workspace/flaky' });

    await expect(host.resolveScope()).rejects.toMatchObject({
      name: 'CollabScopeResolutionError',
      retryable: true,
    });
  });
});
