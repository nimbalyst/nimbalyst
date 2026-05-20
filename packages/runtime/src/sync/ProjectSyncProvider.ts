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
 *   - Single WebSocket per project: org:{orgId}:user:{userId}:project:{projectId}
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
} from '@nimbalyst/collab-protocol';


export interface ProjectSyncConfig {
  serverUrl: string;
  getJwt: () => Promise<string>;
  orgId: string;
  userId: string;
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

  // Event callbacks
  private onFileUpdateCallbacks = new Set<(projectId: string, file: ProjectSyncFileUpdate) => void>();
  private onFileDeleteCallbacks = new Set<(projectId: string, syncId: string) => void>();
  private onSyncResponseCallbacks = new Set<(projectId: string, response: ProjectSyncResponse) => void>();
  private onStatusCallbacks = new Set<(projectId: string, connected: boolean) => void>();

  constructor(config: ProjectSyncConfig) {
    this.config = config;
  }

  // MARK: - Connection

  async connect(projectId: string, manifest: ProjectSyncManifestFile[]): Promise<void> {
    if (this.connections.has(projectId)) return;

    try {
      const jwt = await this.config.getJwt();
      const roomId = `org:${this.config.orgId}:user:${this.config.userId}:project:${projectId}`;
      const wsBase = this.config.serverUrl
        .replace('https://', 'wss://')
        .replace('http://', 'ws://')
        .replace(/\/+$/, '');

      const encodedToken = encodeURIComponent(jwt);
      const url = `${wsBase}/sync/${roomId}?token=${encodedToken}`;

      const ws = new WebSocket(url);
      this.connections.set(projectId, ws);

      ws.onopen = () => {
        this.reconnectAttempts.set(projectId, 0);
        this.notifyStatus(projectId, true);
        this.sendSyncRequest(projectId, manifest);
        this.replayOfflineQueue(projectId);
      };

      ws.onmessage = (event) => {
        this.handleMessage(projectId, event.data as string);
      };

      ws.onclose = () => {
        this.connections.delete(projectId);
        this.notifyStatus(projectId, false);
        this.scheduleReconnect(projectId, manifest);
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

    const ws = this.connections.get(projectId);
    if (ws) {
      ws.onclose = null; // Prevent reconnect
      ws.close();
      this.connections.delete(projectId);
    }
    this.notifyStatus(projectId, false);
  }

  disconnectAll(): void {
    for (const projectId of [...this.connections.keys()]) {
      this.disconnect(projectId);
    }
    this.offlineQueues.clear();
  }

  isConnected(projectId: string): boolean {
    const ws = this.connections.get(projectId);
    return ws?.readyState === WebSocket.OPEN;
  }

  // MARK: - Sync Request

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
      case 'projectSyncResponse':
        await this.handleSyncResponse(projectId, JSON.parse(raw) as ProjectSyncResponseMessage);
        break;
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
      case 'error': {
        const err = JSON.parse(raw) as { message: string };
        console.error(`[ProjectSync] Server error for ${projectId}:`, err.message);
        break;
      }
    }
  }

  private async handleSyncResponse(projectId: string, msg: ProjectSyncResponseMessage): Promise<void> {
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
  ): Promise<void> {
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
    };
    this.sendOrQueue(projectId, msg);
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
  ): Promise<void> {
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
    };
    this.sendOrQueue(projectId, msg);
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

  private scheduleReconnect(projectId: string, manifest: ProjectSyncManifestFile[]): void {
    const attempts = this.reconnectAttempts.get(projectId) ?? 0;
    const delay = Math.min(2000 * Math.pow(2, attempts), 30000);
    this.reconnectAttempts.set(projectId, attempts + 1);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(projectId);
      this.connect(projectId, manifest);
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
