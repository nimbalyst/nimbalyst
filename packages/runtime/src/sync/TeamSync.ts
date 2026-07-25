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
  TeamKeyEnvelopeAvailableMessage,
  TeamKeyEnvelopeMessage,
  TeamIdentityKeyResponseMessage,
  TeamIdentityKeyUploadedMessage,
  TeamDocIndexSyncResponseMessage,
  TeamDocIndexBroadcastMessage,
  TeamDocIndexRemoveBroadcastMessage,
  TeamFolderIndexSyncResponseMessage,
  TeamFolderBroadcastMessage,
  TeamFolderRemoveBroadcastMessage,
  TeamOrgKeyRotatedMessage,
  TeamProjectAccessChangedMessage,
  EncryptedDocIndexEntry,
  EncryptedFolderNode,
  FolderNode,
  ServerTeamState,
  SharedDocumentTypeMetadataV2,
} from './teamSyncTypes';
import type {
  InboxEventKind,
  InboxEventSourceKind,
  InboxEventPayload,
} from '@nimbalyst/collab-protocol';
import { appendSyncClientParams } from './syncClientInfo';

// ============================================================================
// Encryption Utilities
// ============================================================================

const CHUNK_SIZE = 8192;

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length < 1024) {
    return btoa(String.fromCharCode(...bytes));
  }
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    result += String.fromCharCode(...chunk);
  }
  return btoa(result);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function encryptTitle(
  title: string,
  key: CryptoKey
): Promise<{ encryptedTitle: string; titleIv: string }> {
  const plaintext = new TextEncoder().encode(title);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );
  return {
    encryptedTitle: uint8ArrayToBase64(new Uint8Array(ciphertext)),
    titleIv: uint8ArrayToBase64(iv),
  };
}

async function decryptTitle(
  encryptedTitle: string,
  titleIv: string,
  key: CryptoKey
): Promise<string> {
  const ciphertext = base64ToUint8Array(encryptedTitle);
  const ivBytes = base64ToUint8Array(titleIv);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    key,
    ciphertext as BufferSource
  );
  return new TextDecoder().decode(plaintext);
}

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
   * NIM-906: documentIds whose titles were recovered from a PRE-MIGRATION
   * legacy ciphertext row (non-empty iv) using the legacy org key. These are
   * candidates for `backfillLegacyTitles()`, which re-registers them as
   * plaintext so the server can re-key them under the team DEK.
   */
  private legacyTitleDocIds: Set<string> = new Set();

  /** Guards the one-shot auto self-heal so it runs at most once per session. */
  private legacyTitleBackfillRan = false;

  /**
   * NIM-910: resolvers waiting for the next team/doc-index snapshot, used to
   * verify a backfill actually persisted server-side. Resolved with the RAW
   * (still-encrypted) server entries so the caller can inspect `titleIv`.
   */
  private resyncWaiters: Array<(docs: EncryptedDocIndexEntry[]) => void> = [];

  /** Resolvers waiting for the next decrypted folder-index snapshot. */
  private folderResyncWaiters: Array<(folders: FolderNode[] | null) => void> = [];

  /**
   * Pending doc index messages queued while disconnected.
   * Unlike DocumentSync (which queues CRDT updates), TeamSync was silently
   * dropping doc index mutations when offline. This queue ensures register,
   * update, and remove operations survive reconnection.
   */
  private pendingDocIndexMessages: TeamClientMessage[] = [];

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
      // Announce our personal org so the TeamRoom can route inbox events to
      // our PersonalIndexRoom. Re-sent on every (re)connect (idempotent
      // server-side); like `teamSync`, it must wait for the socket to be OPEN,
      // so it lives here rather than after `connect()` resolves.
      if (this.config.personalOrgId) {
        this.announcePersonalOrg(this.config.personalOrgId);
      }
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
    this.pendingDocIndexMessages = [];
    const folderWaiters = this.folderResyncWaiters;
    this.folderResyncWaiters = [];
    for (const waiter of folderWaiters) waiter(null);
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
  // Public API: Identity Keys
  // --------------------------------------------------------------------------

  /** Upload own ECDH public key via WebSocket. */
  uploadIdentityKey(publicKeyJwk: string): void {
    this.send({ type: 'uploadIdentityKey', publicKeyJwk });
  }

  /** Request a member's ECDH public key. Response delivered via identityKeyResponse. */
  requestIdentityKey(targetUserId: string): void {
    this.send({ type: 'requestIdentityKey', targetUserId });
  }

  /** Request own key envelope. Response delivered via keyEnvelope message. */
  requestKeyEnvelope(): void {
    this.send({ type: 'requestKeyEnvelope' });
  }

  // --------------------------------------------------------------------------
  // Public API: Document Index
  // --------------------------------------------------------------------------

  /** Epic H2: true when the server holds the team DEK (no client crypto). */
  private get serverManaged(): boolean {
    return this.config.keyCustody === 'server-managed';
  }

  /** Org key fingerprint to attach to a doc-index write; null in server-managed. */
  private get wireOrgKeyFingerprint(): string | null {
    return this.serverManaged ? null : this.config.orgKeyFingerprint;
  }

  /**
   * Build the wire title fields. Legacy: AES-256-GCM with the org key.
   * Server-managed: plaintext title with the empty-string iv sentinel (the
   * server encrypts at rest with the team DEK).
   */
  private async encodeTitleForWire(title: string): Promise<{ encryptedTitle: string; titleIv: string }> {
    if (this.serverManaged) {
      return { encryptedTitle: title, titleIv: '' };
    }
    return encryptTitle(title, this.config.encryptionKey!);
  }

  async registerDocument(
    documentId: string,
    title: string,
    documentType: string,
    parentFolderId: string | null = null,
    metadata?: SharedDocumentTypeMetadataV2,
  ): Promise<void> {
    const { encryptedTitle, titleIv } = await this.encodeTitleForWire(title);
    this.send({
      type: 'docIndexRegister', documentId, encryptedTitle, titleIv, documentType,
      ...metadata,
      // Epic H3 P0/A: attribute the doc to the active project so the server's
      // project-partitioned doc index (and a future move) can scope it.
      projectId: this.config.teamProjectId ?? null,
      parentFolderId,
      orgKeyFingerprint: this.wireOrgKeyFingerprint,
    });
  }

  async updateDocumentTitle(documentId: string, newTitle: string): Promise<void> {
    const { encryptedTitle, titleIv } = await this.encodeTitleForWire(newTitle);
    this.send({
      type: 'docIndexUpdate', documentId, encryptedTitle, titleIv,
      orgKeyFingerprint: this.wireOrgKeyFingerprint,
    });
  }

  removeDocument(documentId: string): void {
    this.localEntries.delete(documentId);
    this.send({
      type: 'docIndexRemove', documentId,
      orgKeyFingerprint: this.wireOrgKeyFingerprint,
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
      orgKeyFingerprint: this.wireOrgKeyFingerprint,
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
      orgKeyFingerprint: this.wireOrgKeyFingerprint,
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
      orgKeyFingerprint: this.wireOrgKeyFingerprint,
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
      orgKeyFingerprint: this.wireOrgKeyFingerprint,
    });
  }

  /** Rename a folder in place (single-row update of the encrypted name). */
  async renameFolder(folderId: string, newName: string): Promise<void> {
    const { encryptedTitle: encryptedName, titleIv: nameIv } = await this.encodeTitleForWire(newName);
    this.send({
      type: 'folderRename', folderId, encryptedName, nameIv,
      orgKeyFingerprint: this.wireOrgKeyFingerprint,
    });
  }

  /** Move a folder to a new parent (null = root). Server rejects cycles. */
  moveFolder(folderId: string, newParentFolderId: string | null, sortOrder?: number): void {
    this.send({
      type: 'folderMove', folderId, newParentFolderId, sortOrder,
      orgKeyFingerprint: this.wireOrgKeyFingerprint,
    });
  }

  /** Delete a folder recursively (folder + descendants + their documents). */
  removeFolder(folderId: string): void {
    this.folderEntries.delete(folderId);
    this.send({
      type: 'folderRemove', folderId,
      orgKeyFingerprint: this.wireOrgKeyFingerprint,
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
  // Public API: Inbox-event fanout
  // --------------------------------------------------------------------------

  /**
   * Announce this member's personal org id so the TeamRoom can address the
   * member's PersonalIndexRoom for inbox fanout. Safe to call on every connect.
   */
  announcePersonalOrg(personalOrgId: string): void {
    this.send({ type: 'announcePersonalOrg', personalOrgId });
  }

  /**
   * Fan an inbox event out to a set of team members. The payload is encrypted
   * with the org key (which every member holds) before it leaves this client;
   * the server and relay never see plaintext. The TeamRoom mints the event id
   * and delivers to each recipient's PersonalIndexRoom.
   */
  async fanoutInboxEvent(params: {
    recipients: string[];
    kind: InboxEventKind;
    sourceKind: InboxEventSourceKind;
    sourceId: string;
    payload: InboxEventPayload;
  }): Promise<void> {
    if (params.recipients.length === 0) return;
    // Inbox fanout delivers an org-key-encrypted blob into each recipient's
    // (zero-knowledge) PersonalIndexRoom, so it depends on the shared org key.
    // Server-managed teams have no client-held org key, so cross-lane inbox
    // fanout is deferred for them (Epic H2 v1 limitation; notifications are a
    // tracked enterprise follow-up). Skip rather than crash.
    if (this.serverManaged || !this.config.encryptionKey) {
      if (this.serverManaged) {
        console.warn('[TeamSync] inbox fanout skipped: server-managed teams have no client org key (H2 v1 limitation)');
      }
      return;
    }
    // Reuse the org-key AES-GCM string encryptor; fields are generic
    // (ciphertext + iv) regardless of the "title" naming.
    const { encryptedTitle: encryptedPayload, titleIv: iv } = await encryptTitle(
      JSON.stringify(params.payload),
      this.config.encryptionKey
    );
    this.send({
      type: 'inboxEventFanout',
      recipients: params.recipients,
      kind: params.kind,
      sourceKind: params.sourceKind,
      sourceId: params.sourceId,
      encryptedPayload,
      iv,
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
        case 'memberAdded':
          this.handleMemberAdded(message);
          break;
        case 'memberRemoved':
          this.handleMemberRemoved(message);
          break;
        case 'memberRoleChanged':
          this.handleMemberRoleChanged(message);
          break;
        case 'keyEnvelopeAvailable':
          this.handleKeyEnvelopeAvailable(message);
          break;
        case 'keyEnvelope':
          this.handleKeyEnvelope(message);
          break;
        case 'identityKeyResponse':
          this.handleIdentityKeyResponse(message);
          break;
        case 'identityKeyUploaded':
          this.handleIdentityKeyUploaded(message);
          break;
        case 'docIndexSyncResponse':
          await this.handleDocIndexSyncResponse(message);
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
        case 'orgKeyRotated':
          this.handleOrgKeyRotated(message);
          break;
        case 'projectAccessChanged':
          this.handleProjectAccessChanged(message);
          break;
        case 'inboxEventFanoutAck':
          // Best-effort fanout; nothing to reconcile on the sender side.
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
      quietLockedWarnings: this.serverManaged,
    });
    // First-class folders. Absent when talking to a pre-folders server.
    const folders = await this.decryptFolders(server.folders ?? []);

    this.teamState = {
      metadata: server.metadata,
      members: server.members,
      documents,
      folders,
      keyEnvelope: server.keyEnvelope,
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
    if (documents.length > 0) {
      this.config.onDocumentsLoaded?.(documents);
    }
    if (folders.length > 0) {
      this.config.onFoldersLoaded?.(folders);
    }

    // Replay any doc index mutations that were queued while disconnected
    this.replayPendingDocIndexMessages();

    // NIM-910: `teamSync` returns doc-index titles RAW (the server does not
    // decrypt DEK rows on that path), so server-managed plaintext titles arrive
    // as undecryptable ciphertext and render as locked. Immediately request the
    // decrypting `docIndexSync` path, whose response is authoritative for the
    // document list and overwrites the raw one. Folder names have the same
    // server-managed raw-vs-decrypted split, so request the decrypting
    // `folderIndexSync` path too.
    this.send({ type: 'docIndexSync' });
    this.send({ type: 'folderIndexSync' });

    // NIM-906: self-heal any PRE-MIGRATION ciphertext titles we could recover.
    this.maybeAutoBackfillLegacyTitles();
  }

  /**
   * NIM-906: one-shot self-heal. If this client recovered any legacy ciphertext
   * titles (it holds the legacy org key), re-register them as plaintext so the
   * server re-keys them under the team DEK and the whole team sees real titles.
   * Runs at most once per session and only matters for migrated teams that were
   * left with un-rekeyed titles; a no-op everywhere else.
   */
  private maybeAutoBackfillLegacyTitles(): void {
    if (this.config.autoBackfillLegacyTitles === false) return;
    if (this.legacyTitleBackfillRan) return;
    if (!this.serverManaged || !(this.config.legacyOrgKeys?.length)) return;
    if (this.legacyTitleDocIds.size === 0) return;
    this.legacyTitleBackfillRan = true;
    void this.backfillLegacyTitles().catch((err) => {
      console.warn('[TeamSync] auto legacy-title backfill failed:', err);
    });
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

  private handleKeyEnvelopeAvailable(msg: TeamKeyEnvelopeAvailableMessage): void {
    this.config.onKeyEnvelopeAvailable?.(msg.targetUserId);
  }

  private handleKeyEnvelope(msg: TeamKeyEnvelopeMessage): void {
    const envelope = { wrappedKey: msg.wrappedKey, iv: msg.iv, senderPublicKey: msg.senderPublicKey };
    if (this.teamState) {
      this.teamState.keyEnvelope = envelope;
    }
    this.config.onKeyEnvelope?.(envelope);
  }

  private handleIdentityKeyResponse(_msg: TeamIdentityKeyResponseMessage): void {
    // Identity key responses are typically handled by a specific callback or promise
    // registered when requestIdentityKey was called. For now, log it.
    // The Electron layer can hook into this via a dedicated listener if needed.
    console.log('[TeamSync] Received identity key for user:', _msg.userId);
  }

  private handleIdentityKeyUploaded(msg: TeamIdentityKeyUploadedMessage): void {
    console.log('[TeamSync] Member uploaded identity key:', msg.userId);
    this.config.onIdentityKeyUploaded?.(msg.userId);
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

    // NIM-906: self-heal any PRE-MIGRATION ciphertext titles we could recover.
    this.maybeAutoBackfillLegacyTitles();
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

  private handleOrgKeyRotated(msg: TeamOrgKeyRotatedMessage): void {
    console.log('[TeamSync] Org key rotated, new fingerprint:', msg.fingerprint);
    this.config.onOrgKeyRotated?.(msg.fingerprint);
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
   * Resolve a wire folder name to plaintext. Mirrors `decryptTitleFromWire`
   * but without legacy-title backfill tracking (folders are a new entity, so
   * there are no pre-migration ciphertext folder rows to self-heal).
   */
  private async decryptFolderName(encryptedName: string, nameIv: string): Promise<string> {
    if (this.serverManaged) {
      if (!nameIv) return encryptedName;
      const candidates = this.config.legacyOrgKeys ?? [];
      let lastErr: unknown;
      for (const key of candidates) {
        try {
          return await decryptTitle(encryptedName, nameIv, key);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('no key could decrypt folder name');
    }
    return decryptTitle(encryptedName, nameIv, this.config.encryptionKey!);
  }

  // --------------------------------------------------------------------------
  // Internal Helpers
  // --------------------------------------------------------------------------

  private async decryptDocuments(
    encrypted: EncryptedDocIndexEntry[],
    opts?: { quietLockedWarnings?: boolean },
  ): Promise<DocIndexEntry[]> {
    // NIM-910: characterize what the server is actually sending, so a sync/collab
    // bug is diagnosed from SERVER state (empty-iv = server-decrypted plaintext;
    // non-empty-iv = legacy ciphertext passed through) rather than the local view.
    if (this.serverManaged) {
      const emptyIv = encrypted.filter(e => !e.titleIv).length;
      console.log('[TeamSync] doc-index sync:', encrypted.length, 'entries,',
        emptyIv, 'server-plaintext (empty iv),', encrypted.length - emptyIv,
        'legacy-ciphertext; legacyKeyEpochs=', this.config.legacyOrgKeys?.length ?? 0);
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
   * NIM-906: resolve a wire title to plaintext. Mirrors
   * `DocumentSync.decryptFromWire` for the doc-index title path.
   *
   * Server-managed mode is MIXED during/after the legacy-e2e -> server-managed
   * migration:
   *   - Empty-iv sentinel ('') => the server already decrypted the title with
   *     the team DEK; it is plaintext, pass it through.
   *   - Non-empty iv => a PRE-MIGRATION row the server passed through unchanged
   *     (still AES ciphertext under the old org key). Decrypt it with the
   *     retained legacy org key, and record it so `backfillLegacyTitles()` can
   *     re-register it as plaintext. With no legacy key we THROW so the caller
   *     marks the entry `decryptFailed` (locked) rather than rendering the raw
   *     base64 ciphertext as a title (which the tree builder shreds on '/').
   */
  private async decryptTitleFromWire(
    documentId: string,
    encryptedTitle: string,
    titleIv: string,
  ): Promise<string> {
    if (this.serverManaged) {
      if (!titleIv) {
        return encryptedTitle;
      }
      const candidates = this.config.legacyOrgKeys ?? [];
      if (candidates.length === 0) {
        throw new Error(
          'legacy-e2e doc-index title in a server-managed team but no legacy org key is available',
        );
      }
      // The org key may have rotated while the team was legacy-e2e, so titles
      // can be under different epochs. Try each candidate; first one wins.
      let lastErr: unknown;
      for (const key of candidates) {
        try {
          const title = await decryptTitle(encryptedTitle, titleIv, key);
          this.legacyTitleDocIds.add(documentId);
          return title;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error('no legacy org-key epoch could decrypt this doc-index title');
    }
    return decryptTitle(encryptedTitle, titleIv, this.config.encryptionKey!);
  }

  /**
   * NIM-906: re-register every legacy doc-index title this client recovered
   * (decrypted from a non-empty-iv ciphertext row) as PLAINTEXT, so the
   * server DEK-encrypts it at rest, stamps the current fingerprint, and
   * broadcasts it back to the whole team with the empty-iv sentinel. This is
   * the only path that can heal a team whose titles were left as ciphertext by
   * the migration — only a client holding the legacy org key can recover the
   * plaintext (the server never had that zero-knowledge key).
   *
   * Idempotent: once a title is re-registered as plaintext the server serves it
   * with an empty iv, so it is no longer recorded as legacy on the next load.
   *
   * VERIFIED: the server does not echo a client's own `docIndexUpdate` broadcast,
   * and `send()` is fire-and-forget, so a successful send is NOT proof the write
   * persisted (a `rotation_locked` barrier silently rejects writes — this was the
   * NIM-910 mis-verification). After sending we re-request a fresh sync and count
   * how many of the re-registered docs now come back as server-plaintext
   * (empty iv). Returns `{ sent, confirmed }`; `confirmed === null` means the
   * verification round-trip timed out (persistence unknown).
   */
  async backfillLegacyTitles(): Promise<{ sent: number; confirmed: number | null }> {
    if (!this.serverManaged || !(this.config.legacyOrgKeys?.length)) {
      return { sent: 0, confirmed: 0 };
    }
    // Claim the work synchronously (before the first await) so a concurrent
    // caller — e.g. the auto self-heal racing an explicit repair — sees an
    // empty set and doesn't double-register the same titles.
    const ids = Array.from(this.legacyTitleDocIds);
    this.legacyTitleDocIds.clear();
    const sentIds: string[] = [];
    const failed: string[] = [];
    for (const documentId of ids) {
      const entry = this.localEntries.get(documentId);
      if (!entry || entry.decryptFailed) continue;
      try {
        await this.updateDocumentTitle(documentId, entry.title);
        sentIds.push(documentId);
      } catch (err) {
        failed.push(documentId); // allow a later retry
        console.warn('[TeamSync] backfillLegacyTitles re-register failed for', documentId, err);
      }
    }
    for (const documentId of failed) this.legacyTitleDocIds.add(documentId);
    if (sentIds.length === 0) return { sent: 0, confirmed: 0 };

    // Verify the writes actually persisted server-side.
    const raw = await this.requestDocIndexResync();
    let confirmed: number | null = null;
    if (raw) {
      const plaintextNow = new Set(raw.filter(e => !e.titleIv).map(e => e.documentId));
      confirmed = sentIds.filter(id => plaintextNow.has(id)).length;
    }
    console.log('[TeamSync] backfill legacy titles: sent', sentIds.length,
      'confirmed-persisted', confirmed,
      confirmed !== null && confirmed < sentIds.length
        ? '(server rejected some — likely a key-rotation write lock; will retry next sync)'
        : '');
    if (confirmed !== null && confirmed < sentIds.length) {
      // Re-queue the unconfirmed ones so a later sync retries them.
      const persisted = raw ? new Set(raw.filter(e => !e.titleIv).map(e => e.documentId)) : new Set<string>();
      for (const id of sentIds) {
        if (!persisted.has(id)) this.legacyTitleDocIds.add(id);
      }
    }
    return { sent: sentIds.length, confirmed };
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
    } else if (this.isDocIndexMessage(message)) {
      // Queue index mutations (docs + folders) so they survive disconnection.
      // Collapse a duplicate mutation of the same type against the same entity.
      const entityId = 'documentId' in message ? message.documentId
        : 'folderId' in message ? message.folderId
        : undefined;
      if (entityId) {
        this.pendingDocIndexMessages = this.pendingDocIndexMessages.filter(m => {
          const mId = 'documentId' in m ? m.documentId : 'folderId' in m ? m.folderId : undefined;
          return mId !== entityId || m.type !== message.type;
        });
      }
      this.pendingDocIndexMessages.push(message);
      console.warn(`[TeamSync] Queued offline ${message.type} (${this.pendingDocIndexMessages.length} pending)`);
    }
    // Non-index messages (teamSync, identity key ops) are intentionally
    // not queued -- they are re-sent on reconnect via the normal handshake.
  }

  private isDocIndexMessage(msg: TeamClientMessage): boolean {
    return msg.type === 'docIndexRegister' || msg.type === 'docIndexUpdate' || msg.type === 'docIndexRemove'
      || msg.type === 'docTrash' || msg.type === 'docRestore' || msg.type === 'docMove'
      || msg.type === 'folderRegister' || msg.type === 'folderRename'
      || msg.type === 'folderMove' || msg.type === 'folderRemove';
  }

  private replayPendingDocIndexMessages(): void {
    if (this.pendingDocIndexMessages.length === 0) return;
    const messages = this.pendingDocIndexMessages.splice(0);
    console.log(`[TeamSync] Replaying ${messages.length} pending doc index messages`);
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
