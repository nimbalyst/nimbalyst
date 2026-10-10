/**
 * ProjectSyncProvider
 *
 * Client-side provider that connects to a ProjectSyncRoom Durable Object
 * for syncing .md file content. One WebSocket connection per project.
 *
 * Runs in the Electron main process. The desktop background sync service
 * (ProjectFileSyncService) uses this to push/receive file content.
 *
 * Architecture:
 *   - Single WebSocket per project: org:{orgId}:user:{personalMemberId}:project:{projectId}
 *   - Sends projectSyncRequest on connect with manifest of local file state
 *   - Receives projectSyncResponse with deltas (updated, new, deleted files)
 *   - Handles realtime broadcasts (fileContentBroadcast, fileDeleteBroadcast, etc.)
 *   - Queues outgoing messages when offline, replays on reconnect
 */

// Wire protocol types come from `@nimbalyst/collab-protocol`, which is the
// single source of truth shared with the sync server.
import type {
  ProjectSyncRequestMessage,
  FileContentPushMessage,
  FileContentBatchPushMessage,
  FileDeleteMessage,
  FileYjsInitMessage,
  FileYjsUpdateMessage,
  FileYjsCompactMessage,
  ProjectSyncFileEntry,
  ProjectSyncYjsUpdate,
  ProjectSyncResponseMessage,
  FileContentBroadcastMessage,
  FileDeleteBroadcastMessage,
  FileContentPushAckMessage,
  ProjectSyncFileRejection,
} from '@nimbalyst/collab-protocol';
import { appendSyncClientParams } from './syncClientInfo';
import { UnconfirmedPushes, type PushedFileRef } from './projectSyncPushConfirmations';
import type { PersonalJwt, PersonalMemberId } from '../auth/jwtScopes';


export interface ProjectSyncConfig {
  serverUrl: string;
  getJwt: () => Promise<PersonalJwt>;
  orgId: string;
  personalMemberId: PersonalMemberId;
  encryptionKey: CryptoKey;
}

export interface ProjectSyncFileUpdate {
  syncId: string;
  relativePath: string;
  title: string;
  content: string;
  contentHash: string;
  lastModifiedAt: number;
  hasYjs: boolean;
}

export interface ProjectSyncManifestFile {
  syncId: string;
  contentHash: string;
  lastModifiedAt: number;
  hasYjs: boolean;
  yjsSeq: number;
}

export interface ProjectSyncResponse {
  updatedFiles: ProjectSyncFileUpdate[];
  newFiles: ProjectSyncFileUpdate[];
  deletedSyncIds: string[];
  needFromClient: string[];
  yjsUpdates: ProjectSyncYjsUpdate[];
  /**
   * Earlier pushes that got no ack, which the server now says it holds. Comes
   * before anything else in the response, so a baseline can be settled first.
   */
  confirmedPushes?: PushedFileRef[];
}

/**
 * What the server did with a content push. A file is `rejected` only when the
 * server said so in an ack. `stored` also covers a push sent to a server that
 * predates the ack, which stores what it receives without answering.
 * `unconfirmed` is a push queued offline (the sync request that precedes the
 * replay re-requests it) or one an acking server never answered (dropped
 * socket, timeout); the latter is settled by the next sync response, which
 * reports it in `confirmedPushes` only if the server holds what was pushed.
 */
export interface ProjectFilePushOutcome {
  stored: string[];
  rejected: ProjectSyncFileRejection[];
  unconfirmed: string[];
}

const PUSH_ACK_TIMEOUT_MS = 30_000;

interface PendingPush {
  projectId: string;
  ws: WebSocket;
  files: PushedFileRef[];
  resolve: (outcome: ProjectFilePushOutcome) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

// ============================================================================
// Encryption helpers (matching CollabV3Sync patterns)
// ============================================================================

async function encrypt(
  plaintext: string,
  key: CryptoKey
): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  return {
    encrypted: Buffer.from(encrypted).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
  };
}

async function decrypt(
  encryptedBase64: string,
  ivBase64: string,
  key: CryptoKey
): Promise<string> {
  const encrypted = Buffer.from(encryptedBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted
  );
  return new TextDecoder().decode(decrypted);
}

// ============================================================================
// ProjectSyncProvider
// ============================================================================

export class ProjectSyncProvider {
  private config: ProjectSyncConfig;
  private connections = new Map<string, WebSocket>();
  private offlineQueues = new Map<string, string[]>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectAttempts = new Map<string, number>();
  // Per-project manifest builder. Called on every (re)connect so the server
  // always diffs against *current* disk state, never a stale startup snapshot
  // (NIM-853, Layer 1).
  private manifestProviders = new Map<string, () => Promise<ProjectSyncManifestFile[]>>();
  private pendingPushes = new Map<string, PendingPush>(); // requestId -> pending ack
  // Whether the server behind a socket acks pushes, learned from its first
  // projectSyncResponse. Absent until then.
  private pushAckSockets = new WeakMap<WebSocket, boolean>();
  private unconfirmedPushes = new UnconfirmedPushes();

  // Event callbacks
  private onFileUpdateCallbacks = new Set<(projectId: string, file: ProjectSyncFileUpdate) => void>();
  private onFileDeleteCallbacks = new Set<(projectId: string, syncId: string) => void>();
  private onSyncResponseCallbacks = new Set<(projectId: string, response: ProjectSyncResponse) => void>();
  private onStatusCallbacks = new Set<(projectId: string, connected: boolean) => void>();

  constructor(config: ProjectSyncConfig) {
    this.config = config;
  }

  // MARK: - Connection

  async connect(projectId: string, getManifest: () => Promise<ProjectSyncManifestFile[]>): Promise<void> {
    if (this.connections.has(projectId)) return;

    // Remember the builder so reconnects re-announce fresh disk state.
    this.manifestProviders.set(projectId, getManifest);

    try {
      const jwt = await this.config.getJwt();
      const roomId = `org:${this.config.orgId}:user:${this.config.personalMemberId}:project:${projectId}`;
      const wsBase = this.config.serverUrl
        .replace('https://', 'wss://')
        .replace('http://', 'ws://')
        .replace(/\/+$/, '');

      const encodedToken = encodeURIComponent(jwt);
      const url = appendSyncClientParams(`${wsBase}/sync/${roomId}?token=${encodedToken}`);

      const ws = new WebSocket(url);
      this.connections.set(projectId, ws);

      ws.onopen = () => {
        this.reconnectAttempts.set(projectId, 0);
        this.notifyStatus(projectId, true);
        // Build the manifest from *current* disk, send it, then drain the queue.
        // Ordering preserved: sync request before replayed pushes.
        void (async () => {
          await this.sendFreshSyncRequest(projectId);
          this.replayOfflineQueue(projectId);
        })();
      };

      ws.onmessage = (event) => {
        this.handleMessage(projectId, event.data as string);
      };

      ws.onclose = () => {
        this.connections.delete(projectId);
        this.settlePendingPushes(projectId);
        this.notifyStatus(projectId, false);
        this.scheduleReconnect(projectId);
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    } catch (err) {
      console.error(`[ProjectSync] Failed to connect project ${projectId}:`, err);
    }
  }

  disconnect(projectId: string): void {
    const timer = this.reconnectTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(projectId);
    }
    this.reconnectAttempts.delete(projectId);
    this.manifestProviders.delete(projectId);

    const ws = this.connections.get(projectId);
    if (ws) {
      ws.onclose = null; // Prevent reconnect
      ws.close();
      this.connections.delete(projectId);
    }
    this.settlePendingPushes(projectId);
    this.notifyStatus(projectId, false);
  }

  disconnectAll(): void {
    for (const projectId of [...this.connections.keys()]) {
      this.disconnect(projectId);
    }
    // Cancel any reconnects still pending for projects without a live socket.
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.manifestProviders.clear();
    this.offlineQueues.clear();
  }

  isConnected(projectId: string): boolean {
    const ws = this.connections.get(projectId);
    return ws?.readyState === WebSocket.OPEN;
  }

  // MARK: - Sync Request

  /**
   * Re-announce current disk state so the server re-offers what this client
   * lacks, through the normal receive path (timestamps, conflicts, deletes).
   * No-op when the project is not connected; the next connect does the same.
   */
  resync(projectId: string): Promise<void> {
    return this.sendFreshSyncRequest(projectId);
  }

  /** Rebuild the manifest from current disk state and send the sync request. */
  private async sendFreshSyncRequest(projectId: string): Promise<void> {
    const getManifest = this.manifestProviders.get(projectId);
    if (!getManifest) return;
    let manifest: ProjectSyncManifestFile[];
    try {
      manifest = await getManifest();
    } catch (err) {
      console.error(`[ProjectSync] Failed to build manifest for ${projectId}:`, err);
      return;
    }
    // The connection may have dropped while building the manifest.
    if (this.connections.get(projectId)?.readyState !== WebSocket.OPEN) return;
    this.sendSyncRequest(projectId, manifest);
  }

  private sendSyncRequest(projectId: string, manifest: ProjectSyncManifestFile[]): void {
    const msg: ProjectSyncRequestMessage = {
      type: 'projectSyncRequest',
      files: manifest.map(f => ({
        syncId: f.syncId,
        contentHash: f.contentHash,
        lastModifiedAt: f.lastModifiedAt,
        hasYjs: f.hasYjs,
        yjsSeq: f.yjsSeq,
      })),
    };
    const confirm = this.unconfirmedPushes.syncIds(projectId);
    if (confirm.length > 0) msg.confirm = confirm;
    this.sendJson(projectId, msg);
  }

  // MARK: - Message Handling

  private async handleMessage(projectId: string, raw: string): Promise<void> {
    let envelope: { type: string };
    try {
      envelope = JSON.parse(raw);
    } catch {
      return;
    }

    switch (envelope.type) {
      case 'projectSyncResponse': {
        const msg = envelope as ProjectSyncResponseMessage;
        this.notePushAckSupport(projectId, msg.pushAck === true);
        // Settled before the await, so a later push of the same file supersedes it.
        const confirmedPushes = this.unconfirmedPushes.settle(projectId, msg);
        await this.handleSyncResponse(projectId, msg, confirmedPushes);
        break;
      }
      case 'fileContentBroadcast':
        await this.handleFileContentBroadcast(projectId, JSON.parse(raw) as FileContentBroadcastMessage);
        break;
      case 'fileDeleteBroadcast':
        this.handleFileDeleteBroadcast(projectId, JSON.parse(raw) as FileDeleteBroadcastMessage);
        break;
      case 'fileYjsInitBroadcast':
        // Future: handle Yjs init
        break;
      case 'fileYjsUpdateBroadcast':
        // Future: handle Yjs updates
        break;
      case 'fileContentPushAck':
        this.handlePushAck(JSON.parse(raw) as FileContentPushAckMessage);
        break;
      case 'error': {
        const err = JSON.parse(raw) as { message: string };
        console.error(`[ProjectSync] Server error for ${projectId}:`, err.message);
        break;
      }
    }
  }

  private async handleSyncResponse(projectId: string, msg: ProjectSyncResponseMessage, confirmedPushes: PushedFileRef[]): Promise<void> {
    const key = this.config.encryptionKey;

    const decryptFile = async (entry: ProjectSyncFileEntry): Promise<ProjectSyncFileUpdate> => {
      const [relativePath, title, content] = await Promise.all([
        decrypt(entry.encryptedPath, entry.pathIv, key).catch(() => 'unknown.md'),
        decrypt(entry.encryptedTitle, entry.titleIv, key).catch(() => 'unknown'),
        decrypt(entry.encryptedContent, entry.contentIv, key).catch(() => ''),
      ]);
      return {
        syncId: entry.syncId,
        relativePath,
        title,
        content,
        contentHash: entry.contentHash,
        lastModifiedAt: entry.lastModifiedAt,
        hasYjs: entry.hasYjs,
      };
    };

    const [updatedFiles, newFiles] = await Promise.all([
      Promise.all(msg.updatedFiles.map(decryptFile)),
      Promise.all(msg.newFiles.map(decryptFile)),
    ]);

    const response: ProjectSyncResponse = {
      updatedFiles,
      newFiles,
      deletedSyncIds: msg.deletedSyncIds,
      needFromClient: msg.needFromClient,
      yjsUpdates: msg.yjsUpdates,
      ...(confirmedPushes.length > 0 ? { confirmedPushes } : {}),
    };

    // console.log(`[ProjectSync] Sync response for ${projectId}: ${updatedFiles.length} updated, ${newFiles.length} new, ${msg.deletedSyncIds.length} deleted, ${msg.needFromClient.length} needed`);

    for (const cb of this.onSyncResponseCallbacks) {
      cb(projectId, response);
    }
  }

  private async handleFileContentBroadcast(projectId: string, msg: FileContentBroadcastMessage): Promise<void> {
    const key = this.config.encryptionKey;
    const [relativePath, title, content] = await Promise.all([
      decrypt(msg.encryptedPath, msg.pathIv, key).catch(() => 'unknown.md'),
      decrypt(msg.encryptedTitle, msg.titleIv, key).catch(() => 'unknown'),
      decrypt(msg.encryptedContent, msg.contentIv, key).catch(() => ''),
    ]);

    const file: ProjectSyncFileUpdate = {
      syncId: msg.syncId,
      relativePath,
      title,
      content,
      contentHash: msg.contentHash,
      lastModifiedAt: msg.lastModifiedAt,
      hasYjs: false,
    };

    for (const cb of this.onFileUpdateCallbacks) {
      cb(projectId, file);
    }
  }

  private handleFileDeleteBroadcast(projectId: string, msg: FileDeleteBroadcastMessage): void {
    for (const cb of this.onFileDeleteCallbacks) {
      cb(projectId, msg.syncId);
    }
  }

  // MARK: - Push Methods

  async pushFileContent(
    projectId: string,
    syncId: string,
    content: string,
    relativePath: string,
    title: string,
    lastModifiedAt: number
  ): Promise<ProjectFilePushOutcome> {
    const key = this.config.encryptionKey;
    const contentHash = await this.sha256(content);

    const [enc, encPath, encTitle] = await Promise.all([
      encrypt(content, key),
      encrypt(relativePath, key),
      encrypt(title, key),
    ]);

    const msg: FileContentPushMessage = {
      type: 'fileContentPush',
      syncId,
      encryptedContent: enc.encrypted,
      contentIv: enc.iv,
      contentHash,
      encryptedPath: encPath.encrypted,
      pathIv: encPath.iv,
      encryptedTitle: encTitle.encrypted,
      titleIv: encTitle.iv,
      lastModifiedAt,
      requestId: crypto.randomUUID(),
    };
    return this.sendAwaitingAck(projectId, msg, [{ syncId, contentHash, lastModifiedAt }]);
  }

  async pushFileBatch(
    projectId: string,
    files: Array<{
      syncId: string;
      content: string;
      relativePath: string;
      title: string;
      lastModifiedAt: number;
    }>
  ): Promise<ProjectFilePushOutcome> {
    const key = this.config.encryptionKey;

    const entries = await Promise.all(
      files.map(async (f) => {
        const contentHash = await this.sha256(f.content);
        const [enc, encPath, encTitle] = await Promise.all([
          encrypt(f.content, key),
          encrypt(f.relativePath, key),
          encrypt(f.title, key),
        ]);
        return {
          syncId: f.syncId,
          encryptedContent: enc.encrypted,
          contentIv: enc.iv,
          contentHash,
          encryptedPath: encPath.encrypted,
          pathIv: encPath.iv,
          encryptedTitle: encTitle.encrypted,
          titleIv: encTitle.iv,
          lastModifiedAt: f.lastModifiedAt,
        };
      })
    );

    const msg: FileContentBatchPushMessage = {
      type: 'fileContentBatchPush',
      files: entries,
      requestId: crypto.randomUUID(),
    };
    return this.sendAwaitingAck(projectId, msg, entries.map(({ syncId, contentHash, lastModifiedAt }) => ({ syncId, contentHash, lastModifiedAt })));
  }

  deleteFile(projectId: string, syncId: string): void {
    const msg: FileDeleteMessage = { type: 'fileDelete', syncId };
    this.sendOrQueue(projectId, msg);
  }

  async initYjs(projectId: string, syncId: string, snapshot: Uint8Array): Promise<void> {
    const key = this.config.encryptionKey;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, snapshot as BufferSource);

    const msg: FileYjsInitMessage = {
      type: 'fileYjsInit',
      syncId,
      encryptedSnapshot: Buffer.from(encrypted).toString('base64'),
      iv: Buffer.from(iv).toString('base64'),
    };
    this.sendOrQueue(projectId, msg);
  }

  async pushYjsUpdate(projectId: string, syncId: string, update: Uint8Array): Promise<void> {
    const key = this.config.encryptionKey;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, update as BufferSource);

    const msg: FileYjsUpdateMessage = {
      type: 'fileYjsUpdate',
      syncId,
      encryptedUpdate: Buffer.from(encrypted).toString('base64'),
      iv: Buffer.from(iv).toString('base64'),
    };
    this.sendOrQueue(projectId, msg);
  }

  async compactYjs(projectId: string, syncId: string, snapshot: Uint8Array, replacesUpTo: number): Promise<void> {
    const key = this.config.encryptionKey;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, snapshot as BufferSource);

    const msg: FileYjsCompactMessage = {
      type: 'fileYjsCompact',
      syncId,
      encryptedSnapshot: Buffer.from(encrypted).toString('base64'),
      iv: Buffer.from(iv).toString('base64'),
      replacesUpTo,
    };
    this.sendOrQueue(projectId, msg);
  }

  // MARK: - Event Subscriptions

  onFileUpdate(callback: (projectId: string, file: ProjectSyncFileUpdate) => void): () => void {
    this.onFileUpdateCallbacks.add(callback);
    return () => this.onFileUpdateCallbacks.delete(callback);
  }

  onFileDelete(callback: (projectId: string, syncId: string) => void): () => void {
    this.onFileDeleteCallbacks.add(callback);
    return () => this.onFileDeleteCallbacks.delete(callback);
  }

  onSyncResponse(callback: (projectId: string, response: ProjectSyncResponse) => void): () => void {
    this.onSyncResponseCallbacks.add(callback);
    return () => this.onSyncResponseCallbacks.delete(callback);
  }

  onStatusChange(callback: (projectId: string, connected: boolean) => void): () => void {
    this.onStatusCallbacks.add(callback);
    return () => this.onStatusCallbacks.delete(callback);
  }

  // MARK: - Internal

  private sendJson(projectId: string, msg: unknown): void {
    const ws = this.connections.get(projectId);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private sendOrQueue(projectId: string, msg: unknown): void {
    const json = JSON.stringify(msg);
    const ws = this.connections.get(projectId);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(json);
    } else {
      const queue = this.offlineQueues.get(projectId) ?? [];
      queue.push(json);
      this.offlineQueues.set(projectId, queue);
    }
  }

  /**
   * Send a push and resolve with what the server did with it. A push that
   * cannot go out now is queued for replay and reported unconfirmed at once:
   * its eventual ack has no waiter, and the sync request that precedes the
   * replay re-requests anything the server lacks. A server that does not ack
   * stores what it receives, so its pushes resolve stored once sent.
   */
  private sendAwaitingAck(
    projectId: string,
    msg: FileContentPushMessage | FileContentBatchPushMessage,
    files: PushedFileRef[],
  ): Promise<ProjectFilePushOutcome> {
    const requestId = msg.requestId!;
    const syncIds = files.map(f => f.syncId);
    this.unconfirmedPushes.supersede(projectId, syncIds);
    const ws = this.connections.get(projectId);
    if (ws?.readyState !== WebSocket.OPEN) {
      this.sendOrQueue(projectId, msg);
      return Promise.resolve({ stored: [], rejected: [], unconfirmed: syncIds });
    }
    const pushAck = this.pushAckSockets.get(ws);
    if (pushAck === false) {
      ws.send(JSON.stringify(msg));
      return Promise.resolve({ stored: syncIds, rejected: [], unconfirmed: [] });
    }
    // Not known yet: notePushAckSupport settles it, or arms the timeout.
    return new Promise((resolve) => {
      const pending: PendingPush = { projectId, ws, files, resolve, timer: undefined };
      this.pendingPushes.set(requestId, pending);
      if (pushAck) this.armAckTimeout(requestId, pending);
      ws.send(JSON.stringify(msg));
    });
  }

  private armAckTimeout(requestId: string, pending: PendingPush): void {
    pending.timer = setTimeout(() => this.settleUnanswered(requestId), PUSH_ACK_TIMEOUT_MS);
  }

  private handlePushAck(ack: FileContentPushAckMessage): void {
    const pending = ack.requestId ? this.pendingPushes.get(ack.requestId) : undefined;
    if (!pending) return; // Replayed from the offline queue, or already timed out.
    this.pendingPushes.delete(ack.requestId!);
    clearTimeout(pending.timer);
    // A file is rejected only when the server says so.
    const rejectedIds = new Set(ack.rejected.map(r => r.syncId));
    pending.resolve({
      stored: pending.files.map(f => f.syncId).filter(id => !rejectedIds.has(id)),
      rejected: ack.rejected,
      unconfirmed: [],
    });
  }

  /**
   * Record whether this socket's server acks pushes. A pre-ack server's
   * pending pushes are stored; an acking server's now wait a bounded time.
   */
  private notePushAckSupport(projectId: string, pushAck: boolean): void {
    const ws = this.connections.get(projectId);
    if (!ws || this.pushAckSockets.has(ws)) return;
    this.pushAckSockets.set(ws, pushAck);
    for (const [requestId, pending] of this.pendingPushes) {
      if (pending.ws !== ws) continue;
      if (pushAck) this.armAckTimeout(requestId, pending);
      else this.settleUnanswered(requestId);
    }
  }

  /**
   * A sent push that will get no ack. On a pre-ack server that means stored.
   * Anywhere else it may or may not have landed, so it stays unconfirmed until
   * the next sync response says what the server holds.
   */
  private settleUnanswered(requestId: string): void {
    const pending = this.pendingPushes.get(requestId);
    if (!pending) return;
    this.pendingPushes.delete(requestId);
    clearTimeout(pending.timer);
    const syncIds = pending.files.map(f => f.syncId);
    if (this.pushAckSockets.get(pending.ws) === false) {
      pending.resolve({ stored: syncIds, rejected: [], unconfirmed: [] });
      return;
    }
    this.unconfirmedPushes.add(pending.projectId, pending.files);
    pending.resolve({ stored: [], rejected: [], unconfirmed: syncIds });
  }

  /** A closed socket will never deliver the acks it owed. */
  private settlePendingPushes(projectId: string): void {
    for (const [requestId, pending] of this.pendingPushes) {
      if (pending.projectId === projectId) this.settleUnanswered(requestId);
    }
  }

  private replayOfflineQueue(projectId: string): void {
    const queue = this.offlineQueues.get(projectId);
    if (!queue?.length) return;

    const ws = this.connections.get(projectId);
    if (ws?.readyState !== WebSocket.OPEN) return;

    // console.log(`[ProjectSync] Replaying ${queue.length} queued messages for ${projectId}`);
    for (const json of queue) {
      ws.send(json);
    }
    this.offlineQueues.delete(projectId);
  }

  private scheduleReconnect(projectId: string): void {
    const attempts = this.reconnectAttempts.get(projectId) ?? 0;
    const delay = Math.min(2000 * Math.pow(2, attempts), 30000);
    this.reconnectAttempts.set(projectId, attempts + 1);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(projectId);
      const getManifest = this.manifestProviders.get(projectId);
      if (getManifest) {
        this.connect(projectId, getManifest);
      }
    }, delay);
    this.reconnectTimers.set(projectId, timer);
  }

  private notifyStatus(projectId: string, connected: boolean): void {
    for (const cb of this.onStatusCallbacks) {
      cb(projectId, connected);
    }
  }

  private async sha256(text: string): Promise<string> {
    const data = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
