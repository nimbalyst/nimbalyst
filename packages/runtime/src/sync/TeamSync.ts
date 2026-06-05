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
  TeamOrgKeyRotatedMessage,
  EncryptedDocIndexEntry,
  ServerTeamState,
} from './teamSyncTypes';
import type {
  InboxEventKind,
  InboxEventSourceKind,
  InboxEventPayload,
} from '@nimbalyst/collab-protocol';

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
      url = `${serverUrl}/sync/${roomId}?token=${encodeURIComponent(jwt)}`;
    }

    const ws = new WebSocket(url);
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

  async registerDocument(documentId: string, title: string, documentType: string): Promise<void> {
    const { encryptedTitle, titleIv } = await encryptTitle(title, this.config.encryptionKey);
    this.send({
      type: 'docIndexRegister', documentId, encryptedTitle, titleIv, documentType,
      orgKeyFingerprint: this.config.orgKeyFingerprint,
    });
  }

  async updateDocumentTitle(documentId: string, newTitle: string): Promise<void> {
    const { encryptedTitle, titleIv } = await encryptTitle(newTitle, this.config.encryptionKey);
    this.send({
      type: 'docIndexUpdate', documentId, encryptedTitle, titleIv,
      orgKeyFingerprint: this.config.orgKeyFingerprint,
    });
  }

  removeDocument(documentId: string): void {
    this.localEntries.delete(documentId);
    this.send({
      type: 'docIndexRemove', documentId,
      orgKeyFingerprint: this.config.orgKeyFingerprint,
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
        case 'orgKeyRotated':
          this.handleOrgKeyRotated(message);
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

    // Decrypt document titles
    const documents = await this.decryptDocuments(server.documents);

    this.teamState = {
      metadata: server.metadata,
      members: server.members,
      documents,
      keyEnvelope: server.keyEnvelope,
    };

    // Update local doc entries cache
    this.localEntries.clear();
    for (const doc of documents) {
      this.localEntries.set(doc.documentId, doc);
    }

    this.setStatus('connected');
    // console.log('[TeamSync] Team state loaded:', server.members.length, 'members,', documents.length, 'documents');

    this.config.onTeamStateLoaded?.(this.teamState);
    if (documents.length > 0) {
      this.config.onDocumentsLoaded?.(documents);
    }

    // Replay any doc index mutations that were queued while disconnected
    this.replayPendingDocIndexMessages();
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
        title: '',
        documentType: msg.document.documentType,
        createdBy: msg.document.createdBy,
        createdAt: msg.document.createdAt,
        updatedAt: msg.document.updatedAt,
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

  private handleDocIndexRemoveBroadcast(msg: TeamDocIndexRemoveBroadcastMessage): void {
    this.localEntries.delete(msg.documentId);
    if (this.teamState) {
      this.teamState.documents = this.teamState.documents.filter(d => d.documentId !== msg.documentId);
    }
    this.config.onDocumentRemoved?.(msg.documentId);
  }

  // --------------------------------------------------------------------------
  // Internal Helpers
  // --------------------------------------------------------------------------

  private async decryptDocuments(encrypted: EncryptedDocIndexEntry[]): Promise<DocIndexEntry[]> {
    const results: DocIndexEntry[] = [];
    for (const e of encrypted) {
      try {
        results.push(await this.decryptEntry(e));
      } catch (err) {
        // Preserve the entry as a locked placeholder so the user can see
        // that a doc exists and take action (refresh keys, ask admin to
        // rewrap), rather than the entry disappearing without trace.
        console.warn(
          '[TeamSync] Title decrypt failed; surfacing as locked entry:',
          e.documentId,
          err,
        );
        results.push({
          documentId: e.documentId,
          title: '',
          documentType: e.documentType,
          createdBy: e.createdBy,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          decryptFailed: true,
        });
      }
    }
    return results;
  }

  private async decryptEntry(encrypted: EncryptedDocIndexEntry): Promise<DocIndexEntry> {
    const title = await decryptTitle(encrypted.encryptedTitle, encrypted.titleIv, this.config.encryptionKey);
    return {
      documentId: encrypted.documentId,
      title,
      documentType: encrypted.documentType,
      createdBy: encrypted.createdBy,
      createdAt: encrypted.createdAt,
      updatedAt: encrypted.updatedAt,
    };
  }

  private send(message: TeamClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else if (this.isDocIndexMessage(message)) {
      // Queue doc index mutations so they survive disconnection.
      // Collapse duplicate register/update for the same documentId.
      const docId = 'documentId' in message ? message.documentId : undefined;
      if (docId) {
        this.pendingDocIndexMessages = this.pendingDocIndexMessages.filter(m =>
          !('documentId' in m) || m.documentId !== docId || m.type !== message.type
        );
      }
      this.pendingDocIndexMessages.push(message);
      console.warn(`[TeamSync] Queued offline ${message.type} (${this.pendingDocIndexMessages.length} pending)`);
    }
    // Non-doc-index messages (teamSync, identity key ops) are intentionally
    // not queued -- they are re-sent on reconnect via the normal handshake.
  }

  private isDocIndexMessage(msg: TeamClientMessage): boolean {
    return msg.type === 'docIndexRegister' || msg.type === 'docIndexUpdate' || msg.type === 'docIndexRemove';
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
