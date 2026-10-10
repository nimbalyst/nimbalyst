import type {
  CollabScope,
  TeamMemberSummary,
} from '@nimbalyst/collab-client/core';
import type {
  CollabDocsCommand,
  CollabDocsCommandResult,
  CollabDocsDataChange,
  CollabDocsDataSource,
  CollabDocsSnapshot,
  SharedDocument,
  SharedFolder,
  SharedItemPlacement,
  SharedTypePlacement,
} from '@nimbalyst/collab-client/docs';
import {
  applyPageFieldsPatch,
  samePageFields,
  type ItemPlacementNode,
  type PageSearchRequest,
  type PageSearchResponse,
  type TypePlacementNode,
} from '@nimbalyst/collab-protocol';
import {
  TeamSyncProvider,
  type TeamDocIndexEntry,
  type FolderNode,
  type TeamMemberInfo,
  type TeamSyncConfig,
} from '@nimbalyst/runtime/sync';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { appendCollabUrlQuery, createProxiedWebSocket } from '../utils/proxiedWebSocket';
import { teamMemberDisplayName } from '../utils/teamMemberDisplayName';
import { CollabWriteConfirmations } from './collabWriteConfirmations';
import { ItemPlacementConfirmations } from './itemPlacementConfirmations';

export interface ElectronCollabDocumentsDataSourceEvents {
  observeStatus?: (status: ReturnType<TeamSyncProvider['getStatus']>, error?: unknown) => void;
  onOrgSettingsUpdated?: NonNullable<TeamSyncConfig['onOrgSettingsUpdated']>;
  onConversationDescriptorUpdated?: NonNullable<TeamSyncConfig['onConversationDescriptorUpdated']>;
  onDocumentFeedbackIndex?: NonNullable<TeamSyncConfig['onDocumentFeedbackIndex']>;
  onFeedbackIndexLoaded?: NonNullable<TeamSyncConfig['onFeedbackIndexLoaded']>;
  onFeedbackIndexChanged?: NonNullable<TeamSyncConfig['onFeedbackIndexChanged']>;
  onMemberAdded?: NonNullable<TeamSyncConfig['onMemberAdded']>;
  onMemberRemoved?: NonNullable<TeamSyncConfig['onMemberRemoved']>;
  onMemberRoleChanged?: NonNullable<TeamSyncConfig['onMemberRoleChanged']>;
  onProjectAccessChanged?: NonNullable<TeamSyncConfig['onProjectAccessChanged']>;
}

export interface ElectronCollabDocumentsDataSourceOptions {
  scope: CollabScope;
  getJwt: TeamSyncConfig['getJwt'];
  events?: ElectronCollabDocumentsDataSourceEvents;
  createProvider?: (config: TeamSyncConfig) => TeamSyncProvider;
  /** How long an item placement write waits for the server; defaults to 6s. */
  placementConfirmTimeoutMs?: number;
}

/** True when the main-process WebSocket proxy IPC is reachable. */
function hasWebSocketProxy(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.documentSync?.wsConnect;
}

function mapDocument(document: TeamDocIndexEntry): SharedDocument {
  return {
    documentId: document.documentId,
    teamProjectId: document.projectId ?? null,
    title: document.title,
    documentType: document.documentType,
    metadataVersion: document.metadataVersion,
    fileExtension: document.fileExtension,
    editorId: document.editorId,
    createdBy: document.createdBy,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    lastWriterUserId: document.lastWriterUserId,
    parentFolderId: document.parentFolderId,
    parentKind: document.parentKind ?? 'page',
    sortOrder: document.sortOrder ?? null,
    trashedAt: document.trashedAt,
    hasContent: document.hasContent,
    ...(document.fields ? { fields: document.fields } : {}),
    decryptFailed: document.decryptFailed,
  };
}

function mapFolder(folder: FolderNode): SharedFolder {
  return {
    folderId: folder.folderId,
    parentFolderId: folder.parentFolderId ?? null,
    name: folder.name,
    sortOrder: folder.sortOrder,
    createdBy: folder.createdBy,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
    decryptFailed: folder.decryptFailed,
  };
}

function mapTypePlacement(placement: TypePlacementNode): SharedTypePlacement {
  return {
    typeId: placement.typeId,
    projectId: placement.projectId,
    parentFolderId: placement.parentFolderId,
    parentKind: placement.parentKind ?? 'page',
    sortOrder: placement.sortOrder,
    createdBy: placement.createdBy,
    createdAt: placement.createdAt,
    updatedAt: placement.updatedAt,
  };
}

function mapItemPlacement(placement: ItemPlacementNode): SharedItemPlacement {
  return {
    itemId: placement.itemId,
    projectId: placement.projectId,
    parentId: placement.parentId,
    parentKind: placement.parentKind ?? 'page',
    sortOrder: placement.sortOrder,
    createdBy: placement.createdBy,
    createdAt: placement.createdAt,
    updatedAt: placement.updatedAt,
  };
}

/**
 * TeamSync's side of the author-echo contract. A server that sends the author
 * its own page moves and removals, and names the request id in a refusal,
 * says so in its team sync response; until one does (production before it),
 * a page move or delete cannot be confirmed and resolves once sent, since
 * waiting would turn every successful write into a timeout.
 */
interface AuthorEchoWrites {
  echoesAuthorWrites?(): boolean;
  moveDocument(
    documentId: string,
    newParentFolderId: string | null,
    placement?: { parentKind?: SharedDocument['parentKind']; sortOrder?: number | null; requestId?: string },
  ): void;
  removeDocument(documentId: string, options?: { requestId?: string; purge?: true }): void;
  removeFolder(folderId: string, options?: { requestId?: string }): void;
}

type AuthorEchoConfig = TeamSyncConfig & {
  onWriteRefused?: (requestId: string, error: { code: string; message: string }) => void;
};

function mapMember(member: TeamMemberInfo): TeamMemberSummary {
  return {
    memberId: asTeamMemberId(member.userId),
    email: member.email,
    name: teamMemberDisplayName(member),
    role: member.role,
  };
}

/** Electron renderer's in-process document index over TeamSyncProvider. */
export class ElectronCollabDocumentsDataSource implements CollabDocsDataSource {
  private readonly listeners = new Set<(change: CollabDocsDataChange) => void>();
  private readonly memberListeners = new Set<() => void>();
  private readonly provider: TeamSyncProvider;
  private readonly placementConfirmations: ItemPlacementConfirmations;
  /** Confirmed page moves and type placements (Set type moves a page's children). */
  private readonly documentConfirmations: CollabWriteConfirmations<TeamDocIndexEntry>;
  private readonly titleConfirmations: CollabWriteConfirmations<TeamDocIndexEntry>;
  private readonly fieldConfirmations: CollabWriteConfirmations<TeamDocIndexEntry>;
  private readonly typeConfirmations: CollabWriteConfirmations<TypePlacementNode>;
  /** Page and subtree deletes, keyed by the removed id; only when the server echoes them. */
  private readonly removalConfirmations: CollabWriteConfirmations<true>;
  private readonly observeStatus?: ElectronCollabDocumentsDataSourceEvents['observeStatus'];
  private connectPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(options: ElectronCollabDocumentsDataSourceOptions) {
    const { scope, events = {} } = options;
    const { observeStatus, ...providerEvents } = events;
    this.observeStatus = observeStatus;
    const confirmations = new ItemPlacementConfirmations(options.placementConfirmTimeoutMs);
    this.placementConfirmations = confirmations;
    const documentConfirmations = new CollabWriteConfirmations<TeamDocIndexEntry>(options.placementConfirmTimeoutMs);
    const typeConfirmations = new CollabWriteConfirmations<TypePlacementNode>(options.placementConfirmTimeoutMs, 'placement');
    const removalConfirmations = new CollabWriteConfirmations<true>(options.placementConfirmTimeoutMs, 'delete');
    this.documentConfirmations = documentConfirmations;
    const titleConfirmations = new CollabWriteConfirmations<TeamDocIndexEntry>(options.placementConfirmTimeoutMs, 'rename');
    this.titleConfirmations = titleConfirmations;
    const fieldConfirmations = new CollabWriteConfirmations<TeamDocIndexEntry>(options.placementConfirmTimeoutMs, 'field change');
    this.fieldConfirmations = fieldConfirmations;
    this.typeConfirmations = typeConfirmations;
    this.removalConfirmations = removalConfirmations;
    const emitSnapshot = () => this.emit({
      type: 'snapshot',
      snapshot: this.currentSnapshot(),
    });
    const baseConfig: AuthorEchoConfig = {
      serverUrl: scope.indexConfig.serverUrl,
      orgId: scope.orgId,
      teamProjectId: scope.indexConfig.teamProjectId,
      teamMemberId: scope.indexConfig.teamMemberId,
      getJwt: options.getJwt,
      onTeamStateLoaded: emitSnapshot,
      onDocumentsLoaded: emitSnapshot,
      onDocumentChanged: (document) => {
        documentConfirmations.changed(document.documentId, document);
        titleConfirmations.changed(document.documentId, document);
        fieldConfirmations.changed(document.documentId, document);
        // A page-tree server moves a live page to Trash instead of deleting it,
        // and the trashed row is its answer to the delete.
        if (document.trashedAt != null) removalConfirmations.changed(document.documentId, true);
        this.emit({ type: 'items-upserted', items: [mapDocument(document)] });
      },
      onDocumentRemoved: (documentId) => {
        removalConfirmations.changed(documentId, true);
        this.emit({ type: 'items-removed', itemIds: [documentId] });
      },
      onFoldersLoaded: emitSnapshot,
      onFolderChanged: (folder) => this.emit({
        type: 'containers-upserted',
        containers: [mapFolder(folder)],
      }),
      onFoldersRemoved: (folderIds, documentIds) => {
        // A page-tree subtree delete names its root among the documents; an
        // already-gone root, or a legacy folder, among the folders.
        for (const id of [...folderIds, ...documentIds]) removalConfirmations.changed(id, true);
        this.emit({ type: 'containers-removed', containerIds: folderIds, itemIds: documentIds });
      },
      onWriteRefused: (requestId, error) => {
        documentConfirmations.refused(requestId, error.message);
        titleConfirmations.refused(requestId, error.message);
        fieldConfirmations.refused(requestId, error.message);
        removalConfirmations.refused(requestId, error.message);
      },
      // Placement changes ride the snapshot change; see CollabDocsSnapshot.
      onTypePlacementsLoaded: (placements) => {
        typeConfirmations.loaded(new Map(placements.map((placement) => [placement.typeId, placement])));
        emitSnapshot();
      },
      onTypePlacementChanged: (placement) => {
        typeConfirmations.changed(placement.typeId, placement);
        emitSnapshot();
      },
      onTypePlacementsRemoved: emitSnapshot,
      // Each also settles the author's pending write; see itemPlacementConfirmations.
      onItemPlacementsLoaded: (placements) => {
        confirmations.placementsLoaded(placements);
        emitSnapshot();
      },
      onItemPlacementChanged: (placement) => {
        confirmations.placementChanged(placement);
        emitSnapshot();
      },
      onItemPlacementsRemoved: (itemIds) => {
        confirmations.placementsRemoved(itemIds);
        emitSnapshot();
      },
      onStatusChange: (status) => {
        confirmations.connectionChanged(status === 'connected');
        documentConfirmations.connectionChanged(status === 'connected');
        titleConfirmations.connectionChanged(status === 'connected');
        fieldConfirmations.connectionChanged(status === 'connected');
        typeConfirmations.connectionChanged(status === 'connected');
        removalConfirmations.connectionChanged(status === 'connected');
        this.emit({ type: 'status', status });
        observeStatus?.(status);
      },
      // The team socket must go through the main process like every other
      // desktop collab socket. A browser WebSocket sends an Origin header the
      // sync server rejects for non-allowlisted origins (the dev renderer's
      // http://localhost:5273), which surfaces as an opaque 1006 close.
      ...(hasWebSocketProxy()
        ? {
            createWebSocket: (url: string) => createProxiedWebSocket(
              appendCollabUrlQuery(url, scope.indexConfig.urlExtraQuery),
            ),
          }
        : {}),
      ...providerEvents,
    };
    // The member directory is only populated once the team room replies, and
    // then mutates for the rest of the session. Wrap the four callbacks that
    // move it AFTER the `providerEvents` spread, so a host's own handlers
    // (which the spread installs) still run alongside the notification.
    const alsoNotifyMembers = <TArgs extends unknown[]>(
      handler: ((...args: TArgs) => void) | undefined,
    ) => (...args: TArgs) => {
      handler?.(...args);
      for (const listener of this.memberListeners) listener();
    };
    const config: TeamSyncConfig = {
      ...baseConfig,
      onTeamStateLoaded: alsoNotifyMembers(baseConfig.onTeamStateLoaded),
      onMemberAdded: alsoNotifyMembers(baseConfig.onMemberAdded),
      onMemberRemoved: alsoNotifyMembers(baseConfig.onMemberRemoved),
      onMemberRoleChanged: alsoNotifyMembers(baseConfig.onMemberRoleChanged),
    };
    this.provider = (options.createProvider ?? ((providerConfig) => (
      new TeamSyncProvider(providerConfig)
    )))(config);
  }

  async snapshot(): Promise<CollabDocsSnapshot> {
    await this.ensureConnected();
    return this.currentSnapshot();
  }

  subscribe(cb: (change: CollabDocsDataChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  status() {
    return this.provider.getStatus();
  }

  /**
   * Connect first: team state (and with it the member directory) is null until
   * the room replies, so reading the snapshot without connecting returns an
   * empty directory that never fills in. Pair with `onMembersChanged` — the
   * connect resolves as soon as the socket exists, not when the reply lands.
   */
  async getMembers(): Promise<TeamMemberSummary[]> {
    await this.ensureConnected();
    return (this.provider.getTeamState()?.members ?? []).map(mapMember);
  }

  onMembersChanged(cb: () => void): () => void {
    this.memberListeners.add(cb);
    return () => { this.memberListeners.delete(cb); };
  }

  /** Compatibility seam for editor/comment providers until step 4 moves UI. */
  /** Body search over the server's index for this scope's project. */
  searchPages(request: PageSearchRequest): Promise<PageSearchResponse | null> {
    return this.provider.searchPages(request);
  }

  getProvider(): TeamSyncProvider {
    return this.provider;
  }

  async command(command: CollabDocsCommand): Promise<CollabDocsCommandResult> {
    await this.ensureConnected();
    switch (command.type) {
      case 'register-document': {
        const registrationAcked = await this.provider.registerDocument(
          command.documentId,
          command.title,
          command.documentType,
          command.parentFolderId,
          command.metadata,
          undefined,
          {
            ...(command.parentKind ? { parentKind: command.parentKind } : {}),
            ...(command.sortOrder !== undefined ? { sortOrder: command.sortOrder } : {}),
          },
        );
        return { ok: true, registrationAcked };
      }
      case 'update-document-title': {
        if (!this.provider.echoesTitleWrites?.()) throw new Error('This server cannot confirm page renames yet. Try again after the server is updated.');
        const requestId = crypto.randomUUID();
        const confirmed = this.titleConfirmations.expect(command.documentId, (row) => row.title === command.title, requestId);
        await Promise.all([this.provider.updateDocumentTitle(command.documentId, command.title, { requestId }), confirmed]);
        return { ok: true };
      }
      case 'set-document-fields': {
        if (!this.provider.storesPageFields?.()) throw new Error('This server cannot store page fields yet. Try again after the server is updated.');
        const requestId = crypto.randomUUID();
        // The echo holds the patch when applying it again changes nothing; a
        // teammate's change to another field meanwhile does not matter.
        const confirmed = this.fieldConfirmations.expect(command.documentId, (row) =>
          samePageFields(applyPageFieldsPatch(row.fields, command.fields), row.fields), requestId);
        this.provider.setDocumentFields(command.documentId, command.fields, { requestId });
        await confirmed;
        return { ok: true };
      }
      case 'remove-document': {
        const requestId = this.authorEchoRequestId();
        const confirmed = requestId ? this.removalConfirmations.expect(command.documentId, () => true, requestId) : null;
        const options = { ...(requestId ? { requestId } : {}), ...(command.purge ? { purge: true as const } : {}) };
        this.writes().removeDocument(command.documentId, ...(Object.keys(options).length > 0 ? [options] : []));
        await confirmed;
        return { ok: true };
      }
      case 'trash-document':
        this.provider.trashDocument(command.documentId, command.trashedAt);
        return { ok: true };
      case 'restore-document':
        this.provider.restoreDocument(command.documentId);
        return { ok: true };
      case 'move-document': {
        const parentKind = command.parentFolderId ? command.parentKind ?? 'page' : 'page';
        const requestId = command.confirm ? this.authorEchoRequestId() : null;
        const confirmed = requestId
          ? this.documentConfirmations.expect(command.documentId, (row) =>
            (row.parentFolderId ?? null) === command.parentFolderId && (row.parentKind ?? 'page') === parentKind, requestId)
          : null;
        this.writes().moveDocument(command.documentId, command.parentFolderId, {
          ...(command.parentKind ? { parentKind: command.parentKind } : {}),
          ...(command.sortOrder !== undefined ? { sortOrder: command.sortOrder } : {}),
          ...(requestId ? { requestId } : {}),
        });
        await confirmed;
        return { ok: true };
      }
      case 'register-folder':
        await this.provider.registerFolder(
          command.folderId,
          command.name,
          command.parentFolderId,
          command.sortOrder,
        );
        return { ok: true };
      case 'rename-folder':
        await this.provider.renameFolder(command.folderId, command.name);
        return { ok: true };
      case 'move-folder':
        this.provider.moveFolder(command.folderId, command.parentFolderId);
        return { ok: true };
      case 'remove-folder': {
        const requestId = this.authorEchoRequestId();
        const confirmed = requestId ? this.removalConfirmations.expect(command.folderId, () => true, requestId) : null;
        this.writes().removeFolder(command.folderId, ...(requestId ? [{ requestId }] : []));
        await confirmed;
        return { ok: true };
      }
      case 'refresh-folders':
        return { ok: true, folders: (await this.provider.refreshFolders())?.map(mapFolder) ?? null };
      case 'set-type-placement': {
        const parentKind = command.parentFolderId ? command.parentKind ?? 'page' : 'page';
        const confirmed = command.confirm
          ? this.typeConfirmations.expect(command.typeId, (row) =>
            (row.parentFolderId ?? null) === command.parentFolderId && (row.parentKind ?? 'page') === parentKind)
          : null;
        this.provider.setTypePlacement(command.typeId, command.parentFolderId, command.sortOrder, command.parentKind);
        await confirmed;
        return { ok: true };
      }
      case 'remove-type-placement':
        this.provider.removeTypePlacement(command.typeId);
        return { ok: true };
      case 'refresh-type-placements':
        return {
          ok: true,
          typePlacements: (await this.provider.refreshTypePlacements())?.map(mapTypePlacement) ?? null,
        };
      // Resolve only once the server confirmed; reject on a refusal or timeout.
      case 'set-item-placement': {
        const confirmed = this.placementConfirmations.expect(command.itemId, { parentId: command.parentId });
        this.provider.setItemPlacement(command.itemId, command.parentId, command.sortOrder, command.parentKind);
        await confirmed;
        return { ok: true };
      }
      case 'remove-item-placement': {
        const confirmed = this.placementConfirmations.expect(command.itemId, null);
        this.provider.removeItemPlacement(command.itemId);
        await confirmed;
        return { ok: true };
      }
      case 'refresh-item-placements':
        return {
          ok: true,
          itemPlacements: (await this.provider.refreshItemPlacements())?.map(mapItemPlacement) ?? null,
        };
      case 'reconnect':
        this.provider.reconnectNow();
        return { ok: true };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.placementConfirmations.dispose();
    this.documentConfirmations.dispose();
    this.titleConfirmations.dispose();
    this.fieldConfirmations.dispose();
    this.typeConfirmations.dispose();
    this.removalConfirmations.dispose();
    this.provider.destroy();
  }

  private writes(): AuthorEchoWrites {
    return this.provider;
  }

  /** A request id to wait on, or null when the server will not echo the author's page writes. */
  private authorEchoRequestId(): string | null {
    return this.writes().echoesAuthorWrites?.() === true ? crypto.randomUUID() : null;
  }

  private currentSnapshot(): CollabDocsSnapshot {
    // Omitted until the server has sent a list, so the session keeps its own.
    const typePlacements = this.provider.getTypePlacements();
    const itemPlacements = this.provider.getItemPlacements();
    // Known once the team room answered; the session splits other projects off by it.
    const metadata = this.provider.getTeamState()?.metadata;
    return {
      items: this.provider.getDocuments().map(mapDocument),
      containers: this.provider.getFolders().map(mapFolder),
      ...(typePlacements ? { typePlacements: typePlacements.map(mapTypePlacement) } : {}),
      ...(itemPlacements ? { itemPlacements: itemPlacements.map(mapItemPlacement) } : {}),
      // The server's snapshot flag: its folders are now pages.
      ...(this.provider.isPageTree() ? { pageTree: true } : {}),
      // The server's snapshot flag: it stores plain-page fields.
      ...(this.provider.storesPageFields?.() ? { pageFields: true } : {}),
      ...(metadata ? { primaryProjectId: metadata.teamProjectId ?? null } : {}),
    };
  }

  private emit(change: CollabDocsDataChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private ensureConnected(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Data source has been disposed'));
    this.connectPromise ??= this.provider.connect().catch((error) => {
      this.connectPromise = null;
      this.observeStatus?.('error', error);
      throw error;
    });
    return this.connectPromise;
  }
}
