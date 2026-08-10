import {
  CollabScopeResolutionError,
  type CollabArtifactRef,
  type CollabDocsCapability,
  type CollabDocsCreateInput,
  type CollabDocsViewPreferences,
  type CollabDocumentTypeDescriptor,
  type CollabHost,
  type CollabOpenSource,
  type CollabPersonalStateCapability,
  type CollabPersonalStateRow,
  type CollabScope,
  type TeamMemberSummary,
} from '@nimbalyst/collab-client/core';
import type {
  CollabDocsCommand,
  CollabDocsCommandResult,
  CollabDocsDataSource,
  SharedDocument,
  SharedFolder,
} from '@nimbalyst/collab-client/docs';
import { asTeamJwt } from '@nimbalyst/runtime/auth/jwtScopes';
import { store } from '@nimbalyst/runtime/store';
import { errorNotificationService } from './ErrorNotificationService';
import {
  trackerPersonalStateService,
  type TrackerPersonalStateDto,
} from './RendererTrackerPersonalStateService';
import {
  ElectronCollabDocumentsDataSource,
  type ElectronCollabDocumentsDataSourceEvents,
} from './ElectronCollabDocumentsDataSource';
import { applyOrgSettingsBroadcast } from './orgSettingsClient';
import { applyConversationDescriptorBroadcast } from './conversationDirectoryClient';
import { trackTeamAnalyticsEvent } from '../utils/teamAnalytics';
import { readReceiptService } from './RendererReadReceiptService';
import { CollaborationHealthAttemptTracker } from '../../shared/analytics/collaborationHealth';
import { historyDialogFileAtom } from '../store/atoms/historyDialog';
import { buildCollabUri } from '../utils/collabUri';
import {
  buildSharedDocumentDeepLink,
  buildSharedFolderDeepLink,
  buildTrackerDeepLink,
} from '../utils/collabArtifactDeepLinks';

interface LegacyCollabDiscoveryState {
  favorites?: string[];
  openedAt?: Record<string, number>;
  treeFilter?: CollabDocsViewPreferences['treeFilter'];
  showUnreadBubbles?: boolean;
  personalStateMigrationStartedAt?: number;
  personalStateMigratedAt?: number;
}

export interface ElectronCollabHostOptions {
  scopeKey: string;
  openArtifact?: (ref: CollabArtifactRef, source: CollabOpenSource) => void;
}

type ElectronDocsCapability = CollabDocsCapability<
  SharedDocument,
  SharedFolder,
  CollabDocsCommand,
  CollabDocsCommandResult
>;

const DOCUMENT_PERSONAL_STATE_PREFIX = 'document:';
let documentTypesAdapter: () => readonly CollabDocumentTypeDescriptor[] = () => [];
let documentTypesSubscribe: (cb: () => void) => () => void = () => () => undefined;
let createDocumentAdapter: (input: CollabDocsCreateInput) => Promise<void> = async () => {
  throw new Error('Collaborative document creation is not registered');
};
const initializedTeamIndexScopes = new Set<string>();

/** Registered by the desktop extension catalog without reversing the host boundary. */
export function registerElectronCollabDocumentTypes(
  adapter: () => readonly CollabDocumentTypeDescriptor[],
  subscribe: (cb: () => void) => () => void = () => () => undefined,
): () => void {
  documentTypesAdapter = adapter;
  documentTypesSubscribe = subscribe;
  return () => {
    if (documentTypesAdapter === adapter) {
      documentTypesAdapter = () => [];
      documentTypesSubscribe = () => () => undefined;
    }
  };
}

/** Registered by the desktop creation orchestrator without leaking it into core. */
export function registerElectronCollabDocumentCreation(
  adapter: (input: CollabDocsCreateInput) => Promise<void>,
): () => void {
  createDocumentAdapter = adapter;
  return () => {
    if (createDocumentAdapter === adapter) {
      createDocumentAdapter = async () => {
        throw new Error('Collaborative document creation is not registered');
      };
    }
  };
}

function storedDocumentItemId(documentId: string): string {
  return `${DOCUMENT_PERSONAL_STATE_PREFIX}${documentId}`;
}

function mapPersonalStateRow(row: TrackerPersonalStateDto): CollabPersonalStateRow {
  return {
    scope: row.scope,
    itemId: row.itemId.slice(DOCUMENT_PERSONAL_STATE_PREFIX.length),
    isFavorite: row.isFavorite,
    favoriteUpdatedAt: row.favoriteUpdatedAt,
    lastOpenedAt: row.lastOpenedAt,
    updatedAt: row.updatedAt,
  };
}

class ElectronCollabPersonalState implements CollabPersonalStateCapability {
  private readonly bindings = new Map<string, { scope: string; userEmail: string | null }>();

  async snapshot(scope: CollabScope) {
    let hydration = await trackerPersonalStateService.getForScope(scope.scopeKey);
    const workspaceState = await window.electronAPI?.invoke?.(
      'workspace:get-state',
      scope.scopeKey,
    );
    const legacy = (workspaceState?.collabDiscovery ?? {}) as LegacyCollabDiscoveryState;
    if (!legacy.personalStateMigratedAt) {
      hydration = await this.migrateLegacyState(scope, hydration, legacy);
    }
    this.bindings.set(scope.scopeKey, {
      scope: hydration.scope,
      userEmail: scope.indexConfig.userEmail?.toLowerCase()
        ?? hydration.rows[0]?.userEmail.toLowerCase()
        ?? null,
    });
    return {
      scope: hydration.scope,
      rows: hydration.rows
        .filter((row) => row.itemId.startsWith(DOCUMENT_PERSONAL_STATE_PREFIX))
        .map(mapPersonalStateRow),
    };
  }

  subscribe(scope: CollabScope, cb: (row: CollabPersonalStateRow) => void): () => void {
    return trackerPersonalStateService.subscribe((row) => {
      const binding = this.bindings.get(scope.scopeKey);
      if (!binding || binding.scope !== row.scope) return;
      if (binding.userEmail && binding.userEmail !== row.userEmail.toLowerCase()) return;
      if (!row.itemId.startsWith(DOCUMENT_PERSONAL_STATE_PREFIX)) return;
      cb(mapPersonalStateRow(row));
    });
  }

  async setFavorite(input: {
    scope: CollabScope;
    itemId: string;
    isFavorite: boolean;
    favoriteUpdatedAt: number;
  }): Promise<CollabPersonalStateRow | null> {
    const row = await trackerPersonalStateService.setFavorite({
      workspacePath: input.scope.scopeKey,
      itemId: storedDocumentItemId(input.itemId),
      isFavorite: input.isFavorite,
      favoriteUpdatedAt: input.favoriteUpdatedAt,
    });
    return row ? mapPersonalStateRow(row) : null;
  }

  async recordOpened(input: {
    scope: CollabScope;
    itemId: string;
    lastOpenedAt: number;
  }): Promise<CollabPersonalStateRow | null> {
    const row = await trackerPersonalStateService.recordOpened({
      workspacePath: input.scope.scopeKey,
      itemId: storedDocumentItemId(input.itemId),
      lastOpenedAt: input.lastOpenedAt,
    });
    return row ? mapPersonalStateRow(row) : null;
  }

  private async migrateLegacyState(
    scope: CollabScope,
    hydration: Awaited<ReturnType<typeof trackerPersonalStateService.getForScope>>,
    legacy: LegacyCollabDiscoveryState,
  ) {
    const favorites = Array.isArray(legacy.favorites)
      ? legacy.favorites.filter((id): id is string => typeof id === 'string')
      : [];
    const openedAt = legacy.openedAt && typeof legacy.openedAt === 'object'
      ? Object.entries(legacy.openedAt).filter(
          (entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] > 0,
        )
      : [];
    const migrationStartedAt = legacy.personalStateMigrationStartedAt ?? Date.now();

    // Persist the fixed migration clock before writing. A crash/retry reuses
    // the same LWW versions instead of repeatedly overriding newer choices.
    if (!legacy.personalStateMigrationStartedAt) {
      await window.electronAPI?.invoke?.('workspace:update-state', scope.scopeKey, {
        collabDiscovery: { personalStateMigrationStartedAt: migrationStartedAt },
      });
    }

    const rows = new Map(hydration.rows.map((row) => [row.itemId, row]));
    for (const [index, itemId] of favorites.entries()) {
      const favoriteUpdatedAt = migrationStartedAt - index;
      const row = await trackerPersonalStateService.setFavorite({
        workspacePath: scope.scopeKey,
        itemId: storedDocumentItemId(itemId),
        isFavorite: true,
        favoriteUpdatedAt,
      });
      if (row) rows.set(row.itemId, row);
    }
    for (const [itemId, lastOpenedAt] of openedAt) {
      const row = await trackerPersonalStateService.recordOpened({
        workspacePath: scope.scopeKey,
        itemId: storedDocumentItemId(itemId),
        lastOpenedAt,
      });
      if (row) rows.set(row.itemId, row);
    }

    await window.electronAPI?.invoke?.('workspace:update-state', scope.scopeKey, {
      collabDiscovery: {
        favorites: [],
        openedAt: {},
        personalStateMigrationStartedAt: migrationStartedAt,
        personalStateMigratedAt: Date.now(),
      },
    });
    return { scope: hydration.scope, rows: Array.from(rows.values()) };
  }
}

/** Electron renderer implementation of the browser-safe collaboration host. */
export class ElectronCollabHost implements CollabHost<ElectronDocsCapability> {
  readonly surface = 'desktop' as const;
  private scopeKey: string;
  private scopePromise: Promise<CollabScope> | null = null;
  private dataSource: ElectronCollabDocumentsDataSource | null = null;
  private dataSourcePromise: Promise<ElectronCollabDocumentsDataSource> | null = null;
  private readonly scopeListeners = new Set<(scope: CollabScope | null) => void>();
  private openArtifactImpl?: ElectronCollabHostOptions['openArtifact'];
  readonly personalState = {
    status: 'available' as const,
    capability: new ElectronCollabPersonalState(),
  };
  readonly documents: ElectronDocsCapability;

  constructor(options: ElectronCollabHostOptions) {
    this.scopeKey = options.scopeKey;
    this.openArtifactImpl = options.openArtifact;
    this.documents = {
      dataSource: this.createLazyDataSource(),
      loadViewPreferences: async (scopeKey) => {
        const state = await window.electronAPI?.invoke?.('workspace:get-state', scopeKey);
        const discovery = state?.collabDiscovery as LegacyCollabDiscoveryState | undefined;
        return {
          treeFilter: discovery?.treeFilter === 'favorites' || discovery?.treeFilter === 'updated'
            ? discovery.treeFilter
            : 'all',
          showUnreadBubbles: discovery?.showUnreadBubbles !== false,
        };
      },
      saveViewPreferences: async (scopeKey, preferences) => {
        await window.electronAPI?.invoke?.('workspace:update-state', scopeKey, {
          collabDiscovery: preferences,
        });
      },
      loadTreeState: async (scopeKey) => {
        const state = await window.electronAPI?.invoke?.('workspace:get-state', scopeKey);
        return {
          expandedFolders: Array.isArray(state?.collabTree?.expandedFolders)
            ? state.collabTree.expandedFolders
            : [],
          userTouched: state?.collabTree?.userTouched === true,
        };
      },
      saveTreeState: async (scopeKey, treeState) => {
        await window.electronAPI?.invoke?.('workspace:update-state', scopeKey, {
          collabTree: treeState,
        });
      },
      documentTypes: () => documentTypesAdapter(),
      onDocumentTypesChanged: (cb) => documentTypesSubscribe(cb),
      createDocument: (input) => createDocumentAdapter(input),
      readReceipts: {
        status: 'available',
        capability: {
          snapshot: async (scope) => (await readReceiptService.getForScope(
            'doc',
            scope.orgId,
            scope.scopeKey,
          )).map((row) => ({
            entityId: row.entityId,
            lastSeenVersion: row.lastSeenVersion,
            lastViewedAt: row.lastViewedAt,
          })),
          markViewed: async ({ scope, documentId, lastViewedAt }) => {
            await readReceiptService.markViewed({
              entityKind: 'doc',
              entityId: documentId,
              scope: scope.orgId,
              lastViewedAt,
              lastSeenVersion: null,
              workspacePath: scope.scopeKey,
            });
          },
        },
      },
    };
  }

  async resolveScope(): Promise<CollabScope> {
    if (!this.scopePromise) {
      const pending = this.resolveCurrentScope().catch((error) => {
        if (this.scopePromise === pending) this.scopePromise = null;
        throw error;
      });
      this.scopePromise = pending;
    }
    return this.scopePromise;
  }

  onScopeChanged(cb: (scope: CollabScope | null) => void): () => void {
    this.scopeListeners.add(cb);
    return () => this.scopeListeners.delete(cb);
  }

  async getTeamJwt(orgId: string) {
    const result = await window.electronAPI.documentSync.getJwt(orgId);
    if (!result.success || !result.jwt) {
      throw new Error(result.error || 'Failed to get team JWT');
    }
    return asTeamJwt(result.jwt);
  }

  async getMembers(orgId: string): Promise<TeamMemberSummary[]> {
    const scope = await this.resolveScope();
    if (scope.orgId !== orgId) throw new Error('Requested members for a different organization');
    return (await this.ensureDataSource()).getMembers();
  }

  openArtifact(ref: CollabArtifactRef, source: CollabOpenSource): void {
    if (!this.openArtifactImpl) {
      throw new Error('This Electron host was created without a navigation adapter');
    }
    this.openArtifactImpl(ref, source);
    if (source === 'history' && ref.kind === 'document') {
      store.set(historyDialogFileAtom, buildCollabUri(ref.scope.orgId, ref.documentId));
    }
  }

  artifactUrl(ref: CollabArtifactRef): string | null {
    if (ref.kind === 'document') {
      return buildSharedDocumentDeepLink(ref.documentId, ref.scope.orgId);
    }
    if (ref.kind === 'folder') {
      return buildSharedFolderDeepLink(ref.folderId, ref.scope.orgId);
    }
    return buildTrackerDeepLink(ref.trackerId, ref.scope.orgId, { view: 'document' });
  }

  /** Mount/unmount the shell-specific tab/router navigation adapter. */
  setOpenArtifactAdapter(
    adapter: NonNullable<ElectronCollabHostOptions['openArtifact']>,
  ): () => void {
    this.openArtifactImpl = adapter;
    return () => {
      if (this.openArtifactImpl === adapter) this.openArtifactImpl = undefined;
    };
  }

  reportError(error: unknown, context: string): void {
    const resolved = error instanceof Error ? error : new Error(String(error));
    errorNotificationService.showFromError(resolved, context);
  }

  notify(notification: {
    level: 'info' | 'warning' | 'error';
    title: string;
    message: string;
    duration?: number;
  }): void {
    const options = notification.duration ? { duration: notification.duration } : undefined;
    if (notification.level === 'info') {
      errorNotificationService.showInfo(notification.title, notification.message, options);
    } else if (notification.level === 'warning') {
      errorNotificationService.showWarning(notification.title, notification.message, options);
    } else {
      errorNotificationService.showError(notification.title, notification.message);
    }
  }

  trackEvent(name: string, props: Record<string, unknown>): void {
    trackTeamAnalyticsEvent(name as Parameters<typeof trackTeamAnalyticsEvent>[0], props);
  }

  /** Electron-only compatibility access; shared code consumes `documents`. */
  getInProcessDocumentsDataSource(): Promise<ElectronCollabDocumentsDataSource> {
    return this.ensureDataSource();
  }

  peekInProcessDocumentsDataSource(): ElectronCollabDocumentsDataSource | null {
    return this.dataSource;
  }

  /** Host-private update used when a mounted desktop shell changes project. */
  setScopeKey(scopeKey: string): void {
    if (scopeKey === this.scopeKey) return;
    this.scopeKey = scopeKey;
    this.invalidateScope();
  }

  /**
   * Drop the resolved scope and push every listener back through resolution.
   *
   * Resolution fails permanently for a window opened before sign-in ("Not
   * authenticated") or before the project had an organization ("No team
   * found") -- the docs lifecycle treats both as non-retryable and stops. Until
   * something re-triggers it, signing in or creating an org cannot turn on the
   * Shared Docs gutter button, the quick-open Team tab, or "Share to team",
   * because the docs session is what marks the workspace as having a team.
   * The listener contract is identical to a project change.
   */
  invalidateScope(): void {
    this.dataSource?.dispose();
    this.scopePromise = null;
    this.dataSource = null;
    this.dataSourcePromise = null;
    for (const listener of this.scopeListeners) listener(null);
  }

  private async resolveCurrentScope(): Promise<CollabScope> {
    const requestedScopeKey = this.scopeKey;
    const result = await window.electronAPI.documentSync.resolveIndexConfig(requestedScopeKey);
    if (requestedScopeKey !== this.scopeKey) {
      throw new CollabScopeResolutionError('Collaboration scope changed during resolution', {
        retryable: true,
      });
    }
    if (!result.success || !result.config) {
      const message = result.error || 'No team found for this project';
      throw new CollabScopeResolutionError(message, {
        retryable: !message.includes('Not authenticated') && !message.includes('No team found'),
      });
    }
    const { orgId, teamProjectId, serverUrl, userId, userName, userEmail } = result.config;
    return {
      scopeKey: requestedScopeKey,
      orgId,
      indexConfig: { teamProjectId, serverUrl, userId, userName, userEmail },
    };
  }

  private createDataSourceEvents(scope: CollabScope): ElectronCollabDocumentsDataSourceEvents {
    const healthTracker = new CollaborationHealthAttemptTracker('team_index', 'server_managed');
    healthTracker.start(initializedTeamIndexScopes.has(scope.scopeKey) ? 'reconnect' : 'initial');
    initializedTeamIndexScopes.add(scope.scopeKey);
    return {
      observeStatus: (status, error) => {
        const completed = healthTracker.observe(status, error);
        if (completed) trackTeamAnalyticsEvent('collab_sync_attempt_completed', completed);
      },
      onOrgSettingsUpdated: (settings) => {
        void applyOrgSettingsBroadcast({ orgId: scope.orgId, settings });
      },
      onConversationDescriptorUpdated: (descriptor) => {
        void applyConversationDescriptorBroadcast({ orgId: scope.orgId, descriptor });
      },
      onMemberAdded: (member) => {
        void (window as any).electronAPI.org.applyMemberUpserted(
          scope.orgId,
          member.userId,
          member.email ?? null,
          member.role,
        );
      },
      onMemberRoleChanged: (userId, role) => {
        void (window as any).electronAPI.org.applyMemberRoleChanged(scope.orgId, userId, role);
      },
      onMemberRemoved: (userId) => {
        void (window as any).electronAPI.org.applyMemberRemoved(scope.orgId, userId);
      },
      onProjectAccessChanged: (projectId, userId, projectRole) => {
        void (window as any).electronAPI.org.applyProjectAccess(projectId, userId, projectRole);
      },
    };
  }

  private async ensureDataSource(): Promise<ElectronCollabDocumentsDataSource> {
    this.dataSourcePromise ??= this.resolveScope().then((scope) => {
      const source = new ElectronCollabDocumentsDataSource({
        scope,
        getJwt: () => this.getTeamJwt(scope.orgId),
        events: this.createDataSourceEvents(scope),
      });
      this.dataSource = source;
      return source;
    });
    return this.dataSourcePromise;
  }

  private createLazyDataSource(): CollabDocsDataSource {
    return {
      snapshot: async () => (await this.ensureDataSource()).snapshot(),
      subscribe: (cb) => {
        let unsubscribe: (() => void) | null = null;
        let cancelled = false;
        void this.ensureDataSource().then((source) => {
          if (!cancelled) unsubscribe = source.subscribe(cb);
        });
        return () => {
          cancelled = true;
          unsubscribe?.();
        };
      },
      command: async (command) => (await this.ensureDataSource()).command(command),
      status: () => this.dataSource?.status() ?? 'disconnected',
      dispose: () => {
        this.dataSource?.dispose();
      },
    };
  }
}
