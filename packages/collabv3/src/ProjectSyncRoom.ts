/**
 * PersonalProjectSyncRoom Durable Object
 *
 * Stores all .md file content for a (user + project) pair.
 * One WebSocket connection handles everything: batch diffs, incremental pushes, mobile prefetch.
 *
 * Two-phase content model:
 * - Phase 1 (markdown): File stored as encrypted markdown text. Cheap to sync, easy to batch.
 * - Phase 2 (Yjs): When opened for editing, a Y.Doc is created for CRDT merge. All edits flow through Yjs.
 *
 * The DO acts as a dumb encrypted relay -- it never reads file content.
 * Room ID pattern: org:{orgId}:user:{userId}:project:{projectId}
 *
 * SECURITY: This room is single-user (personal sync). All connected WebSockets belong to
 * the same user's devices. The canonical owner userId is stored on first connection and
 * enforced on all subsequent connections. No per-message userId checks are needed.
 * If this is ever extended to multi-user project sync, add sender validation on all
 * mutation handlers.
 */

import type {
  Env,
  ProjectSyncClientMessage,
  ProjectSyncServerMessage,
  ProjectSyncManifestEntry,
  ProjectSyncFileEntry,
  ProjectSyncYjsUpdate,
  FileContentPushMessage,
  AuthContext,
} from './types';
import { createLogger } from './logger';
import { track } from './analytics';

const log = createLogger('PersonalProjectSyncRoom');

/** TTL: 90 days (files are long-lived) */
const PROJECT_SYNC_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Max Yjs updates to return per file in sync response */
const YJS_UPDATES_BATCH_SIZE = 200;

/** Overlap: keep some updates after a snapshot for late arrivals */
const COMPACTION_OVERLAP = 50;

interface ConnectionState {
  auth: AuthContext;
  synced: boolean;
  connectionId: string;
}

// WebSocket tag prefixes for hibernation recovery
const TAG_USER = 'user:';
const TAG_ORG = 'org:';
const TAG_CONN = 'conn:';

let connectionCounter = 0;

export class PersonalProjectSyncRoom implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private connections: Map<WebSocket, ConnectionState> = new Map();
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.restoreConnectionsFromHibernation();
  }

  private restoreConnectionsFromHibernation(): void {
    const webSockets = this.state.getWebSockets();
    for (const ws of webSockets) {
      const tags = this.state.getTags(ws);
      const userTag = tags.find(t => t.startsWith(TAG_USER));
      const orgTag = tags.find(t => t.startsWith(TAG_ORG));
      const connTag = tags.find(t => t.startsWith(TAG_CONN));
      if (userTag && orgTag) {
        const userId = userTag.slice(TAG_USER.length);
        const orgId = orgTag.slice(TAG_ORG.length);
        const connectionId = connTag ? connTag.slice(TAG_CONN.length) : `restored-${connectionCounter++}`;
        this.connections.set(ws, {
          auth: { userId, orgId },
          synced: true,
          connectionId,
        });
      }
    }
    if (webSockets.length > 0) {
      log.info(`Restored ${webSockets.length} connections from hibernation`);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const sql = this.state.storage.sql;

    sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        sync_id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        encrypted_path TEXT,
        path_iv TEXT,
        encrypted_title TEXT,
        title_iv TEXT,
        encrypted_content TEXT,
        content_iv TEXT,
        content_hash TEXT,
        yjs_state BLOB,
        yjs_iv TEXT,
        yjs_seq INTEGER DEFAULT 0,
        has_yjs INTEGER DEFAULT 0,
        last_modified_at INTEGER,
        synced_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        updated_at INTEGER DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE IF NOT EXISTS yjs_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id TEXT NOT NULL REFERENCES files(sync_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        encrypted_update TEXT NOT NULL,
        iv TEXT NOT NULL,
        sender_id TEXT,
        created_at INTEGER DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_yjs_updates_sync_seq ON yjs_updates(sync_id, sequence);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER DEFAULT (unixepoch() * 1000)
      );
    `);

    // Bootstrap TTL alarm
    const existingAlarm = await this.state.storage.getAlarm();
    if (!existingAlarm) {
      const hasData = sql.exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM files`
      ).toArray()[0]?.count ?? 0;

      if (hasData > 0 && this.connections.size === 0) {
        await this.scheduleExpiryAlarm();
      }
    }

    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();

    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname.endsWith('/status')) {
      return this.handleStatusRequest();
    }

    if (url.pathname.endsWith('/delete-account') && request.method === 'DELETE') {
      return this.handleDeleteAccount();
    }

    // Admin cleanup probe -- returns last activity + whether storage holds data.
    // Path includes /internal/ so the public /sync/ router blocks external access.
    if (url.pathname.endsWith('/internal/staleness') && request.method === 'GET') {
      return this.handleStaleness();
    }

    return new Response('Expected WebSocket', { status: 400 });
  }

  /**
   * Staleness probe for the admin cleanup endpoint.
   */
  private handleStaleness(): Response {
    const sql = this.state.storage.sql;
    const updatedAtRow = sql.exec<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'updated_at'`
    ).toArray()[0];
    const fileCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM files`
    ).toArray()[0]?.count ?? 0;
    return new Response(JSON.stringify({
      updatedAt: updatedAtRow ? parseInt(updatedAtRow.value, 10) : null,
      hasData: fileCount > 0,
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const auth = this.parseAuth(request);
    if (!auth) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Defense-in-depth: verify the connecting user matches the room's canonical owner.
    // The router (index.ts) already validates the JWT, but this guards against future
    // code paths that might bypass the router.
    const ownerCheck = await this.validateRoomOwner(auth);
    if (!ownerCheck.ok) {
      log.warn('Room owner mismatch:', ownerCheck.reason);
      return new Response('Unauthorized: room owner mismatch', { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    await this.state.storage.deleteAlarm();

    const connectionId = `${auth.userId}-${Date.now()}-${connectionCounter++}`;
    const tags = [
      `${TAG_USER}${auth.userId}`,
      `${TAG_ORG}${auth.orgId}`,
      `${TAG_CONN}${connectionId}`,
    ];
    this.state.acceptWebSocket(server, tags);

    this.connections.set(server, {
      auth,
      synced: false,
      connectionId,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private parseAuth(request: Request): AuthContext | null {
    const url = new URL(request.url);
    const userId = url.searchParams.get('user_id');
    const orgId = url.searchParams.get('org_id');
    if (userId && orgId) {
      return { userId, orgId };
    }
    return null;
  }

  /**
   * Validate that the connecting user is the canonical owner of this room.
   * On first connection, stores the userId/orgId. On subsequent connections,
   * rejects if they don't match.
   */
  private async validateRoomOwner(auth: AuthContext): Promise<{ ok: true } | { ok: false; reason: string }> {
    const sql = this.state.storage.sql;

    const ownerRow = sql.exec<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'owner_user_id'`
    ).toArray()[0];

    const orgRow = sql.exec<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'owner_org_id'`
    ).toArray()[0];

    if (!ownerRow) {
      // First connection -- store canonical owner
      this.setMetadataValue('owner_user_id', auth.userId);
      this.setMetadataValue('owner_org_id', auth.orgId);
      return { ok: true };
    }

    if (ownerRow.value !== auth.userId) {
      return { ok: false, reason: `userId ${auth.userId} does not match owner ${ownerRow.value}` };
    }

    if (orgRow && orgRow.value !== auth.orgId) {
      return { ok: false, reason: `orgId ${auth.orgId} does not match owner org ${orgRow.value}` };
    }

    return { ok: true };
  }

  async webSocketMessage(ws: WebSocket, data: ArrayBuffer | string): Promise<void> {
    await this.ensureInitialized();

    const connState = this.connections.get(ws);
    if (!connState) {
      ws.close(4001, 'Unknown connection');
      return;
    }

    try {
      const rawData = typeof data === 'string' ? data : new TextDecoder().decode(data);
      const message: ProjectSyncClientMessage = JSON.parse(rawData);

      switch (message.type) {
        case 'projectSyncRequest':
          await this.handleProjectSyncRequest(ws, connState, message.files);
          break;

        case 'fileContentPush':
          await this.handleFileContentPush(ws, connState, message);
          break;

        case 'fileContentBatchPush':
          await this.handleFileContentBatchPush(ws, connState, message.files);
          break;

        case 'fileDelete':
          await this.handleFileDelete(ws, connState, message.syncId);
          break;

        case 'fileYjsInit':
          await this.handleFileYjsInit(ws, connState, message.syncId, message.encryptedSnapshot, message.iv);
          break;

        case 'fileYjsUpdate':
          await this.handleFileYjsUpdate(ws, connState, message.syncId, message.encryptedUpdate, message.iv);
          break;

        case 'fileYjsCompact':
          await this.handleFileYjsCompact(ws, connState, message.syncId, message.encryptedSnapshot, message.iv, message.replacesUpTo);
          break;

        default:
          log.warn('Unknown message type:', (message as { type: string }).type);
          this.sendError(ws, 'unknown_message_type', 'Unknown message type');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error('Error handling message:', errorMessage);
      this.sendError(ws, 'parse_error', `Failed to parse message: ${errorMessage}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Project sync request -- diff client manifest against server state
  // ---------------------------------------------------------------------------

  private async handleProjectSyncRequest(
    ws: WebSocket,
    connState: ConnectionState,
    clientManifest: ProjectSyncManifestEntry[]
  ): Promise<void> {
    const sql = this.state.storage.sql;

    // Build a map of client files for quick lookup
    const clientMap = new Map<string, ProjectSyncManifestEntry>();
    for (const entry of clientManifest) {
      clientMap.set(entry.syncId, entry);
    }

    // Get all server files
    const serverRows = sql.exec<{
      sync_id: string;
      encrypted_content: string | null;
      content_iv: string | null;
      content_hash: string | null;
      encrypted_path: string | null;
      path_iv: string | null;
      encrypted_title: string | null;
      title_iv: string | null;
      last_modified_at: number | null;
      has_yjs: number;
      yjs_seq: number;
    }>(
      `SELECT sync_id, encrypted_content, content_iv, content_hash,
              encrypted_path, path_iv, encrypted_title, title_iv,
              last_modified_at, has_yjs, yjs_seq
       FROM files`
    ).toArray();

    const updatedFiles: ProjectSyncFileEntry[] = [];
    const newFiles: ProjectSyncFileEntry[] = [];
    const needFromClient: string[] = [];
    const deletedSyncIds: string[] = [];
    const yjsUpdates: ProjectSyncYjsUpdate[] = [];

    const serverSyncIds = new Set<string>();

    for (const row of serverRows) {
      serverSyncIds.add(row.sync_id);
      const clientEntry = clientMap.get(row.sync_id);

      if (!clientEntry) {
        // Server has file, client doesn't -> send to client as new
        if (row.encrypted_content) {
          newFiles.push(this.rowToFileEntry(row));
        }
        continue;
      }

      // Both have the file -- compare
      if (row.content_hash && clientEntry.contentHash !== row.content_hash) {
        // Content differs
        if (row.last_modified_at && row.last_modified_at > clientEntry.lastModifiedAt) {
          // Server is newer -> send to client
          if (row.encrypted_content) {
            updatedFiles.push(this.rowToFileEntry(row));
          }
        } else {
          // Client is newer -> request from client
          needFromClient.push(row.sync_id);
        }
      }

      // If file has Yjs and client is behind on sequence, send pending updates
      if (row.has_yjs && clientEntry.hasYjs && clientEntry.yjsSeq < row.yjs_seq) {
        const updates = sql.exec<{
          sync_id: string;
          sequence: number;
          encrypted_update: string;
          iv: string;
        }>(
          `SELECT sync_id, sequence, encrypted_update, iv
           FROM yjs_updates
           WHERE sync_id = ? AND sequence > ?
           ORDER BY sequence ASC
           LIMIT ?`,
          row.sync_id,
          clientEntry.yjsSeq,
          YJS_UPDATES_BATCH_SIZE
        ).toArray();

        for (const update of updates) {
          yjsUpdates.push({
            syncId: update.sync_id,
            encryptedUpdate: update.encrypted_update,
            iv: update.iv,
            sequence: update.sequence,
          });
        }
      }
    }

    // Files client has that server doesn't -> request from client
    for (const [syncId] of clientMap) {
      if (!serverSyncIds.has(syncId)) {
        needFromClient.push(syncId);
      }
    }

    // Purge orphaned server files whose syncIds the client doesn't recognize.
    // This handles migration from UUID-based syncIds to path-based SHA-256 syncIds:
    // old entries remain on the server under stale keys and must be cleaned up.
    //
    // IMPORTANT: Only run orphan cleanup when the client sent a non-empty manifest.
    // An empty manifest means this is a new device (e.g. iOS) doing its initial sync,
    // not a desktop client that migrated syncId formats. Without this guard, a new
    // device connecting with 0 files would cause ALL server files to be deleted as
    // "orphans", then filtered out of the response -- the new device gets nothing.
    const orphanedSyncIds: string[] = [];
    if (clientManifest.length > 0) {
      for (const row of serverRows) {
        if (!clientMap.has(row.sync_id)) {
          orphanedSyncIds.push(row.sync_id);
        }
      }
      if (orphanedSyncIds.length > 0) {
        for (const syncId of orphanedSyncIds) {
          sql.exec(`DELETE FROM files WHERE sync_id = ?`, syncId);
          sql.exec(`DELETE FROM yjs_updates WHERE sync_id = ?`, syncId);
        }
        log.info(`Purged ${orphanedSyncIds.length} orphaned files (syncId migration cleanup)`);
      }
    }

    // Check for deleted files (files in server's deleted_files tracking)
    const deletedRows = sql.exec<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'deleted_sync_ids'`
    ).toArray()[0];

    if (deletedRows?.value) {
      try {
        const allDeleted: string[] = JSON.parse(deletedRows.value);
        for (const deletedId of allDeleted) {
          if (clientMap.has(deletedId)) {
            deletedSyncIds.push(deletedId);
          }
        }
      } catch {
        // Ignore parse errors in deleted list
      }
    }

    // Filter out any orphaned files from the response (already purged above)
    const orphanedSet = new Set(orphanedSyncIds);
    const cleanNewFiles = newFiles.filter(f => !orphanedSet.has(f.syncId));

    const response: ProjectSyncServerMessage = {
      type: 'projectSyncResponse',
      updatedFiles,
      yjsUpdates,
      newFiles: cleanNewFiles,
      needFromClient,
      deletedSyncIds,
    };

    ws.send(JSON.stringify(response));
    connState.synced = true;

    this.setMetadataValue('updated_at', String(Date.now()));
  }

  // ---------------------------------------------------------------------------
  // File content push (single file)
  // ---------------------------------------------------------------------------

  private async handleFileContentPush(
    ws: WebSocket,
    connState: ConnectionState,
    msg: Omit<FileContentPushMessage, 'type'>
  ): Promise<void> {
    const sql = this.state.storage.sql;
    const now = Date.now();

    sql.exec(
      `INSERT INTO files (sync_id, relative_path, encrypted_path, path_iv, encrypted_title, title_iv,
                          encrypted_content, content_iv, content_hash, last_modified_at, synced_at, updated_at)
       VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sync_id) DO UPDATE SET
         encrypted_path = excluded.encrypted_path,
         path_iv = excluded.path_iv,
         encrypted_title = excluded.encrypted_title,
         title_iv = excluded.title_iv,
         encrypted_content = excluded.encrypted_content,
         content_iv = excluded.content_iv,
         content_hash = excluded.content_hash,
         last_modified_at = excluded.last_modified_at,
         synced_at = excluded.synced_at,
         updated_at = excluded.updated_at`,
      msg.syncId,
      msg.encryptedPath,
      msg.pathIv,
      msg.encryptedTitle,
      msg.titleIv,
      msg.encryptedContent,
      msg.contentIv,
      msg.contentHash,
      msg.lastModifiedAt,
      now,
      now
    );

    this.setMetadataValue('updated_at', String(now));

    // Analytics: track file sync
    track(this.env, 'file_sync', [connState.auth.userId, msg.syncId], [1, msg.encryptedContent.length]);

    // Broadcast to other connections
    this.broadcast(
      {
        type: 'fileContentBroadcast',
        syncId: msg.syncId,
        encryptedContent: msg.encryptedContent,
        contentIv: msg.contentIv,
        contentHash: msg.contentHash,
        encryptedPath: msg.encryptedPath,
        pathIv: msg.pathIv,
        encryptedTitle: msg.encryptedTitle,
        titleIv: msg.titleIv,
        lastModifiedAt: msg.lastModifiedAt,
        fromConnectionId: connState.connectionId,
      },
      ws
    );
  }

  // ---------------------------------------------------------------------------
  // File content batch push
  // ---------------------------------------------------------------------------

  private async handleFileContentBatchPush(
    ws: WebSocket,
    connState: ConnectionState,
    files: Omit<FileContentPushMessage, 'type'>[]
  ): Promise<void> {
    for (const file of files) {
      await this.handleFileContentPush(ws, connState, file);
    }
  }

  // ---------------------------------------------------------------------------
  // File delete
  // ---------------------------------------------------------------------------

  private async handleFileDelete(
    ws: WebSocket,
    connState: ConnectionState,
    syncId: string
  ): Promise<void> {
    const sql = this.state.storage.sql;
    const now = Date.now();

    // Delete from files table (yjs_updates cascade)
    sql.exec(`DELETE FROM files WHERE sync_id = ?`, syncId);

    // Track deletion for future sync requests
    this.addToDeletedList(syncId);

    this.setMetadataValue('updated_at', String(now));

    this.broadcast(
      {
        type: 'fileDeleteBroadcast',
        syncId,
        fromConnectionId: connState.connectionId,
      },
      ws
    );
  }

  // ---------------------------------------------------------------------------
  // Yjs init -- upgrade file from markdown to Yjs phase
  // ---------------------------------------------------------------------------

  private async handleFileYjsInit(
    ws: WebSocket,
    connState: ConnectionState,
    syncId: string,
    encryptedSnapshot: string,
    iv: string
  ): Promise<void> {
    const sql = this.state.storage.sql;
    const now = Date.now();

    // Verify file exists
    const exists = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM files WHERE sync_id = ?`,
      syncId
    ).toArray()[0]?.count ?? 0;

    if (!exists) {
      this.sendError(ws, 'file_not_found', `File ${syncId} not found`);
      return;
    }

    sql.exec(
      `UPDATE files SET has_yjs = 1, yjs_state = ?, yjs_iv = ?, yjs_seq = 0, updated_at = ?
       WHERE sync_id = ?`,
      encryptedSnapshot,
      iv,
      now,
      syncId
    );

    this.setMetadataValue('updated_at', String(now));

    this.broadcast(
      {
        type: 'fileYjsInitBroadcast',
        syncId,
        fromConnectionId: connState.connectionId,
      },
      ws
    );
  }

  // ---------------------------------------------------------------------------
  // Yjs update
  // ---------------------------------------------------------------------------

  private async handleFileYjsUpdate(
    ws: WebSocket,
    connState: ConnectionState,
    syncId: string,
    encryptedUpdate: string,
    iv: string
  ): Promise<void> {
    const sql = this.state.storage.sql;
    const now = Date.now();

    // Get current yjs_seq and increment
    const row = sql.exec<{ yjs_seq: number; has_yjs: number }>(
      `SELECT yjs_seq, has_yjs FROM files WHERE sync_id = ?`,
      syncId
    ).toArray()[0];

    if (!row || !row.has_yjs) {
      this.sendError(ws, 'not_yjs_phase', `File ${syncId} is not in Yjs phase`);
      return;
    }

    const newSeq = row.yjs_seq + 1;

    // Append update
    sql.exec(
      `INSERT INTO yjs_updates (sync_id, sequence, encrypted_update, iv, sender_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      syncId,
      newSeq,
      encryptedUpdate,
      iv,
      connState.auth.userId,
      now
    );

    // Update file sequence
    sql.exec(
      `UPDATE files SET yjs_seq = ?, updated_at = ? WHERE sync_id = ?`,
      newSeq,
      now,
      syncId
    );

    this.setMetadataValue('updated_at', String(now));

    this.broadcast(
      {
        type: 'fileYjsUpdateBroadcast',
        syncId,
        encryptedUpdate,
        iv,
        sequence: newSeq,
        fromConnectionId: connState.connectionId,
      },
      ws
    );
  }

  // ---------------------------------------------------------------------------
  // Yjs compaction
  // ---------------------------------------------------------------------------

  private async handleFileYjsCompact(
    ws: WebSocket,
    _connState: ConnectionState,
    syncId: string,
    encryptedSnapshot: string,
    iv: string,
    replacesUpTo: number
  ): Promise<void> {
    const sql = this.state.storage.sql;
    const now = Date.now();

    // Update the snapshot
    sql.exec(
      `UPDATE files SET yjs_state = ?, yjs_iv = ?, updated_at = ? WHERE sync_id = ?`,
      encryptedSnapshot,
      iv,
      now,
      syncId
    );

    // Prune old updates, keeping some overlap for late arrivals
    const pruneUpTo = replacesUpTo - COMPACTION_OVERLAP;
    if (pruneUpTo > 0) {
      sql.exec(
        `DELETE FROM yjs_updates WHERE sync_id = ? AND sequence <= ?`,
        syncId,
        pruneUpTo
      );
    }

    this.setMetadataValue('updated_at', String(now));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private rowToFileEntry(row: {
    sync_id: string;
    encrypted_content: string | null;
    content_iv: string | null;
    content_hash: string | null;
    encrypted_path: string | null;
    path_iv: string | null;
    encrypted_title: string | null;
    title_iv: string | null;
    last_modified_at: number | null;
    has_yjs: number;
  }): ProjectSyncFileEntry {
    return {
      syncId: row.sync_id,
      encryptedContent: row.encrypted_content ?? '',
      contentIv: row.content_iv ?? '',
      contentHash: row.content_hash ?? '',
      encryptedPath: row.encrypted_path ?? '',
      pathIv: row.path_iv ?? '',
      encryptedTitle: row.encrypted_title ?? '',
      titleIv: row.title_iv ?? '',
      lastModifiedAt: row.last_modified_at ?? 0,
      hasYjs: row.has_yjs === 1,
    };
  }

  private addToDeletedList(syncId: string): void {
    const sql = this.state.storage.sql;

    const existing = sql.exec<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'deleted_sync_ids'`
    ).toArray()[0];

    let deleted: string[] = [];
    if (existing?.value) {
      try {
        deleted = JSON.parse(existing.value);
      } catch {
        deleted = [];
      }
    }

    deleted.push(syncId);

    // Cap at 1000 entries to prevent unbounded growth
    if (deleted.length > 1000) {
      deleted = deleted.slice(-1000);
    }

    this.setMetadataValue('deleted_sync_ids', JSON.stringify(deleted));
  }

  private broadcast(message: ProjectSyncServerMessage, exclude?: WebSocket): void {
    const data = JSON.stringify(message);
    for (const [ws, state] of this.connections) {
      if (ws !== exclude && state.synced) {
        try {
          ws.send(data);
        } catch (err) {
          log.error('Broadcast error:', err);
          this.connections.delete(ws);
        }
      }
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    ws.send(JSON.stringify({ type: 'error', code, message }));
  }

  private setMetadataValue(key: string, value: string): void {
    const sql = this.state.storage.sql;
    sql.exec(
      `INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)`,
      key,
      value,
      Date.now()
    );
  }

  // ---------------------------------------------------------------------------
  // WebSocket lifecycle
  // ---------------------------------------------------------------------------

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.connections.delete(ws);
    if (this.connections.size === 0) {
      await this.scheduleExpiryAlarm();
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    log.error('WebSocket error:', error);
    this.connections.delete(ws);
    if (this.connections.size === 0) {
      await this.scheduleExpiryAlarm();
    }
  }

  private async scheduleExpiryAlarm(): Promise<void> {
    if (this.connections.size > 0) return;
    await this.state.storage.setAlarm(Date.now() + PROJECT_SYNC_TTL_MS);
  }

  async alarm(): Promise<void> {
    await this.ensureInitialized();

    if (this.connections.size > 0) {
      log.info('Alarm fired but project has active connections, rescheduling');
      await this.scheduleExpiryAlarm();
      return;
    }

    const sql = this.state.storage.sql;
    const row = sql.exec<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'updated_at'`
    ).toArray()[0];

    const lastActivity = row ? parseInt(row.value, 10) : 0;
    const elapsed = Date.now() - lastActivity;

    if (elapsed < PROJECT_SYNC_TTL_MS) {
      const remaining = PROJECT_SYNC_TTL_MS - elapsed;
      await this.state.storage.setAlarm(Date.now() + remaining);
      log.info('Alarm fired early, rescheduling for', remaining, 'ms');
      return;
    }

    log.info('ProjectSync TTL expired, deleting data. Last activity:', lastActivity);
    sql.exec(`DELETE FROM files`);
    sql.exec(`DELETE FROM yjs_updates`);
    sql.exec(`DELETE FROM metadata`);
  }

  // ---------------------------------------------------------------------------
  // REST endpoints
  // ---------------------------------------------------------------------------

  private async handleDeleteAccount(): Promise<Response> {
    // Close all WebSocket connections first so no writes race the delete.
    for (const [ws] of this.connections) {
      try {
        ws.close(4003, 'Account deleted');
      } catch {
        // Connection may already be closed
      }
    }
    this.connections.clear();

    // Bulk-drop all storage. Per-table `DELETE FROM` previously hit the DO
    // storage operation timeout on large project syncs and reset the DO mid-delete.
    await this.state.storage.deleteAll();

    return new Response(JSON.stringify({ deleted: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleStatusRequest(): Response {
    const sql = this.state.storage.sql;

    const fileCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM files`
    ).toArray()[0]?.count ?? 0;

    const yjsFileCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM files WHERE has_yjs = 1`
    ).toArray()[0]?.count ?? 0;

    const yjsUpdateCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM yjs_updates`
    ).toArray()[0]?.count ?? 0;

    return new Response(
      JSON.stringify({
        roomId: this.state.id.toString(),
        connections: this.connections.size,
        fileCount,
        yjsFileCount,
        yjsUpdateCount,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}
