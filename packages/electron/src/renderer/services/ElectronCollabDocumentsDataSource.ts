import type {
  CollabDataChange,
  CollabDataSnapshot,
  CollabScope,
  TeamMemberSummary,
} from '@nimbalyst/collab-client/core';
import type {
  CollabDocsCommand,
  CollabDocsCommandResult,
  CollabDocsDataSource,
  SharedDocument,
  SharedFolder,
} from '@nimbalyst/collab-client/docs';
import {
  TeamSyncProvider,
  type TeamDocIndexEntry,
  type FolderNode,
  type TeamMemberInfo,
  type TeamSyncConfig,
} from '@nimbalyst/runtime/sync';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { createProxiedWebSocket } from '../utils/proxiedWebSocket';

export interface ElectronCollabDocumentsDataSourceEvents {
  observeStatus?: (status: ReturnType<TeamSyncProvider['getStatus']>, error?: unknown) => void;
  onOrgSettingsUpdated?: NonNullable<TeamSyncConfig['onOrgSettingsUpdated']>;
  onConversationDescriptorUpdated?: NonNullable<TeamSyncConfig['onConversationDescriptorUpdated']>;
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
    trashedAt: document.trashedAt,
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

function mapMember(member: TeamMemberInfo): TeamMemberSummary {
  return {
    memberId: asTeamMemberId(member.userId),
    email: member.email,
    role: member.role,
  };
}

/** Electron renderer's in-process document index over TeamSyncProvider. */
export class ElectronCollabDocumentsDataSource implements CollabDocsDataSource {
  private readonly listeners = new Set<(
    change: CollabDataChange<SharedDocument, SharedFolder>,
  ) => void>();
  private readonly provider: TeamSyncProvider;
  private readonly observeStatus?: ElectronCollabDocumentsDataSourceEvents['observeStatus'];
  private connectPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(options: ElectronCollabDocumentsDataSourceOptions) {
    const { scope, events = {} } = options;
    const { observeStatus, ...providerEvents } = events;
    this.observeStatus = observeStatus;
    const emitSnapshot = () => this.emit({
      type: 'snapshot',
      snapshot: this.currentSnapshot(),
    });
    const config: TeamSyncConfig = {
      serverUrl: scope.indexConfig.serverUrl,
      orgId: scope.orgId,
      teamProjectId: scope.indexConfig.teamProjectId,
      userId: scope.indexConfig.userId,
      getJwt: options.getJwt,
      onTeamStateLoaded: emitSnapshot,
      onDocumentsLoaded: emitSnapshot,
      onDocumentChanged: (document) => this.emit({
        type: 'items-upserted',
        items: [mapDocument(document)],
      }),
      onDocumentRemoved: (documentId) => this.emit({
        type: 'items-removed',
        itemIds: [documentId],
      }),
      onFoldersLoaded: emitSnapshot,
      onFolderChanged: (folder) => this.emit({
        type: 'containers-upserted',
        containers: [mapFolder(folder)],
      }),
      onFoldersRemoved: (folderIds, documentIds) => this.emit({
        type: 'containers-removed',
        containerIds: folderIds,
        itemIds: documentIds,
      }),
      onStatusChange: (status) => {
        this.emit({ type: 'status', status });
        observeStatus?.(status);
      },
      // The team socket must go through the main process like every other
      // desktop collab socket. A browser WebSocket sends an Origin header the
      // sync server rejects for non-allowlisted origins (the dev renderer's
      // http://localhost:5273), which surfaces as an opaque 1006 close.
      ...(hasWebSocketProxy() ? { createWebSocket: createProxiedWebSocket } : {}),
      ...providerEvents,
    };
    this.provider = (options.createProvider ?? ((providerConfig) => (
      new TeamSyncProvider(providerConfig)
    )))(config);
  }

  async snapshot(): Promise<CollabDataSnapshot<SharedDocument, SharedFolder>> {
    await this.ensureConnected();
    return this.currentSnapshot();
  }

  subscribe(
    cb: (change: CollabDataChange<SharedDocument, SharedFolder>) => void,
  ): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  status() {
    return this.provider.getStatus();
  }

  getMembers(): TeamMemberSummary[] {
    return (this.provider.getTeamState()?.members ?? []).map(mapMember);
  }

  /** Compatibility seam for editor/comment providers until step 4 moves UI. */
  getProvider(): TeamSyncProvider {
    return this.provider;
  }

  async command(command: CollabDocsCommand): Promise<CollabDocsCommandResult> {
    await this.ensureConnected();
    switch (command.type) {
      case 'register-document':
        await this.provider.registerDocument(
          command.documentId,
          command.title,
          command.documentType,
          command.parentFolderId,
          command.metadata,
        );
        return { ok: true };
      case 'update-document-title':
        await this.provider.updateDocumentTitle(command.documentId, command.title);
        return { ok: true };
      case 'remove-document':
        this.provider.removeDocument(command.documentId);
        return { ok: true };
      case 'trash-document':
        this.provider.trashDocument(command.documentId, command.trashedAt);
        return { ok: true };
      case 'restore-document':
        this.provider.restoreDocument(command.documentId);
        return { ok: true };
      case 'move-document':
        this.provider.moveDocument(command.documentId, command.parentFolderId);
        return { ok: true };
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
      case 'remove-folder':
        this.provider.removeFolder(command.folderId);
        return { ok: true };
      case 'refresh-folders':
        return { ok: true, folders: (await this.provider.refreshFolders())?.map(mapFolder) ?? null };
      case 'reconnect':
        this.provider.reconnectNow();
        return { ok: true };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.provider.destroy();
  }

  private currentSnapshot(): CollabDataSnapshot<SharedDocument, SharedFolder> {
    return {
      items: this.provider.getDocuments().map(mapDocument),
      containers: this.provider.getFolders().map(mapFolder),
    };
  }

  private emit(change: CollabDataChange<SharedDocument, SharedFolder>): void {
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
