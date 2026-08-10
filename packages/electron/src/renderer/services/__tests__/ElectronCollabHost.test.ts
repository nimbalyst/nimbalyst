// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { parseTrackerDeepLink } from '../../../shared/trackerDeepLinks';
import { historyDialogFileAtom } from '../../store/atoms/historyDialog';

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

    expect(openArtifact).toHaveBeenCalledWith(ref, 'history');
    expect(store.get(historyDialogFileAtom)).toBe('collab://org:org-1:doc:doc-1');
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
});
