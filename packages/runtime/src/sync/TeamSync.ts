/**
 * TeamSyncProvider
 *
 * Client-side team state sync over WebSocket.
 * Connects to a TeamRoom Durable Object, receives team state (members, roles,
 * key envelopes) and document index updates in realtime.
 *
 * The provider:
 * - Requests full team state on connect (teamSync)
 * - Decrypts document titles from the team's document index (AES-256-GCM)
 * - Delivers member changes, key envelope notifications, and doc index updates via callbacks
 * - Handles doc index mutations (register, update, remove) with encryption
 */

import type {
  TeamSyncConfig,
  TeamSyncStatus,
  TeamState,
  DocIndexEntry,
  TeamClientMessage,
  TeamServerMessage,
  TeamSyncResponseMessage,
  TeamMemberAddedMessage,
  TeamMemberRemovedMessage,
  TeamMemberRoleChangedMessage,
  TeamDocIndexSyncResponseMessage,
  TeamDocIndexBroadcastMessage,
  TeamDocIndexRemoveBroadcastMessage,
  TeamFolderIndexSyncResponseMessage,
  TeamFolderBroadcastMessage,
  TeamFolderRemoveBroadcastMessage,
  TeamProjectAccessChangedMessage,
  EncryptedDocIndexEntry,
  EncryptedFolderNode,
  FolderNode,
  ServerTeamState,
  SharedDocumentTypeMetadataV2,
} from './teamSyncTypes';
import type { BoundedPreview } from '@nimbalyst/collab-protocol';
import { appendSyncClientParams } from './syncClientInfo';

// ============================================================================
// TeamSyncProvider
// ============================================================================

/** Reconnect constants */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class TeamSyncProvider {
  private config: TeamSyncConfig;
  private ws: WebSocket | null = null;
  private status: TeamSyncStatus = 'disconnected';
  private destroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Local cache of team state */
  private teamState: TeamState | null = null;

  /** Local cache of decrypted doc index entries */
  private localEntries: Map<string, DocIndexEntry> = new Map();

  /** Local cache of decrypted folder nodes (first-class folders) */
  private folderEntries: Map<string, FolderNode> = new Map();

  /**
   * NIM-910: resolvers waiting for the next team/doc-index snapshot, used to
   * verify a backfill actually persisted server-side. Resolved with the RAW
   * (still-encrypted) server entries so the caller can inspect `titleIv`.
   */
  private resyncWaiters: Array<(docs: EncryptedDocIndexEntry[]) => void> = [];

  /** Resolvers waiting for the next decrypted folder-index snapshot. */
  private folderResyncWaiters: Array<(folders: FolderNode[] | null) => void> = [];

  /**
   * Resolvers waiting for a `docIndexRegistered` ack, keyed by document id.
   *
   * A document's room 404s until its index row exists, so anything that writes
   * into a freshly created document has to know when registration landed
   * (NIM-2472). The index broadcast excludes the registering socket, so this
   * ack is the only signal available to its author.
   */
  private registerAckWaiters = new Map<string, Array<(acked: boolean) => void>>();

  /**
   * Messages queued while disconnected. Unlike DocumentSync (which queues CRDT
   * updates), TeamSync was silently dropping doc index mutations when offline;
   * this queue carries index mutations and document-comment notifications
   * across a reconnect. Both are idempotent server-side.
   */
  private pendingOfflineMessages: TeamClientMessage[] = [];

  constructor(config: TeamSyncConfig) {
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // Connection Lifecycle
  // --------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.destroyed) throw new Error('Provider has been destroyed');
    if (this.ws) return;

    this.setStatus('connecting');

    const { serverUrl, orgId } = this.config;
    const roomId = `org:${orgId}:team`;

    let url: string;
    if (this.config.buildUrl) {
      url = this.config.buildUrl(roomId);
    } else {
      const jwt = await this.config.getJwt();
      url = appendSyncClientParams(`${serverUrl}/sync/${roomId}?token=${encodeURIComponent(jwt)}`);
    }

    const ws = this.config.createWebSocket
      ? this.config.createWebSocket(url)
      : new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      // console.log('[TeamSync] WebSocket connected, requesting team state...');
      this.reconnectAttempt = 0;
      this.setStatus('syncing');
      this.send({ type: 'teamSync' });
    });

    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      this.handleMessage(event);
    });

    ws.addEventListener('close', (event) => {
      // Stale close from a socket we already replaced (e.g. via reconnectNow)
      // must not call handleDisconnect() -- that would null out `this.ws` and
      // clobber the new socket.
      if (this.ws !== ws) return;
      console.log('[TeamSync] WebSocket closed:', event.code, event.reason);
      this.handleDisconnect();
    });

    ws.addEventListener('error', (event) => {
      if (this.ws !== ws) return;
      console.error('[TeamSync] WebSocket error:', event);
      this.handleDisconnect();
    });
  }

  disconnect(): void {
    this.cancelReconnect();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.teamState = null;
    this.localEntries.clear();
    this.pendingOfflineMessages = [];
    const folderWaiters = this.folderResyncWaiters;
    this.folderResyncWaiters = [];
    for (const waiter of folderWaiters) waiter(null);
    const registerWaiters = [...this.registerAckWaiters.values()].flat();
    this.registerAckWaiters.clear();
    // Unconfirmed, not confirmed-failed: a destroyed provider says nothing
    // about whether the row landed.
    for (const waiter of registerWaiters) waiter(false);
  }

  getStatus(): TeamSyncStatus {
    return this.status;
  }

  /** Get the cached team state (or null if not yet synced). */
  getTeamState(): TeamState | null {
    return this.teamState;
  }

  /** Get the cached document list. */
  getDocuments(): DocIndexEntry[] {
    return Array.from(this.localEntries.values());
  }

  // --------------------------------------------------------------------------
  // Public API: Document Index
  // --------------------------------------------------------------------------

  /**
   * Build the wire title fields: the plaintext title with the empty-string iv
   * sentinel. The server encrypts it at rest with the team DEK.
   */
  private async encodeTitleForWire(title: string): Promise<{ encryptedTitle: string; titleIv: string }> {
    return { encryptedTitle: title, titleIv: '' };
  }

  /**
   * Register a document in the org's index.
   *
   * Resolves `true` once the server confirms the row is committed. Callers that
   * are about to write into the document's room MUST await this: `DocumentRoom`
   * binds the id through `document_index` and 404s until the row exists
   * (NIM-2472).
   *
   * Resolves `false` — without throwing — when no ack arrives before
   * `ackTimeoutMs`. That happens against a server predating the ack, and when
   * the message was queued offline. The registration itself is unaffected
   * (the mutation is idempotent and the offline queue still carries it); the
   * caller decides whether to proceed optimistically.
   */
  async registerDocument(
    documentId: string,
    title: string,
    documentType: string,
    parentFolderId: string | null = null,
    metadata?: SharedDocumentTypeMetadataV2,
    ackTimeoutMs = 6000,
  ): Promise<boolean> {
    const { encryptedTitle, titleIv } = await this.encodeTitleForWire(title);
    // Register the waiter BEFORE sending: the ack can land in the same tick the
    // socket flushes, and a waiter added afterwards would miss it.
    const acked = this.waitForRegisterAck(documentId, ackTimeoutMs);
    this.send({
      type: 'docIndexRegister', documentId, encryptedTitle, titleIv, documentType,
      ...metadata,
      // Epic H3 P0/A: attribute the doc to the active project so the server's
      // project-partitioned doc index (and a future move) can scope it.
      projectId: this.config.teamProjectId ?? null,
      parentFolderId,
    });
    return acked;
  }

  private waitForRegisterAck(documentId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (acked: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.registerAckWaiters.get(documentId);
        if (waiters) {
          const remaining = waiters.filter((waiting) => waiting !== waiter);
          if (remaining.length > 0) this.registerAckWaiters.set(documentId, remaining);
          else this.registerAckWaiters.delete(documentId);
        }
        resolve(acked);
      };
      const waiter = (acked: boolean) => done(acked);
      const timer = setTimeout(() => done(false), timeoutMs);
      const existing = this.registerAckWaiters.get(documentId);
      if (existing) existing.push(waiter);
      else this.registerAckWaiters.set(documentId, [waiter]);
    });
  }

  private resolveRegisterAck(documentId: string, acked: boolean): void {
    const waiters = this.registerAckWaiters.get(documentId);
    if (!waiters) return;
    this.registerAckWaiters.delete(documentId);
    for (const waiter of waiters) waiter(acked);
  }

  async updateDocumentTitle(documentId: string, newTitle: string): Promise<void> {
    const { encryptedTitle, titleIv } = await this.encodeTitleForWire(newTitle);
    this.send({
      type: 'docIndexUpdate', documentId, encryptedTitle, titleIv,
    });
  }

  removeDocument(documentId: string): void {
    this.localEntries.delete(documentId);
    this.send({
      type: 'docIndexRemove', documentId,
    });
  }

  /** Move a document into recoverable Trash without changing its folder. */
  trashDocument(documentId: string, trashedAt = Date.now()): void {
    const existing = this.localEntries.get(documentId);
    if (existing) {
      this.localEntries.set(documentId, { ...existing, trashedAt });
    }
    this.send({
      type: 'docTrash', documentId, trashedAt,
    });
  }

  /** Restore a document to the same folder it occupied before Trash. */
  restoreDocument(documentId: string): void {
    const existing = this.localEntries.get(documentId);
    if (existing) {
      this.localEntries.set(documentId, { ...existing, trashedAt: null });
    }
    this.send({
      type: 'docRestore', documentId,
    });
  }

  /** Reparent a document into a folder (null = root). Content untouched. */
  moveDocument(documentId: string, newParentFolderId: string | null): void {
    const existing = this.localEntries.get(documentId);
    if (existing) {
      this.localEntries.set(documentId, { ...existing, parentFolderId: newParentFolderId });
    }
    this.send({
      type: 'docMove', documentId, newParentFolderId,
    });
  }

  // --------------------------------------------------------------------------
  // Public API: Document comment notifications
  // --------------------------------------------------------------------------

  /**
   * Announce that a document comment mentioned members or replied to one.
   *
   * Document comments live in the document's Y.Doc, so no server-side event
   * exists to fan out from — this is the only producer for the org-scoped
   * inbox lane. Fire-and-forget: the server re-derives the author and every
   * recipient's capability, and delivery is idempotent per comment, so a
   * caller never has to reconcile a failure. Recipients must exclude the
   * author; the server drops it anyway.
   */
  notifyDocumentComment(input: {
    documentId: string;
    commentId: string;
    threadId?: string;
    reason: 'mention' | 'reply';
    recipientUserIds: string[];
    preview?: BoundedPreview;
  }): void {
    if (input.recipientUserIds.length === 0) return;
    this.send({
      type: 'documentCommentNotify',
      documentId: input.documentId,
      commentId: input.commentId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      reason: input.reason,
      recipientUserIds: input.recipientUserIds,
      ...(input.preview ? { preview: input.preview } : {}),
    });
  }

  // --------------------------------------------------------------------------
  // Public API: First-class folders
  // --------------------------------------------------------------------------

  /** Register (or upsert) a folder node. `parentFolderId` null = root level. */
  async registerFolder(
    folderId: string, name: string, parentFolderId: string | null, sortOrder = 0,
  ): Promise<void> {
    const { encryptedTitle: encryptedName, titleIv: nameIv } = await this.encodeTitleForWire(name);
    this.send({
      type: 'folderRegister', folderId, parentFolderId, encryptedName, nameIv, sortOrder,
      projectId: this.config.teamProjectId ?? null,
    });
  }

  /** Rename a folder in place (single-row update of the encrypted name). */
  async renameFolder(folderId: string, newName: string): Promise<void> {
    const { encryptedTitle: encryptedName, titleIv: nameIv } = await this.encodeTitleForWire(newName);
    this.send({
      type: 'folderRename', folderId, encryptedName, nameIv,
    });
  }

  /** Move a folder to a new parent (null = root). Server rejects cycles. */
  moveFolder(folderId: string, newParentFolderId: string | null, sortOrder?: number): void {
    this.send({
      type: 'folderMove', folderId, newParentFolderId, sortOrder,
    });
  }

  /** Delete a folder recursively (folder + descendants + their documents). */
  removeFolder(folderId: string): void {
    this.folderEntries.delete(folderId);
    this.send({
      type: 'folderRemove', folderId,
    });
  }

  /** Snapshot of the current decrypted folder nodes. */
  getFolders(): FolderNode[] {
    return Array.from(this.folderEntries.values());
  }

  /**
   * Request the current first-class folder index from TeamRoom. The promise
   * resolves only after the matching server snapshot has been decrypted and
   * applied locally; null means the request timed out.
   */
  refreshFolders(timeoutMs = 6000): Promise<FolderNode[] | null> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (folders: FolderNode[] | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.folderResyncWaiters = this.folderResyncWaiters.filter(waiting => waiting !== waiter);
        resolve(folders);
      };
      const waiter = (folders: FolderNode[] | null) => done(folders);
      this.folderResyncWaiters.push(waiter);
      timer = setTimeout(() => done(null), timeoutMs);
      this.send({ type: 'folderIndexSync' });
    });
  }

  // --------------------------------------------------------------------------
  // Message Handling
  // --------------------------------------------------------------------------

  private async handleMessage(event: MessageEvent): Promise<void> {
    try {
      const message: TeamServerMessage = JSON.parse(String(event.data));

      switch (message.type) {
        case 'teamSyncResponse':
          await this.handleTeamSyncResponse(message);
          break;
        case 'orgSettingsUpdated':
          this.config.onOrgSettingsUpdated?.(message.settings);
          break;
        case 'conversationDescriptorUpdated':
          this.config.onConversationDescriptorUpdated?.(message.descriptor);
          break;
        case 'memberAdded':
          this.handleMemberAdded(message);
          break;
        case 'memberRemoved':
          this.handleMemberRemoved(message);
          break;
        case 'memberRoleChanged':
          this.handleMemberRoleChanged(message);
          break;
        case 'docIndexSyncResponse':
          await this.handleDocIndexSyncResponse(message);
          break;
        case 'docIndexRegistered':
          this.resolveRegisterAck(message.documentId, true);
          break;
        case 'docIndexBroadcast':
          await this.handleDocIndexBroadcast(message);
          break;
        case 'docIndexRemoveBroadcast':
          this.handleDocIndexRemoveBroadcast(message);
          break;
        case 'folderIndexSyncResponse':
          await this.handleFolderIndexSyncResponse(message);
          break;
        case 'folderBroadcast':
          await this.handleFolderBroadcast(message);
          break;
        case 'folderRemoveBroadcast':
          this.handleFolderRemoveBroadcast(message);
          break;
        case 'projectAccessChanged':
          this.handleProjectAccessChanged(message);
          break;
        case 'documentCommentNotifyAck':
          // Fire-and-forget: nothing in the client waits on this. Surfacing a
          // fully-suppressed fanout keeps a silently-dropped mention debuggable.
          if (message.deliveredUserIds.length === 0
            && message.suppressedUserIds.length > 0) {
            console.warn(
              '[TeamSync] Document comment notification fully suppressed',
              message.documentId,
              message.commentId,
            );
          }
          break;
        case 'error':
          console.error('[TeamSync] Server error:', message.code, message.message);
          break;
      }
    } catch (err) {
      console.error('[TeamSync] Error handling message:', err);
    }
  }

  private async handleTeamSyncResponse(msg: TeamSyncResponseMessage): Promise<void> {
    const server: ServerTeamState = msg.team;

    // Decrypt document titles. NIM-910: in server-managed mode this teamSync
    // path returns titles RAW (DEK-ciphertext the client cannot read); the
    // immediately-following docIndexSync is authoritative. Suppress the
    // per-entry locked-title warnings here so they don't spam the log on every
    // reconnect -- docIndexSync logs loudly for any genuinely-locked title.
    const documents = await this.decryptDocuments(server.documents, {
      quietLockedWarnings: true,
    });
    // First-class folders. Absent when talking to a pre-folders server.
    const folders = await this.decryptFolders(server.folders ?? []);

    this.teamState = {
      metadata: server.metadata,
      members: server.members,
      documents,
      folders,
    };

    // Update local doc entries cache
    this.localEntries.clear();
    for (const doc of documents) {
      this.localEntries.set(doc.documentId, doc);
    }
    // Update local folder cache
    this.folderEntries.clear();
    for (const f of folders) {
      this.folderEntries.set(f.folderId, f);
    }

    this.setStatus('connected');
    // console.log('[TeamSync] Team state loaded:', server.members.length, 'members,', documents.length, 'documents');

    this.config.onTeamStateLoaded?.(this.teamState);
    // Omitted by pre-settings servers; a snapshot that carries them is as
    // authoritative as a broadcast, so a client that connects after a change
    // still sees it.
    if (server.settings) {
      this.config.onOrgSettingsUpdated?.(server.settings);
    }
    if (documents.length > 0) {
      this.config.onDocumentsLoaded?.(documents);
    }
    if (folders.length > 0) {
      this.config.onFoldersLoaded?.(folders);
    }

    // Replay index mutations / comment notifications queued while disconnected
    this.replayPendingOfflineMessages();

    // NIM-910: `teamSync` returns doc-index titles RAW (the server does not
    // decrypt DEK rows on that path), so server-managed plaintext titles arrive
    // as undecryptable ciphertext and render as locked. Immediately request the
    // decrypting `docIndexSync` path, whose response is authoritative for the
    // document list and overwrites the raw one. Folder names have the same
    // server-managed raw-vs-decrypted split, so request the decrypting
    // `folderIndexSync` path too.
    this.send({ type: 'docIndexSync' });
    this.send({ type: 'folderIndexSync' });

  }

  /** Resolve any pending backfill-verification waiters with raw server entries. */
  private notifyResyncWaiters(documents: EncryptedDocIndexEntry[]): void {
    if (this.resyncWaiters.length === 0) return;
    const waiters = this.resyncWaiters;
    this.resyncWaiters = [];
    for (const w of waiters) {
      try { w(documents); } catch { /* waiter cleanup is best-effort */ }
    }
  }

  private handleMemberAdded(msg: TeamMemberAddedMessage): void {
    if (this.teamState) {
      this.teamState.members = this.teamState.members.filter(m => m.userId !== msg.member.userId);
      this.teamState.members.push(msg.member);
    }
    this.config.onMemberAdded?.(msg.member);
  }

  private handleMemberRemoved(msg: TeamMemberRemovedMessage): void {
    if (this.teamState) {
      this.teamState.members = this.teamState.members.filter(m => m.userId !== msg.userId);
    }
    this.config.onMemberRemoved?.(msg.userId);
  }

  private handleMemberRoleChanged(msg: TeamMemberRoleChangedMessage): void {
    if (this.teamState) {
      const member = this.teamState.members.find(m => m.userId === msg.userId);
      if (member) member.role = msg.role;
    }
    this.config.onMemberRoleChanged?.(msg.userId, msg.role);
  }

  private async handleDocIndexSyncResponse(msg: TeamDocIndexSyncResponseMessage): Promise<void> {
    this.notifyResyncWaiters(msg.documents);
    const documents = await this.decryptDocuments(msg.documents);
    this.localEntries.clear();
    for (const doc of documents) {
      this.localEntries.set(doc.documentId, doc);
    }
    if (this.teamState) {
      this.teamState.documents = documents;
    }
    this.config.onDocumentsLoaded?.(documents);

  }

  private async handleDocIndexBroadcast(msg: TeamDocIndexBroadcastMessage): Promise<void> {
    let entry: DocIndexEntry;
    try {
      entry = await this.decryptEntry(msg.document);
    } catch (err) {
      console.warn(
        '[TeamSync] Title decrypt failed on broadcast; surfacing as locked entry:',
        msg.document.documentId,
        err,
      );
      entry = {
        documentId: msg.document.documentId,
        projectId: msg.document.projectId ?? null,
        title: '',
        documentType: msg.document.documentType,
        metadataVersion: msg.document.metadataVersion,
        fileExtension: msg.document.fileExtension,
        editorId: msg.document.editorId,
        createdBy: msg.document.createdBy,
        createdAt: msg.document.createdAt,
        updatedAt: msg.document.updatedAt,
        lastWriterUserId: msg.document.lastWriterUserId ?? null,
        parentFolderId: msg.document.parentFolderId ?? null,
        trashedAt: msg.document.trashedAt ?? null,
        decryptFailed: true,
      };
    }
    this.localEntries.set(entry.documentId, entry);
    if (this.teamState) {
      const idx = this.teamState.documents.findIndex(d => d.documentId === entry.documentId);
      if (idx >= 0) {
        this.teamState.documents[idx] = entry;
      } else {
        this.teamState.documents.push(entry);
      }
    }
    this.config.onDocumentChanged?.(entry);
  }

  private handleProjectAccessChanged(msg: TeamProjectAccessChangedMessage): void {
    this.config.onProjectAccessChanged?.(msg.projectId, msg.userId, msg.projectRole);
  }

  private handleDocIndexRemoveBroadcast(msg: TeamDocIndexRemoveBroadcastMessage): void {
    this.localEntries.delete(msg.documentId);
    if (this.teamState) {
      this.teamState.documents = this.teamState.documents.filter(d => d.documentId !== msg.documentId);
    }
    this.config.onDocumentRemoved?.(msg.documentId);
  }

  // --------------------------------------------------------------------------
  // First-class folder message handlers
  // --------------------------------------------------------------------------

  private async handleFolderIndexSyncResponse(msg: TeamFolderIndexSyncResponseMessage): Promise<void> {
    const folders = await this.decryptFolders(msg.folders);
    this.folderEntries.clear();
    for (const f of folders) {
      this.folderEntries.set(f.folderId, f);
    }
    if (this.teamState) {
      this.teamState.folders = folders;
    }
    const waiters = this.folderResyncWaiters;
    this.folderResyncWaiters = [];
    for (const waiter of waiters) waiter(folders);
    this.config.onFoldersLoaded?.(folders);
  }

  private async handleFolderBroadcast(msg: TeamFolderBroadcastMessage): Promise<void> {
    const folder = await this.decryptFolder(msg.folder);
    this.folderEntries.set(folder.folderId, folder);
    if (this.teamState) {
      const idx = this.teamState.folders.findIndex(f => f.folderId === folder.folderId);
      if (idx >= 0) this.teamState.folders[idx] = folder;
      else this.teamState.folders.push(folder);
    }
    this.config.onFolderChanged?.(folder);
  }

  private handleFolderRemoveBroadcast(msg: TeamFolderRemoveBroadcastMessage): void {
    for (const fid of msg.folderIds) this.folderEntries.delete(fid);
    for (const did of msg.documentIds) this.localEntries.delete(did);
    if (this.teamState) {
      const removedFolders = new Set(msg.folderIds);
      const removedDocs = new Set(msg.documentIds);
      this.teamState.folders = this.teamState.folders.filter(f => !removedFolders.has(f.folderId));
      this.teamState.documents = this.teamState.documents.filter(d => !removedDocs.has(d.documentId));
    }
    this.config.onFoldersRemoved?.(msg.folderIds, msg.documentIds);
  }

  private async decryptFolders(encrypted: EncryptedFolderNode[]): Promise<FolderNode[]> {
    const results: FolderNode[] = [];
    for (const e of encrypted) {
      results.push(await this.decryptFolder(e));
    }
    return results;
  }

  private async decryptFolder(encrypted: EncryptedFolderNode): Promise<FolderNode> {
    let name = '';
    let decryptFailed = false;
    try {
      name = await this.decryptFolderName(encrypted.encryptedName, encrypted.nameIv);
    } catch (err) {
      console.warn('[TeamSync] Folder name decrypt failed; surfacing as locked:', encrypted.folderId, err);
      decryptFailed = true;
    }
    return {
      folderId: encrypted.folderId,
      parentFolderId: encrypted.parentFolderId ?? null,
      name,
      sortOrder: encrypted.sortOrder,
      projectId: encrypted.projectId ?? null,
      createdBy: encrypted.createdBy,
      createdAt: encrypted.createdAt,
      updatedAt: encrypted.updatedAt,
      decryptFailed: decryptFailed || undefined,
    };
  }

  /**
   * Resolve a wire folder name to plaintext. The server decrypts names it owns
   * and sends them with the empty-iv sentinel. A non-empty iv is pre-cutover
   * ciphertext no supported client can read, so throw and let the caller mark
   * the row locked instead of rendering base64 as a folder name.
   */
  private async decryptFolderName(encryptedName: string, nameIv: string): Promise<string> {
    if (nameIv) {
      throw new Error('folder name is pre-cutover client-encrypted content and can no longer be read');
    }
    return encryptedName;
  }

  // --------------------------------------------------------------------------
  // Internal Helpers
  // --------------------------------------------------------------------------

  private async decryptDocuments(
    encrypted: EncryptedDocIndexEntry[],
    opts?: { quietLockedWarnings?: boolean },
  ): Promise<DocIndexEntry[]> {
    const emptyIv = encrypted.filter(e => !e.titleIv).length;
    if (emptyIv !== encrypted.length) {
      console.warn('[TeamSync] doc-index sync:', encrypted.length, 'entries,',
        encrypted.length - emptyIv, 'unreadable pre-cutover ciphertext titles');
    }
    const results: DocIndexEntry[] = [];
    let quietLockedCount = 0;
    for (const e of encrypted) {
      try {
        results.push(await this.decryptEntry(e));
      } catch (err) {
        // Preserve the entry as a locked placeholder so the user can see
        // that a doc exists and take action (refresh keys, ask admin to
        // rewrap), rather than the entry disappearing without trace.
        if (opts?.quietLockedWarnings) {
          quietLockedCount++;
        } else {
          console.warn(
            '[TeamSync] Title decrypt failed; surfacing as locked entry:',
            e.documentId,
            err,
          );
        }
        results.push({
          documentId: e.documentId,
          projectId: e.projectId ?? null,
          title: '',
          documentType: e.documentType,
          metadataVersion: e.metadataVersion,
          fileExtension: e.fileExtension,
          editorId: e.editorId,
          createdBy: e.createdBy,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          lastWriterUserId: e.lastWriterUserId ?? null,
          parentFolderId: e.parentFolderId ?? null,
          trashedAt: e.trashedAt ?? null,
          decryptFailed: true,
        });
      }
    }
    if (quietLockedCount > 0) {
      console.log(
        `[TeamSync] teamSync raw path: ${quietLockedCount}/${encrypted.length} titles pending docIndexSync (server-managed; expected)`,
      );
    }
    return results;
  }

  private async decryptEntry(encrypted: EncryptedDocIndexEntry): Promise<DocIndexEntry> {
    const title = await this.decryptTitleFromWire(
      encrypted.documentId,
      encrypted.encryptedTitle,
      encrypted.titleIv,
    );
    return {
      documentId: encrypted.documentId,
      projectId: encrypted.projectId ?? null,
      title,
      documentType: encrypted.documentType,
      metadataVersion: encrypted.metadataVersion,
      fileExtension: encrypted.fileExtension,
      editorId: encrypted.editorId,
      createdBy: encrypted.createdBy,
      createdAt: encrypted.createdAt,
      updatedAt: encrypted.updatedAt,
      lastWriterUserId: encrypted.lastWriterUserId ?? null,
      parentFolderId: encrypted.parentFolderId ?? null,
      trashedAt: encrypted.trashedAt ?? null,
    };
  }

  /**
   * Resolve a wire doc-index title to plaintext. The server decrypts titles it
   * owns and sends them with the empty-iv sentinel (''). A NON-EMPTY iv is a
   * pre-cutover row from the retired client-managed lane: no supported client
   * holds that key, so THROW and let the caller mark the entry `decryptFailed`
   * (locked) rather than rendering raw base64 as a title.
   */
  private async decryptTitleFromWire(
    _documentId: string,
    encryptedTitle: string,
    titleIv: string,
  ): Promise<string> {
    if (titleIv) {
      throw new Error('doc-index title is pre-cutover client-encrypted content and can no longer be read');
    }
    return encryptedTitle;
  }

  /**
   * Request a fresh team/doc-index snapshot and resolve with the RAW (still
   * encrypted) entries the server returns, so callers can inspect actual server
   * state (e.g. confirm a backfill persisted). Resolves null on timeout.
   */
  private requestDocIndexResync(timeoutMs = 6000): Promise<EncryptedDocIndexEntry[] | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (docs: EncryptedDocIndexEntry[] | null) => {
        if (settled) return;
        settled = true;
        this.resyncWaiters = this.resyncWaiters.filter(w => w !== waiter);
        resolve(docs);
      };
      const waiter = (docs: EncryptedDocIndexEntry[]) => done(docs);
      this.resyncWaiters.push(waiter);
      setTimeout(() => done(null), timeoutMs);
      // Use the DECRYPTING path: a persisted backfill comes back as plaintext
      // with an empty iv here (teamSync returns raw DEK ciphertext and can't
      // confirm persistence).
      this.send({ type: 'docIndexSync' });
    });
  }

  private send(message: TeamClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    const key = this.offlineQueueKey(message);
    if (!key) {
      // Everything else (teamSync, index reads) is re-sent on reconnect via
      // the normal handshake, so queuing it would only duplicate work.
      return;
    }
    // Collapse a duplicate of the same logical mutation; both queued kinds are
    // idempotent server-side, so the last one wins.
    this.pendingOfflineMessages = this.pendingOfflineMessages.filter(
      pending => this.offlineQueueKey(pending) !== key,
    );
    this.pendingOfflineMessages.push(message);
    console.warn(`[TeamSync] Queued offline ${message.type} (${this.pendingOfflineMessages.length} pending)`);
  }

  /**
   * Dedupe key for a message worth surviving a disconnect, or undefined when
   * the message should simply be dropped while offline.
   */
  private offlineQueueKey(msg: TeamClientMessage): string | undefined {
    if (msg.type === 'documentCommentNotify') {
      // The server keys inbox delivery on (recipient, commentId), so replacing
      // a queued notification for the same comment cannot lose a delivery.
      return `${msg.type}:${msg.commentId}:${msg.reason}`;
    }
    if (!this.isDocIndexMessage(msg)) return undefined;
    const entityId = 'documentId' in msg ? msg.documentId
      : 'folderId' in msg ? msg.folderId
      : undefined;
    return entityId ? `${msg.type}:${entityId}` : undefined;
  }

  private isDocIndexMessage(msg: TeamClientMessage): boolean {
    return msg.type === 'docIndexRegister' || msg.type === 'docIndexUpdate' || msg.type === 'docIndexRemove'
      || msg.type === 'docTrash' || msg.type === 'docRestore' || msg.type === 'docMove'
      || msg.type === 'folderRegister' || msg.type === 'folderRename'
      || msg.type === 'folderMove' || msg.type === 'folderRemove';
  }

  private replayPendingOfflineMessages(): void {
    if (this.pendingOfflineMessages.length === 0) return;
    const messages = this.pendingOfflineMessages.splice(0);
    console.log(`[TeamSync] Replaying ${messages.length} pending offline messages`);
    for (const msg of messages) {
      this.send(msg);
    }
  }

  private setStatus(status: TeamSyncStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.config.onStatusChange?.(status);
  }

  private handleDisconnect(): void {
    this.ws = null;
    this.setStatus('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS
    );
    // Add jitter: 0.5x to 1.5x
    const jittered = delay * (0.5 + Math.random());
    this.reconnectAttempt++;

    console.log(`[TeamSync] Reconnecting in ${Math.round(jittered / 1000)}s (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) {
        this.connect().catch(err => {
          console.error('[TeamSync] Reconnect failed:', err);
          this.scheduleReconnect();
        });
      }
    }, jittered);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Immediately reconnect, cancelling any pending backoff and resetting attempts.
   * Called externally when the network has been confirmed available (e.g. after
   * the CollabV3 index has reached `synced`). This intentionally tears down any
   * existing socket first so resume/wake can recover from half-open transports
   * that still report OPEN at the WebSocket API layer.
   *
   * Falls back to normal backoff on failure.
   */
  reconnectNow(): void {
    if (this.destroyed) return;

    // A previous reconnectNow() already started a fresh handshake that hasn't
    // resolved yet. Don't tear it down -- post-wake the broker fires several
    // network-available events in a ~20s burst and we'd otherwise churn through
    // half-finished sockets.
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    this.cancelReconnect();
    this.reconnectAttempt = 0;

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }

    console.log('[TeamSync] Network available, attempting immediate reconnect');
    this.connect().catch(err => {
      console.error('[TeamSync] reconnectNow failed:', err);
      this.scheduleReconnect();
    });
  }
}
