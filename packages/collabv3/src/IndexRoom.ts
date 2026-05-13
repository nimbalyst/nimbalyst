/**
 * PersonalIndexRoom Durable Object
 *
 * Manages the session index for a user - provides fast session list
 * on mobile startup and broadcasts index updates across devices.
 */

import type {
  Env,
  ClientMessage,
  ServerMessage,
  SessionIndexEntry,
  ProjectIndexEntry,
  FileIndexEntry,
  IndexSyncResponseMessage,
  AuthContext,
  DeviceInfo,
  DevicesListMessage,
  DeviceJoinedMessage,
  DeviceLeftMessage,
  EncryptedCreateSessionRequest,
  EncryptedCreateSessionResponse,
  CreateSessionRequestBroadcastMessage,
  CreateSessionResponseBroadcastMessage,
  SessionControlMessage,
  SessionControlBroadcastMessage,
  RegisterPushTokenMessage,
  UnregisterPushTokenMessage,
  RequestMobilePushMessage,
  ProjectConfigUpdateMessage,
  EncryptedSettingsPayload,
  SettingsSyncBroadcastMessage,
} from './types';
import { createLogger } from './logger';

const log = createLogger('PersonalIndexRoom');

/** Session TTL: 30 days in milliseconds */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Device TTL: 90 days - remove stored devices not seen in this period */
const DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** How often PersonalIndexRoom scans for expired entries: every 24 hours */
const INDEX_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface ConnectionState {
  auth: AuthContext;
  synced: boolean;
  device?: DeviceInfo;
}

// WebSocket tag prefixes for hibernation recovery
const TAG_USER = 'user:';
const TAG_ORG = 'org:';
const TAG_DEVICE = 'device:';

export class PersonalIndexRoom implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  // Note: This map is rebuilt after hibernation using getWebSockets() and tags
  private connections: Map<WebSocket, ConnectionState> = new Map();
  private initialized = false;
  // Devices loaded from DO storage during initialization, used as fallback
  // for connections that haven't re-announced after hibernation recovery
  private storedDevices: Map<string, DeviceInfo> = new Map();

  // APNs JWT cache - JWTs are valid for 1 hour, we refresh every 50 minutes
  private cachedAPNsJWT: string | null = null;
  private cachedAPNsJWTExpiry: number = 0;
  private cachedAPNsKey: CryptoKey | null = null;
  private cachedFCMAccessToken: string | null = null;
  private cachedFCMAccessTokenExpiry: number = 0;
  private cachedFCMKey: CryptoKey | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Restore connections from hibernation
    this.restoreConnectionsFromHibernation();
  }

  /**
   * Restore connection state from WebSocket tags after hibernation.
   * Device info is restored separately in ensureInitialized() from DO storage
   * and used as a fallback in getConnectedDevices() until clients re-announce.
   */
  private restoreConnectionsFromHibernation(): void {
    const webSockets = this.state.getWebSockets();
    for (const ws of webSockets) {
      const tags = this.state.getTags(ws);
      const userTag = tags.find(t => t.startsWith(TAG_USER));
      const orgTag = tags.find(t => t.startsWith(TAG_ORG));

      if (userTag && orgTag) {
        const userId = userTag.slice(TAG_USER.length);
        const orgId = orgTag.slice(TAG_ORG.length);

        this.connections.set(ws, {
          auth: { userId, orgId },
          synced: true,
        });
      }
    }
  }

  /**
   * Initialize SQLite schema on first access
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const sql = this.state.storage.sql;

    // Session index table
    // Note: project_id column stores encrypted value (encryptedProjectId)
    sql.exec(`
      CREATE TABLE IF NOT EXISTS session_index (
        session_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_id_iv TEXT,
        title TEXT,
        encrypted_title TEXT,
        title_iv TEXT,
        provider TEXT,
        model TEXT,
        mode TEXT,
        message_count INTEGER DEFAULT 0,
        last_message_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_updated ON session_index(updated_at DESC);
    `);

    // Migration: Add encrypted title columns if they don't exist (for existing databases)
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN encrypted_title TEXT`);
    } catch {
      // Column already exists
    }
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN title_iv TEXT`);
    } catch {
      // Column already exists
    }
    // Migration: Add project_id_iv column for encrypted project_id
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN project_id_iv TEXT`);
    } catch {
      // Column already exists
    }
    // Migration: Add is_executing column for session execution state
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN is_executing INTEGER DEFAULT 0`);
    } catch {
      // Column already exists
    }
    // Migration: Add last_read_at column for cross-device unread tracking
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN last_read_at INTEGER`);
    } catch {
      // Column already exists
    }
    // Migration: Add encrypted client metadata (opaque blob for client-only display data)
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN encrypted_client_metadata TEXT`);
    } catch {
      // Column already exists
    }
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN client_metadata_iv TEXT`);
    } catch {
      // Column already exists
    }
    // Migration: Add parent_session_id for workstream/worktree hierarchy
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN parent_session_id TEXT`);
    } catch {
      // Column already exists
    }
    // Migration: Add session_type for workstream/worktree/blitz classification
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN session_type TEXT`);
    } catch {
      // Column already exists
    }
    // Migration: Add worktree_id for git worktree association
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN worktree_id TEXT`);
    } catch {
      // Column already exists
    }
    // Migration: Add is_archived and is_pinned
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN is_archived INTEGER DEFAULT 0`);
    } catch { /* Column already exists */ }
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN is_pinned INTEGER DEFAULT 0`);
    } catch { /* Column already exists */ }
    // Migration: Add branch tracking fields
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN branched_from_session_id TEXT`);
    } catch { /* Column already exists */ }
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN branch_point_message_id INTEGER`);
    } catch { /* Column already exists */ }
    try {
      sql.exec(`ALTER TABLE session_index ADD COLUMN branched_at INTEGER`);
    } catch { /* Column already exists */ }

    // Project index table
    // Note: project_id column stores encrypted value (encryptedProjectId)
    // Note: name column stores encrypted value (encryptedName)
    sql.exec(`
      CREATE TABLE IF NOT EXISTS project_index (
        project_id TEXT PRIMARY KEY,
        project_id_iv TEXT,
        name TEXT NOT NULL,
        name_iv TEXT,
        path TEXT,
        path_iv TEXT,
        session_count INTEGER DEFAULT 0,
        last_activity_at INTEGER,
        sync_enabled INTEGER DEFAULT 1
      );
    `);

    // Migration: Add IV columns for project_index
    try {
      sql.exec(`ALTER TABLE project_index ADD COLUMN project_id_iv TEXT`);
    } catch {
      // Column already exists
    }
    try {
      sql.exec(`ALTER TABLE project_index ADD COLUMN name_iv TEXT`);
    } catch {
      // Column already exists
    }
    try {
      sql.exec(`ALTER TABLE project_index ADD COLUMN path_iv TEXT`);
    } catch {
      // Column already exists
    }
    // Migration: Add encrypted config blob for project-level config (commands, etc.)
    try {
      sql.exec(`ALTER TABLE project_index ADD COLUMN encrypted_config TEXT`);
    } catch {
      // Column already exists
    }
    try {
      sql.exec(`ALTER TABLE project_index ADD COLUMN config_iv TEXT`);
    } catch {
      // Column already exists
    }
    // Migration: Add git remote hash for ProjectSyncRoom routing
    try {
      sql.exec(`ALTER TABLE project_index ADD COLUMN git_remote_hash TEXT`);
    } catch {
      // Column already exists
    }

    // File index table (for mobile markdown sync)
    sql.exec(`
      CREATE TABLE IF NOT EXISTS file_index (
        doc_id TEXT PRIMARY KEY,
        encrypted_project_id TEXT NOT NULL,
        project_id_iv TEXT NOT NULL,
        encrypted_relative_path TEXT NOT NULL,
        relative_path_iv TEXT NOT NULL,
        encrypted_title TEXT NOT NULL,
        title_iv TEXT NOT NULL,
        last_modified_at INTEGER NOT NULL,
        synced_at INTEGER NOT NULL
      );
    `);

    // Migration: Delete old unencrypted sessions and projects
    // Old data has NULL project_id_iv (encrypted data always has an IV)
    // First, get the session IDs so we can clean up their SessionRooms
    const oldSessions = sql.exec<{ session_id: string }>(
      `SELECT session_id FROM session_index WHERE project_id_iv IS NULL`
    ).toArray();

    // Trigger cleanup of old SessionRooms by calling them (this triggers their initialization)
    for (const { session_id } of oldSessions) {
      try {
        const sessionRoomId = this.env.SESSION_ROOM.idFromName(session_id);
        const sessionRoom = this.env.SESSION_ROOM.get(sessionRoomId);
        // Just fetch status to trigger initialization, which will clean up old data
        await sessionRoom.fetch(new Request('https://dummy/status'));
      } catch (err) {
        log.error('Failed to clean up old session room:', session_id, err);
      }
    }

    // Now delete from index
    sql.exec(`DELETE FROM session_index WHERE project_id_iv IS NULL`);
    sql.exec(`DELETE FROM project_index WHERE project_id_iv IS NULL`);

    // Ensure periodic cleanup alarm is scheduled
    const existingAlarm = await this.state.storage.getAlarm();
    if (!existingAlarm) {
      await this.state.storage.setAlarm(Date.now() + INDEX_CLEANUP_INTERVAL_MS);
    }

    // Restore stored device info for hibernation recovery.
    // After hibernation, connections are restored from tags but lose their device info.
    // Load all device:* entries from storage so getConnectedDevices() can include them
    // until clients re-announce (every 30s).
    const storedEntries = await this.state.storage.list<DeviceInfo>({ prefix: 'device:' });
    for (const [, device] of storedEntries) {
      this.storedDevices.set(device.deviceId, device);
    }

    this.initialized = true;
  }

  /**
   * Handle HTTP requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    // REST endpoints
    if (url.pathname.endsWith('/status')) {
      return await this.handleStatusRequest();
    }

    // Account deletion - return session IDs then purge all data
    if (url.pathname.endsWith('/delete-account') && request.method === 'DELETE') {
      return await this.handleDeleteAccount();
    }

    // Admin cleanup probe -- returns last activity + whether storage holds data.
    // Path includes /internal/ so the public /sync/ router blocks external access.
    if (url.pathname.endsWith('/internal/staleness') && request.method === 'GET') {
      return await this.handleStaleness();
    }

    return new Response('Expected WebSocket', { status: 400 });
  }

  /**
   * Staleness probe for the admin cleanup endpoint. Last activity is the most
   * recent of: any session_index row, any stored device's last-seen timestamp,
   * or any file_index sync. hasData is true if any of those tables has rows.
   */
  private async handleStaleness(): Promise<Response> {
    await this.ensureInitialized();
    const sql = this.state.storage.sql;
    const sessionRow = sql.exec<{ max: number | null }>(
      `SELECT MAX(updated_at) as max FROM session_index`
    ).toArray()[0];
    const fileRow = sql.exec<{ max: number | null }>(
      `SELECT MAX(synced_at) as max FROM file_index`
    ).toArray()[0];
    const sessionCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM session_index`
    ).toArray()[0]?.count ?? 0;
    const projectCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM project_index`
    ).toArray()[0]?.count ?? 0;
    const fileCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM file_index`
    ).toArray()[0]?.count ?? 0;

    let deviceMax = 0;
    let deviceCount = 0;
    for (const device of this.storedDevices.values()) {
      deviceCount++;
      const seen = device.lastSeenAt ?? device.lastActiveAt ?? 0;
      if (seen > deviceMax) deviceMax = seen;
    }

    const candidates = [sessionRow?.max ?? 0, fileRow?.max ?? 0, deviceMax];
    const updatedAt = Math.max(...candidates);
    return new Response(JSON.stringify({
      updatedAt: updatedAt > 0 ? updatedAt : null,
      hasData: sessionCount > 0 || projectCount > 0 || fileCount > 0 || deviceCount > 0,
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  /**
   * Upgrade HTTP to WebSocket
   */
  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const auth = this.parseAuth(request);
    if (!auth) {
      return new Response('Unauthorized', { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept with hibernation support, storing auth in tags for recovery
    const tags = [`${TAG_USER}${auth.userId}`];
    if (auth.orgId) {
      tags.push(`${TAG_ORG}${auth.orgId}`);
    }
    this.state.acceptWebSocket(server, tags);

    this.connections.set(server, {
      auth,
      synced: false,
    });

    // Persist owner identity so the alarm-driven GC can construct
    // SessionRoom room IDs (org:{orgId}:user:{userId}:session:{sessionId})
    // when no client is connected.
    await this.persistOwnerIdentity(auth);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Persist the owning user's identity so the alarm GC can route to
   * per-session DOs without an active connection. Cheap KV write per connect.
   */
  private async persistOwnerIdentity(auth: AuthContext): Promise<void> {
    const stored = await this.state.storage.get<{ userId: string; orgId: string }>('meta:owner');
    if (stored?.userId === auth.userId && stored?.orgId === auth.orgId) return;
    await this.state.storage.put('meta:owner', { userId: auth.userId, orgId: auth.orgId });
  }

  /**
   * Propagate session deletion to the corresponding PersonalSessionRoom DO so
   * its SQLite pages are released. Without this, expired sessions remain as
   * orphaned DOs holding all encrypted message storage.
   */
  private async purgeSessionRoom(owner: { userId: string; orgId: string }, sessionId: string): Promise<void> {
    const roomId = `org:${owner.orgId}:user:${owner.userId}:session:${sessionId}`;
    try {
      const id = this.env.SESSION_ROOM.idFromName(roomId);
      const stub = this.env.SESSION_ROOM.get(id);
      const response = await stub.fetch(
        new Request('https://internal/delete-account', { method: 'DELETE' })
      );
      if (!response.ok) {
        log.warn('SessionRoom purge failed for', sessionId, ':', response.status);
      }
    } catch (err) {
      log.error('SessionRoom purge errored for', sessionId, '(continuing):', err);
    }
  }

  /**
   * Parse auth context from query params (set by the main worker after JWT validation).
   */
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
   * Handle incoming WebSocket message
   */
  async webSocketMessage(ws: WebSocket, data: ArrayBuffer | string): Promise<void> {
    await this.ensureInitialized();

    const connState = this.connections.get(ws);
    if (!connState) {
      ws.close(4001, 'Unknown connection');
      return;
    }

    try {
      const message: ClientMessage = JSON.parse(
        typeof data === 'string' ? data : new TextDecoder().decode(data)
      );

      switch (message.type) {
        case 'indexSyncRequest':
          await this.handleIndexSyncRequest(ws, connState, message.projectId, message.since);
          break;

        case 'indexUpdate':
          await this.handleIndexUpdate(ws, connState, message.session);
          break;

        case 'indexBatchUpdate':
          await this.handleIndexBatchUpdate(ws, connState, message.sessions);
          break;

        case 'indexDelete':
          await this.handleIndexDelete(ws, connState, message.sessionId);
          break;

        case 'fileIndexUpdate':
          await this.handleFileIndexUpdate(ws, connState, message.file);
          break;

        case 'fileIndexDelete':
          await this.handleFileIndexDelete(ws, connState, message.docId);
          break;

        case 'deviceAnnounce':
          await this.handleDeviceAnnounce(ws, connState, message.device);
          break;

        case 'createSessionRequest':
          await this.handleCreateSessionRequest(ws, connState, message.request);
          break;

        case 'createSessionResponse':
          await this.handleCreateSessionResponse(ws, connState, message.response);
          break;

        case 'createWorktreeRequest':
          this.broadcast({ type: 'createWorktreeRequestBroadcast', request: message.request, fromConnectionId: this.getConnectionId(ws) }, ws);
          break;

        case 'createWorktreeResponse':
          this.broadcast({ type: 'createWorktreeResponseBroadcast', response: message.response, fromConnectionId: this.getConnectionId(ws) }, ws);
          break;

        case 'sessionControl':
          await this.handleSessionControl(ws, connState, message.message);
          break;

        case 'projectConfigUpdate':
          await this.handleProjectConfigUpdate(ws, connState, message);
          break;

        case 'settingsSync':
          await this.handleSettingsSync(ws, connState, message.settings);
          break;

        case 'registerPushToken':
          await this.handleRegisterPushToken(connState, message);
          break;

        case 'unregisterPushToken':
          await this.handleUnregisterPushToken(connState, message);
          break;

        case 'requestMobilePush':
          await this.handleRequestMobilePush(connState, message);
          break;

        case 'ping':
          // Keep-alive ping, respond with pong
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        default:
          this.sendError(ws, 'unknown_message_type', `Unknown message type`);
      }
    } catch (err) {
      log.error('Error handling message:', err);
      // log.error('Data type:', typeof data, 'length:', typeof data === 'string' ? data.length : (data as ArrayBuffer).byteLength);
      // if (typeof data === 'string' && data.length < 500) {
      //   log.error('Data:', data);
      // } else if (typeof data === 'string') {
      //   log.error('Data (first 500 chars):', data.substring(0, 500));
      // }
      this.sendError(ws, 'parse_error', 'Failed to parse message');
    }
  }

  /**
   * Handle index sync request - return session and project lists.
   * If `since` is provided, only returns entries updated after that timestamp (incremental sync).
   */
  private async handleIndexSyncRequest(
    ws: WebSocket,
    connState: ConnectionState,
    projectId?: string,
    since?: number
  ): Promise<void> {
    const sql = this.state.storage.sql;

    // Get total count first for diagnostic purposes
    const totalCount = projectId
      ? sql.exec<{ count: number }>(`SELECT COUNT(*) as count FROM session_index WHERE project_id = ?`, projectId).one().count
      : sql.exec<{ count: number }>(`SELECT COUNT(*) as count FROM session_index`).one().count;

    // Get sessions using cursor iteration instead of toArray() to avoid
    // potential undocumented row limits in the CF DO runtime.
    // When `since` is provided, only return sessions updated after that timestamp.
    const sessions: SessionIndexEntry[] = [];
    let cursor;
    if (since && !projectId) {
      cursor = sql.exec<SessionIndexRow>(`SELECT * FROM session_index WHERE updated_at > ? ORDER BY updated_at DESC`, since);
    } else if (since && projectId) {
      cursor = sql.exec<SessionIndexRow>(`SELECT * FROM session_index WHERE project_id = ? AND updated_at > ? ORDER BY updated_at DESC`, projectId, since);
    } else if (projectId) {
      cursor = sql.exec<SessionIndexRow>(`SELECT * FROM session_index WHERE project_id = ? ORDER BY updated_at DESC`, projectId);
    } else {
      cursor = sql.exec<SessionIndexRow>(`SELECT * FROM session_index ORDER BY updated_at DESC`);
    }
    for (const row of cursor) {
      sessions.push(rowToSessionEntry(row));
    }

    // Log diagnostic info about session counts
    if (!since && totalCount !== sessions.length) {
      log.warn('Session count mismatch! COUNT(*):', totalCount, 'cursor iteration length:', sessions.length);
    }
    log.info('Index sync request:', since ? `incremental since=${since},` : 'full,', 'COUNT(*)=', totalCount, 'returned=', sessions.length);

    // Get projects using cursor iteration
    // For incremental sync, only return projects with recent activity
    const projects: ProjectIndexEntry[] = [];
    const projectCursor = since
      ? sql.exec<ProjectIndexRow>(`SELECT * FROM project_index WHERE last_activity_at > ? ORDER BY last_activity_at DESC`, since)
      : sql.exec<ProjectIndexRow>(`SELECT * FROM project_index ORDER BY last_activity_at DESC`);
    for (const row of projectCursor) {
      projects.push(rowToProjectEntry(row));
    }

    // Get files using cursor iteration
    // For incremental sync, only return files modified since the cursor
    const files: FileIndexEntry[] = [];
    const fileCursor = since
      ? sql.exec<FileIndexRow>(`SELECT * FROM file_index WHERE last_modified_at > ? ORDER BY last_modified_at DESC`, since)
      : sql.exec<FileIndexRow>(`SELECT * FROM file_index ORDER BY last_modified_at DESC`);
    for (const row of fileCursor) {
      files.push(rowToFileEntry(row));
    }

    const response: IndexSyncResponseMessage = {
      type: 'indexSyncResponse',
      sessions,
      projects,
      files: files.length > 0 ? files : undefined,
      totalSessionCount: totalCount,
      since,
    };

    ws.send(JSON.stringify(response));
    connState.synced = true;
  }

  /**
   * Handle index update from desktop
   */
  private async handleIndexUpdate(
    ws: WebSocket,
    connState: ConnectionState,
    session: SessionIndexEntry
  ): Promise<void> {
    const sql = this.state.storage.sql;

    // Upsert session - titles and project_ids are always encrypted
    // For last_read_at, only update if incoming value is newer (prevents stale reads from overwriting)
    sql.exec(
      `INSERT INTO session_index
       (session_id, project_id, project_id_iv, encrypted_title, title_iv, provider, model, mode, message_count, last_message_at, created_at, updated_at, is_executing, last_read_at, encrypted_client_metadata, client_metadata_iv, parent_session_id, session_type, worktree_id, is_archived, is_pinned, branched_from_session_id, branch_point_message_id, branched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         project_id = excluded.project_id,
         project_id_iv = excluded.project_id_iv,
         encrypted_title = excluded.encrypted_title,
         title_iv = excluded.title_iv,
         provider = excluded.provider,
         model = excluded.model,
         mode = excluded.mode,
         message_count = excluded.message_count,
         last_message_at = excluded.last_message_at,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         is_executing = CASE WHEN excluded.is_executing IS NOT NULL THEN excluded.is_executing ELSE session_index.is_executing END,
         last_read_at = CASE WHEN excluded.last_read_at IS NOT NULL AND (session_index.last_read_at IS NULL OR excluded.last_read_at > session_index.last_read_at) THEN excluded.last_read_at ELSE session_index.last_read_at END,
         encrypted_client_metadata = CASE WHEN excluded.encrypted_client_metadata IS NOT NULL THEN excluded.encrypted_client_metadata ELSE session_index.encrypted_client_metadata END,
         client_metadata_iv = CASE WHEN excluded.client_metadata_iv IS NOT NULL THEN excluded.client_metadata_iv ELSE session_index.client_metadata_iv END,
         parent_session_id = CASE WHEN excluded.parent_session_id IS NOT NULL THEN excluded.parent_session_id ELSE session_index.parent_session_id END,
         session_type = CASE WHEN excluded.session_type IS NOT NULL THEN excluded.session_type ELSE session_index.session_type END,
         worktree_id = CASE WHEN excluded.worktree_id IS NOT NULL THEN excluded.worktree_id ELSE session_index.worktree_id END,
         is_archived = CASE WHEN excluded.is_archived IS NOT NULL THEN excluded.is_archived ELSE session_index.is_archived END,
         is_pinned = CASE WHEN excluded.is_pinned IS NOT NULL THEN excluded.is_pinned ELSE session_index.is_pinned END,
         branched_from_session_id = CASE WHEN excluded.branched_from_session_id IS NOT NULL THEN excluded.branched_from_session_id ELSE session_index.branched_from_session_id END,
         branch_point_message_id = CASE WHEN excluded.branch_point_message_id IS NOT NULL THEN excluded.branch_point_message_id ELSE session_index.branch_point_message_id END,
         branched_at = CASE WHEN excluded.branched_at IS NOT NULL THEN excluded.branched_at ELSE session_index.branched_at END`,
      session.sessionId,
      session.encryptedProjectId,
      session.projectIdIv,
      session.encryptedTitle ?? null,
      session.titleIv ?? null,
      session.provider,
      session.model ?? null,
      session.mode ?? null,
      session.messageCount,
      session.lastMessageAt,
      session.createdAt,
      session.updatedAt,
      session.isExecuting != null ? (session.isExecuting ? 1 : 0) : null,
      session.lastReadAt ?? null,
      session.encryptedClientMetadata ?? null,
      session.clientMetadataIv ?? null,
      session.parentSessionId ?? null,
      session.sessionType ?? null,
      session.worktreeId ?? null,
      session.isArchived != null ? (session.isArchived ? 1 : 0) : null,
      session.isPinned != null ? (session.isPinned ? 1 : 0) : null,
      session.branchedFromSessionId ?? null,
      session.branchPointMessageId ?? null,
      session.branchedAt ?? null
    );

    // Read back the effective last_read_at (may be the existing value if it was newer)
    const effectiveRow = sql.exec<{ last_read_at: number | null }>(
      `SELECT last_read_at FROM session_index WHERE session_id = ?`,
      session.sessionId
    ).toArray();
    const effectiveLastReadAt = effectiveRow[0]?.last_read_at ?? undefined;

    // Build broadcast entry with effective last_read_at
    const broadcastSession = { ...session, lastReadAt: effectiveLastReadAt ?? session.lastReadAt };

    // Update project stats (and broadcast if new project)
    // Pass encryptedProjectId as the opaque key for matching
    await this.updateProjectStats(session.encryptedProjectId, session.projectIdIv, ws);

    // Broadcast to other connections
    this.broadcast(
      {
        type: 'indexBroadcast',
        session: broadcastSession,
        fromConnectionId: this.getConnectionId(ws),
      },
      ws
    );
  }

  /**
   * Handle batch index update from desktop (efficient bulk sync)
   */
  private async handleIndexBatchUpdate(
    ws: WebSocket,
    connState: ConnectionState,
    sessions: SessionIndexEntry[]
  ): Promise<void> {
    log.debug('handleIndexBatchUpdate called with', sessions.length, 'sessions');
    const sql = this.state.storage.sql;
    const affectedProjects = new Set<string>();

    // Track affected projects with their IVs for stats update
    const affectedProjectIvs = new Map<string, string>();

    // Use Durable Objects transaction API for atomic batch update
    this.state.storage.transactionSync(() => {
      for (const session of sessions) {
        sql.exec(
          `INSERT INTO session_index
           (session_id, project_id, project_id_iv, encrypted_title, title_iv, provider, model, mode, message_count, last_message_at, created_at, updated_at, is_executing, last_read_at, parent_session_id, session_type, worktree_id, is_archived, is_pinned, branched_from_session_id, branch_point_message_id, branched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             project_id = excluded.project_id,
             project_id_iv = excluded.project_id_iv,
             encrypted_title = excluded.encrypted_title,
             title_iv = excluded.title_iv,
             provider = excluded.provider,
             model = excluded.model,
             mode = excluded.mode,
             message_count = excluded.message_count,
             last_message_at = excluded.last_message_at,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             is_executing = CASE WHEN excluded.is_executing IS NOT NULL THEN excluded.is_executing ELSE session_index.is_executing END,
             last_read_at = CASE WHEN excluded.last_read_at IS NOT NULL AND (session_index.last_read_at IS NULL OR excluded.last_read_at > session_index.last_read_at) THEN excluded.last_read_at ELSE session_index.last_read_at END,
             parent_session_id = CASE WHEN excluded.parent_session_id IS NOT NULL THEN excluded.parent_session_id ELSE session_index.parent_session_id END,
             session_type = CASE WHEN excluded.session_type IS NOT NULL THEN excluded.session_type ELSE session_index.session_type END,
             worktree_id = CASE WHEN excluded.worktree_id IS NOT NULL THEN excluded.worktree_id ELSE session_index.worktree_id END,
             is_archived = CASE WHEN excluded.is_archived IS NOT NULL THEN excluded.is_archived ELSE session_index.is_archived END,
             is_pinned = CASE WHEN excluded.is_pinned IS NOT NULL THEN excluded.is_pinned ELSE session_index.is_pinned END,
             branched_from_session_id = CASE WHEN excluded.branched_from_session_id IS NOT NULL THEN excluded.branched_from_session_id ELSE session_index.branched_from_session_id END,
             branch_point_message_id = CASE WHEN excluded.branch_point_message_id IS NOT NULL THEN excluded.branch_point_message_id ELSE session_index.branch_point_message_id END,
             branched_at = CASE WHEN excluded.branched_at IS NOT NULL THEN excluded.branched_at ELSE session_index.branched_at END`,
          session.sessionId,
          session.encryptedProjectId,
          session.projectIdIv,
          session.encryptedTitle ?? null,
          session.titleIv ?? null,
          session.provider,
          session.model ?? null,
          session.mode ?? null,
          session.messageCount,
          session.lastMessageAt,
          session.createdAt,
          session.updatedAt,
          session.isExecuting != null ? (session.isExecuting ? 1 : 0) : null,
          session.lastReadAt ?? null,
          session.parentSessionId ?? null,
          session.sessionType ?? null,
          session.worktreeId ?? null,
          session.isArchived != null ? (session.isArchived ? 1 : 0) : null,
          session.isPinned != null ? (session.isPinned ? 1 : 0) : null,
          session.branchedFromSessionId ?? null,
          session.branchPointMessageId ?? null,
          session.branchedAt ?? null
        );
        affectedProjects.add(session.encryptedProjectId);
        affectedProjectIvs.set(session.encryptedProjectId, session.projectIdIv);
      }
    });
    log.debug('Batch update committed successfully');

    // Update project stats for all affected projects (and broadcast if new projects)
    for (const encryptedProjectId of affectedProjects) {
      const projectIdIv = affectedProjectIvs.get(encryptedProjectId)!;
      await this.updateProjectStats(encryptedProjectId, projectIdIv, ws);
    }

    // Broadcast each session update to other connections
    // (They may want to update their local state)
    const connectionId = this.getConnectionId(ws);
    for (const session of sessions) {
      this.broadcast(
        {
          type: 'indexBroadcast',
          session,
          fromConnectionId: connectionId,
        },
        ws
      );
    }
  }

  /**
   * Handle session deletion from index
   */
  private async handleIndexDelete(
    ws: WebSocket,
    connState: ConnectionState,
    sessionId: string
  ): Promise<void> {
    const sql = this.state.storage.sql;

    // Get the encrypted project ID before deleting (needed for stats update)
    const session = sql.exec<{ project_id: string; project_id_iv: string }>(
      `SELECT project_id, project_id_iv FROM session_index WHERE session_id = ?`,
      sessionId
    ).toArray()[0];

    if (!session) {
      // Session not found in index, nothing to delete
      return;
    }

    // Delete from index
    sql.exec(`DELETE FROM session_index WHERE session_id = ?`, sessionId);

    // Update project stats (no broadcast needed for deletion - project already exists)
    await this.updateProjectStats(session.project_id, session.project_id_iv, ws);

    // Broadcast deletion to other connections
    this.broadcast(
      {
        type: 'indexDeleteBroadcast',
        sessionId,
        fromConnectionId: this.getConnectionId(ws),
      },
      ws
    );
  }

  /**
   * Handle file index update from desktop
   */
  private async handleFileIndexUpdate(
    ws: WebSocket,
    connState: ConnectionState,
    file: FileIndexEntry
  ): Promise<void> {
    const sql = this.state.storage.sql;

    sql.exec(
      `INSERT INTO file_index
       (doc_id, encrypted_project_id, project_id_iv, encrypted_relative_path, relative_path_iv, encrypted_title, title_iv, last_modified_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET
         encrypted_project_id = excluded.encrypted_project_id,
         project_id_iv = excluded.project_id_iv,
         encrypted_relative_path = excluded.encrypted_relative_path,
         relative_path_iv = excluded.relative_path_iv,
         encrypted_title = excluded.encrypted_title,
         title_iv = excluded.title_iv,
         last_modified_at = excluded.last_modified_at,
         synced_at = excluded.synced_at`,
      file.docId,
      file.encryptedProjectId,
      file.projectIdIv,
      file.encryptedRelativePath,
      file.relativePathIv,
      file.encryptedTitle,
      file.titleIv,
      file.lastModifiedAt,
      file.syncedAt,
    );

    // Broadcast to other connections
    this.broadcast(
      {
        type: 'fileIndexBroadcast',
        file,
        fromConnectionId: this.getConnectionId(ws),
      },
      ws
    );
  }

  /**
   * Handle file index delete from desktop
   */
  private async handleFileIndexDelete(
    ws: WebSocket,
    connState: ConnectionState,
    docId: string
  ): Promise<void> {
    const sql = this.state.storage.sql;

    sql.exec(`DELETE FROM file_index WHERE doc_id = ?`, docId);

    // Broadcast to other connections
    this.broadcast(
      {
        type: 'fileIndexDeleteBroadcast',
        docId,
        fromConnectionId: this.getConnectionId(ws),
      },
      ws
    );
  }

  /**
   * Handle device announce - register device and broadcast to others
   */
  private async handleDeviceAnnounce(
    ws: WebSocket,
    connState: ConnectionState,
    device: DeviceInfo
  ): Promise<void> {
    // Update connection state with device info
    connState.device = device;

    // Store device info in DO storage for hibernation recovery
    // Key by deviceId so it persists across reconnections
    await this.state.storage.put(`device:${device.deviceId}`, device);
    // Keep in-memory cache in sync (used as fallback in getConnectedDevices)
    this.storedDevices.set(device.deviceId, device);

    // Send current devices list to the connecting client
    const devicesList = this.getConnectedDevices();
    const listMessage: DevicesListMessage = {
      type: 'devicesList',
      devices: devicesList,
    };
    ws.send(JSON.stringify(listMessage));

    // Broadcast device joined to other connections
    const joinedMessage: DeviceJoinedMessage = {
      type: 'deviceJoined',
      device,
    };
    this.broadcast(joinedMessage, ws);
  }

  /**
   * Handle session creation request from mobile - broadcast to desktop clients
   */
  private async handleCreateSessionRequest(
    ws: WebSocket,
    connState: ConnectionState,
    request: EncryptedCreateSessionRequest
  ): Promise<void> {
    log.debug('Received createSessionRequest:', request.requestId);

    // Broadcast the request to all other connections (desktop will pick it up)
    const broadcastMessage: CreateSessionRequestBroadcastMessage = {
      type: 'createSessionRequestBroadcast',
      request,
      fromConnectionId: this.getConnectionId(ws),
    };
    this.broadcast(broadcastMessage, ws);

    log.debug('Broadcast createSessionRequest to', this.connections.size - 1, 'other connections');
  }

  /**
   * Handle session creation response from desktop - broadcast to mobile clients
   */
  private async handleCreateSessionResponse(
    ws: WebSocket,
    connState: ConnectionState,
    response: EncryptedCreateSessionResponse
  ): Promise<void> {
    log.debug('Received createSessionResponse:', response.requestId, 'success:', response.success);

    // Broadcast the response to all other connections (mobile will pick it up)
    const broadcastMessage: CreateSessionResponseBroadcastMessage = {
      type: 'createSessionResponseBroadcast',
      response,
      fromConnectionId: this.getConnectionId(ws),
    };
    this.broadcast(broadcastMessage, ws);

    log.debug('Broadcast createSessionResponse to', this.connections.size - 1, 'other connections');
  }

  /**
   * Handle generic session control message - just broadcast to other devices
   */
  private async handleSessionControl(
    ws: WebSocket,
    connState: ConnectionState,
    message: SessionControlMessage
  ): Promise<void> {
    log.debug('Received sessionControl:', message.sessionId, message.messageType);

    // Just broadcast - we don't interpret the message
    const broadcastMessage: SessionControlBroadcastMessage = {
      type: 'sessionControlBroadcast',
      message,
      fromConnectionId: this.getConnectionId(ws),
    };
    this.broadcast(broadcastMessage, ws);

    log.debug('Broadcast sessionControl to', this.connections.size - 1, 'other connections');
  }

  /**
   * Handle project config update from desktop.
   * Stores encrypted config blob on the project_index entry and broadcasts to other devices.
   */
  private async handleProjectConfigUpdate(
    ws: WebSocket,
    connState: ConnectionState,
    message: ProjectConfigUpdateMessage
  ): Promise<void> {
    const sql = this.state.storage.sql;

    // Upsert the config on the project entry
    // If the project doesn't exist yet, create it with the config
    const existing = sql.exec<ProjectIndexRow>(
      `SELECT * FROM project_index WHERE project_id = ?`,
      message.encryptedProjectId
    ).toArray()[0];

    if (existing) {
      // Only update config blob if actually provided (avoid overwriting with empty config
      // when we're just sending gitRemoteHash on startup)
      if (message.encryptedConfig) {
        sql.exec(
          `UPDATE project_index SET encrypted_config = ?, config_iv = ?, git_remote_hash = COALESCE(?, git_remote_hash) WHERE project_id = ?`,
          message.encryptedConfig,
          message.configIv,
          message.gitRemoteHash ?? null,
          message.encryptedProjectId
        );
      } else if (message.gitRemoteHash) {
        sql.exec(
          `UPDATE project_index SET git_remote_hash = ? WHERE project_id = ?`,
          message.gitRemoteHash,
          message.encryptedProjectId
        );
      }
    } else {
      // Project doesn't exist yet - create a minimal entry
      sql.exec(
        `INSERT INTO project_index (project_id, project_id_iv, name, name_iv, session_count, last_activity_at, sync_enabled, encrypted_config, config_iv, git_remote_hash)
         VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?, ?)`,
        message.encryptedProjectId,
        message.projectIdIv,
        message.encryptedProjectId, // placeholder name
        message.projectIdIv,
        Date.now(),
        message.encryptedConfig,
        message.configIv,
        message.gitRemoteHash ?? null
      );
    }

    // Read back the full project entry and broadcast
    const updatedProject = sql.exec<ProjectIndexRow>(
      `SELECT * FROM project_index WHERE project_id = ?`,
      message.encryptedProjectId
    ).toArray()[0];

    if (updatedProject) {
      const projectEntry = rowToProjectEntry(updatedProject);
      this.broadcast(
        {
          type: 'projectBroadcast',
          project: projectEntry,
          fromConnectionId: this.getConnectionId(ws),
        },
        ws
      );
    }

    log.debug('Updated project config and broadcast');
  }

  /**
   * Handle settings sync from desktop to broadcast to other devices (mobile)
   */
  private async handleSettingsSync(
    ws: WebSocket,
    connState: ConnectionState,
    settings: EncryptedSettingsPayload
  ): Promise<void> {
    log.debug('Received settingsSync from device:', settings.deviceId, 'version:', settings.version);

    // Broadcast encrypted settings to all other connections
    const broadcastMessage: SettingsSyncBroadcastMessage = {
      type: 'settingsSyncBroadcast',
      settings,
      fromConnectionId: this.getConnectionId(ws),
    };
    this.broadcast(broadcastMessage, ws);

    log.debug('Broadcast settingsSync to', this.connections.size - 1, 'other connections');
  }

  /**
   * Handle push token registration from mobile devices
   */
  private async handleRegisterPushToken(
    connState: ConnectionState,
    message: RegisterPushTokenMessage
  ): Promise<void> {
    // log.info('Registering push token for device:', message.deviceId, 'platform:', message.platform, 'token length:', message.token.length);

    // Store the token in DO storage
    const key = `push_token:${message.deviceId}`;
    const value = {
      token: message.token,
      platform: message.platform,
      deviceId: message.deviceId,
      registered_at: Date.now(),
    };

    await this.state.storage.put(key, value);
    // log.info('Push token stored for device:', message.deviceId);
  }

  /**
   * Remove the stored push token for a mobile device when the app-level push toggle is off.
   */
  private async handleUnregisterPushToken(
    connState: ConnectionState,
    message: UnregisterPushTokenMessage
  ): Promise<void> {
    const key = `push_token:${message.deviceId}`;
    await this.state.storage.delete(key);
  }

  /**
   * Handle request to send push notification to mobile devices.
   * Uses "most recently active device" routing: finds the device with the
   * highest lastActiveAt timestamp and only sends push to devices that
   * are NOT the most recently active one. This way, if the user picks up
   * their phone while a session runs on desktop, the system knows to push
   * to mobile because it has the freshest activity.
   */
  private async handleRequestMobilePush(
    connState: ConnectionState,
    message: RequestMobilePushMessage
  ): Promise<void> {
    // log.info('Received push request for session:', message.sessionId);

    // Get all registered push tokens for mobile devices
    const pushTokens = await this.state.storage.list<{
      token: string;
      platform: 'ios' | 'android';
      deviceId: string;
      registered_at: number;
    }>({ prefix: 'push_token:' });

    // log.info('Found push tokens:', pushTokens.size);

    if (pushTokens.size === 0) {
      return;
    }

    // Determine which device the user is most recently active on
    const connectedDevices = this.getConnectedDevices();
    let mostRecentDevice: DeviceInfo | null = null;
    for (const device of connectedDevices) {
      if (!mostRecentDevice || device.lastActiveAt > mostRecentDevice.lastActiveAt) {
        mostRecentDevice = device;
      }
    }

    // log.info('Most recently active device:', mostRecentDevice?.name,
    //   'type:', mostRecentDevice?.type, 'status:', mostRecentDevice?.status,
    //   'lastActiveAt:', mostRecentDevice?.lastActiveAt);

    // If the most recently active device is a desktop and it reports active status
    // (or has no status field, meaning an older client that's still connected),
    // suppress ALL mobile push notifications -- user is at their computer.
    if (mostRecentDevice
      && mostRecentDevice.type === 'desktop'
      && (mostRecentDevice.status === 'active' || !mostRecentDevice.status)) {
      // log.info('Suppressing mobile push - desktop is active');
      return;
    }

    // Desktop is idle/away or most recent device is mobile -- send push to mobile devices
    for (const [key, tokenData] of pushTokens) {
      // Skip the requesting device (desktop that triggered the push)
      if (message.requestingDeviceId && tokenData.deviceId === message.requestingDeviceId) {
        continue;
      }

      // Skip if this mobile device is the most recently active device (user is on it already)
      if (mostRecentDevice && tokenData.deviceId === mostRecentDevice.deviceId) {
        continue;
      }

      if (tokenData.platform === 'ios') {
        const result = await this.sendAPNsPush(tokenData.token, {
          title: message.title,
          body: message.body,
          sessionId: message.sessionId,
        });
        if (result.badToken) {
          log.warn('Removing bad token for device:', tokenData.deviceId);
          await this.state.storage.delete(key);
        }
      }
      if (tokenData.platform === 'android') {
        const result = await this.sendFCMPush(tokenData.token, {
          title: message.title,
          body: message.body,
          sessionId: message.sessionId,
        });
        if (result.badToken) {
          log.warn('Removing bad Android token for device:', tokenData.deviceId);
          await this.state.storage.delete(key);
        }
      }
    }
  }

  /**
   * Send a push notification via APNs
   */
  private async sendAPNsPush(
    deviceToken: string,
    payload: { title: string; body: string; sessionId: string }
  ): Promise<{ success: boolean; badToken: boolean }> {
    const env = this.env as Env;

    if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) {
      log.warn('APNs not configured, skipping push');
      return { success: false, badToken: false };
    }

    try {
      const jwt = await this.generateAPNsJWT(env.APNS_KEY, env.APNS_KEY_ID, env.APNS_TEAM_ID);
      const normalizedToken = deviceToken.toLowerCase();
      // log.info('Sending APNs push, token length:', normalizedToken.length, 'topic:', env.APNS_BUNDLE_ID || 'com.nimbalyst.app');

      const response = await fetch(
        `https://api.push.apple.com/3/device/${normalizedToken}`,
        {
          method: 'POST',
          headers: {
            'authorization': `bearer ${jwt}`,
            'apns-topic': env.APNS_BUNDLE_ID || 'com.nimbalyst.app',
            'apns-push-type': 'alert',
            'apns-priority': '10',
          },
          body: JSON.stringify({
            aps: {
              alert: {
                title: payload.title,
                body: payload.body,
              },
              sound: 'default',
            },
            sessionId: payload.sessionId,
          }),
        }
      );

      if (response.ok) {
        return { success: true, badToken: false };
      }

      const errorBody = await response.text();
      log.error('APNs push failed:', response.status, errorBody);
      const badToken = errorBody.includes('BadDeviceToken') || errorBody.includes('Unregistered');
      return { success: false, badToken };
    } catch (error) {
      log.error('APNs push error:', error);
      return { success: false, badToken: false };
    }
  }

  /**
   * Send a push notification via FCM HTTP v1.
   */
  private async sendFCMPush(
    deviceToken: string,
    payload: { title: string; body: string; sessionId: string }
  ): Promise<{ success: boolean; badToken: boolean }> {
    const env = this.env as Env;
    if (!env.FCM_PROJECT_ID || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY) {
      log.warn('FCM not configured, skipping Android push');
      return { success: false, badToken: false };
    }

    try {
      const accessToken = await this.generateFCMAccessToken(
        env.FCM_CLIENT_EMAIL,
        env.FCM_PRIVATE_KEY
      );
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`,
        {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: deviceToken,
              notification: {
                title: payload.title,
                body: payload.body,
              },
              data: {
                sessionId: payload.sessionId,
              },
              android: {
                priority: 'high',
                notification: {
                  sound: 'default',
                },
              },
            },
          }),
        }
      );

      if (response.ok) {
        return { success: true, badToken: false };
      }

      const errorBody = await response.text();
      log.error('FCM push failed:', response.status, errorBody);
      const badToken = errorBody.includes('UNREGISTERED') || errorBody.includes('INVALID_ARGUMENT');
      return { success: false, badToken };
    } catch (error) {
      log.error('FCM push error:', error);
      return { success: false, badToken: false };
    }
  }

  /**
   * Generate a JWT for APNs authentication (with caching)
   * Uses ES256 algorithm as required by APNs
   * JWTs are valid for 1 hour, we cache for 50 minutes
   */
  private async generateAPNsJWT(
    privateKeyBase64: string,
    keyId: string,
    teamId: string
  ): Promise<string> {
    const now = Date.now();

    // Return cached JWT if still valid (50 minute cache)
    if (this.cachedAPNsJWT && now < this.cachedAPNsJWTExpiry) {
      return this.cachedAPNsJWT;
    }

    // Get or create cached private key
    if (!this.cachedAPNsKey) {
      const privateKeyPem = atob(privateKeyBase64);
      this.cachedAPNsKey = await crypto.subtle.importKey(
        'pkcs8',
        this.pemToArrayBuffer(privateKeyPem),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
      );
    }

    // Create JWT header and payload
    const header = { alg: 'ES256', kid: keyId };
    const payload = {
      iss: teamId,
      iat: Math.floor(now / 1000),
    };

    // Encode header and payload
    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    // Sign with the private key
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.cachedAPNsKey,
      new TextEncoder().encode(signingInput)
    );

    // Convert signature to base64url
    const encodedSignature = this.base64UrlEncode(
      String.fromCharCode(...new Uint8Array(signature))
    );

    const jwt = `${signingInput}.${encodedSignature}`;

    // Cache the JWT for 50 minutes (APNs allows 1 hour)
    this.cachedAPNsJWT = jwt;
    this.cachedAPNsJWTExpiry = now + 50 * 60 * 1000;

    return jwt;
  }

  private async generateFCMAccessToken(
    clientEmail: string,
    privateKeyBase64: string
  ): Promise<string> {
    const now = Date.now();
    if (this.cachedFCMAccessToken && now < this.cachedFCMAccessTokenExpiry) {
      return this.cachedFCMAccessToken;
    }

    if (!this.cachedFCMKey) {
      const privateKeyPem = atob(privateKeyBase64);
      this.cachedFCMKey = await crypto.subtle.importKey(
        'pkcs8',
        this.pemToArrayBuffer(privateKeyPem),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
      );
    }

    const issuedAt = Math.floor(now / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: issuedAt,
      exp: issuedAt + 3600,
    };

    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      this.cachedFCMKey,
      new TextEncoder().encode(signingInput)
    );
    const assertion = `${signingInput}.${this.base64UrlEncode(
      String.fromCharCode(...new Uint8Array(signature))
    )}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Failed to obtain FCM access token: ${response.status} ${errorBody}`);
    }

    const data = await response.json<{ access_token?: string; expires_in?: number }>();
    if (!data.access_token) {
      throw new Error('FCM access token response did not include access_token');
    }

    this.cachedFCMAccessToken = data.access_token;
    this.cachedFCMAccessTokenExpiry = now + ((data.expires_in ?? 3600) - 300) * 1000;
    return data.access_token;
  }

  /**
   * Convert PEM to ArrayBuffer for crypto.subtle.importKey
   */
  private pemToArrayBuffer(pem: string): ArrayBuffer {
    // Remove PEM headers and newlines
    const base64 = pem
      .replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '')
      .replace(/\s/g, '');

    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Base64 URL encode (RFC 4648)
   */
  private base64UrlEncode(str: string): string {
    return btoa(str)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * Get list of all connected devices
   * Returns devices from active connections that have announced themselves,
   * plus stored devices as fallback for connections recovering from hibernation.
   */
  /**
   * Get all known devices with online/offline status.
   * Online devices come from active WebSocket connections.
   * Offline devices come from DO storage (persisted across disconnects).
   */
  private getConnectedDevices(): DeviceInfo[] {
    const devices: DeviceInfo[] = [];
    const seenIds = new Set<string>();

    // First: devices from active connections (these are online)
    for (const [, state] of this.connections) {
      if (state.device && !seenIds.has(state.device.deviceId)) {
        devices.push({ ...state.device, isOnline: true });
        seenIds.add(state.device.deviceId);
      }
    }

    // Include stored devices that aren't currently connected (offline)
    // Also include stored devices for hibernation-recovered connections
    for (const [, device] of this.storedDevices) {
      if (!seenIds.has(device.deviceId)) {
        devices.push({ ...device, isOnline: false });
        seenIds.add(device.deviceId);
      }
    }

    return devices;
  }

  /**
   * Update project statistics (session count, last activity)
   * Broadcasts project updates to all connected clients when a new project is created.
   *
   * @param encryptedProjectId - The encrypted project ID (used as opaque key)
   * @param projectIdIv - The IV for the encrypted project ID
   * @param originatingWs - The WebSocket that originated this update (excluded from broadcast)
   */
  private async updateProjectStats(encryptedProjectId: string, projectIdIv: string, originatingWs?: WebSocket): Promise<void> {
    const sql = this.state.storage.sql;

    // Calculate stats from sessions using encrypted project_id as opaque key
    const stats = sql.exec<{ count: number; last_activity: number | null }>(
      `SELECT COUNT(*) as count, MAX(updated_at) as last_activity
       FROM session_index WHERE project_id = ?`,
      encryptedProjectId
    ).toArray()[0];

    // Check if project exists before upserting
    const existing = sql.exec<ProjectIndexRow>(
      `SELECT * FROM project_index WHERE project_id = ?`,
      encryptedProjectId
    ).toArray()[0];

    const isNewProject = !existing;

    if (existing) {
      sql.exec(
        `UPDATE project_index SET session_count = ?, last_activity_at = ? WHERE project_id = ?`,
        stats?.count ?? 0,
        stats?.last_activity ?? Date.now(),
        encryptedProjectId
      );
    } else {
      sql.exec(
        `INSERT INTO project_index (project_id, project_id_iv, name, name_iv, session_count, last_activity_at, sync_enabled)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        encryptedProjectId,
        projectIdIv,
        encryptedProjectId, // Use encrypted project_id as placeholder for encrypted name
        projectIdIv, // Use same IV as placeholder (will be updated by client)
        stats?.count ?? 0,
        stats?.last_activity ?? Date.now()
      );
    }

    // Broadcast project update to all connected clients when a new project is created
    if (isNewProject) {
      const updatedProject = sql.exec<ProjectIndexRow>(
        `SELECT * FROM project_index WHERE project_id = ?`,
        encryptedProjectId
      ).toArray()[0];

      if (updatedProject) {
        const projectEntry = rowToProjectEntry(updatedProject);
        this.broadcast(
          {
            type: 'projectBroadcast',
            project: projectEntry,
            fromConnectionId: originatingWs ? this.getConnectionId(originatingWs) : undefined,
          },
          originatingWs
        );
        log.debug('Broadcast new project');
      }
    }
  }

  /**
   * Bulk update session index (for initial sync from desktop)
   */
  async bulkUpdateIndex(sessions: SessionIndexEntry[]): Promise<void> {
    await this.ensureInitialized();
    const sql = this.state.storage.sql;

    // Track affected projects with their IVs
    const affectedProjectIvs = new Map<string, string>();

    // Use a transaction for bulk insert
    sql.exec('BEGIN TRANSACTION');
    try {
      for (const session of sessions) {
        sql.exec(
          `INSERT OR REPLACE INTO session_index
           (session_id, project_id, project_id_iv, encrypted_title, title_iv, provider, model, mode, message_count, last_message_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          session.sessionId,
          session.encryptedProjectId,
          session.projectIdIv,
          session.encryptedTitle ?? null,
          session.titleIv ?? null,
          session.provider,
          session.model ?? null,
          session.mode ?? null,
          session.messageCount,
          session.lastMessageAt,
          session.createdAt,
          session.updatedAt
        );
        affectedProjectIvs.set(session.encryptedProjectId, session.projectIdIv);
      }
      sql.exec('COMMIT');
    } catch (err) {
      sql.exec('ROLLBACK');
      throw err;
    }

    // Update all affected project stats
    for (const [encryptedProjectId, projectIdIv] of affectedProjectIvs) {
      await this.updateProjectStats(encryptedProjectId, projectIdIv);
    }
  }

  /**
   * Broadcast message to all connections except sender
   */
  private broadcast(message: ServerMessage, exclude?: WebSocket): void {
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

  /**
   * Send error to a single connection
   */
  private sendError(ws: WebSocket, code: string, message: string): void {
    ws.send(JSON.stringify({ type: 'error', code, message }));
  }

  /**
   * Get unique ID for a connection
   */
  private getConnectionId(ws: WebSocket): string {
    for (const [conn, state] of this.connections) {
      if (conn === ws) {
        return state.auth.userId + '_' + Date.now();
      }
    }
    return 'unknown';
  }

  /**
   * Alarm handler - periodic cleanup of expired session index entries.
   * Runs every 24 hours to remove entries older than the TTL.
   */
  async alarm(): Promise<void> {
    await this.ensureInitialized();

    const sql = this.state.storage.sql;
    const cutoff = Date.now() - SESSION_TTL_MS;

    const expiredSessions = sql.exec<{ session_id: string; project_id: string; project_id_iv: string }>(
      `SELECT session_id, project_id, project_id_iv FROM session_index WHERE updated_at < ?`,
      cutoff
    ).toArray();

    if (expiredSessions.length > 0) {
      log.info('Cleaning up', expiredSessions.length, 'expired session index entries');

      const affectedProjects = new Map<string, string>();
      const owner = await this.state.storage.get<{ userId: string; orgId: string }>('meta:owner');

      for (const session of expiredSessions) {
        // Drop the underlying PersonalSessionRoom DO storage. Skip when owner
        // identity hasn't been persisted yet -- it'll be picked up on the next
        // GC cycle once any connection has come through.
        if (owner) {
          await this.purgeSessionRoom(owner, session.session_id);
        }
        sql.exec(`DELETE FROM session_index WHERE session_id = ?`, session.session_id);
        affectedProjects.set(session.project_id, session.project_id_iv);
      }

      if (!owner) {
        log.warn('No persisted owner identity; SessionRoom DOs not purged this cycle');
      }

      // Update project stats for affected projects
      for (const [encryptedProjectId, projectIdIv] of affectedProjects) {
        await this.updateProjectStats(encryptedProjectId, projectIdIv);
      }

      // Clean up projects with zero sessions
      sql.exec(`DELETE FROM project_index WHERE session_count = 0`);

      // Broadcast deletions to connected clients
      for (const session of expiredSessions) {
        this.broadcast({
          type: 'indexDeleteBroadcast',
          sessionId: session.session_id,
          fromConnectionId: 'ttl-cleanup',
        });
      }
    }

    // Clean up stale offline devices (not seen in 90 days)
    const deviceCutoff = Date.now() - DEVICE_TTL_MS;
    const staleDeviceIds: string[] = [];
    for (const [deviceId, device] of this.storedDevices) {
      const lastSeen = device.lastSeenAt ?? device.lastActiveAt ?? 0;
      if (lastSeen < deviceCutoff) {
        staleDeviceIds.push(deviceId);
      }
    }
    if (staleDeviceIds.length > 0) {
      log.info('Cleaning up', staleDeviceIds.length, 'stale offline devices');
      for (const deviceId of staleDeviceIds) {
        this.storedDevices.delete(deviceId);
        await this.state.storage.delete(`device:${deviceId}`);
      }
    }

    // Reschedule for next cleanup cycle
    await this.state.storage.setAlarm(Date.now() + INDEX_CLEANUP_INTERVAL_MS);
  }

  /**
   * Handle WebSocket close
   */
  async webSocketClose(ws: WebSocket): Promise<void> {
    const connState = this.connections.get(ws);

    // If this connection had device info, broadcast that it left and persist lastSeenAt
    if (connState?.device) {
      const leftMessage: DeviceLeftMessage = {
        type: 'deviceLeft',
        deviceId: connState.device.deviceId,
      };
      this.broadcast(leftMessage, ws);
      // Keep device in storage with lastSeenAt so it appears as offline in device list
      const updatedDevice = { ...connState.device, lastSeenAt: Date.now() };
      this.storedDevices.set(updatedDevice.deviceId, updatedDevice);
      await this.state.storage.put(`device:${updatedDevice.deviceId}`, updatedDevice);
    }

    this.connections.delete(ws);
  }

  /**
   * Handle WebSocket error
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    log.error('WebSocket error:', error);
    const connState = this.connections.get(ws);

    // If this connection had device info, broadcast that it left and persist lastSeenAt
    if (connState?.device) {
      const leftMessage: DeviceLeftMessage = {
        type: 'deviceLeft',
        deviceId: connState.device.deviceId,
      };
      this.broadcast(leftMessage, ws);
      const updatedDevice = { ...connState.device, lastSeenAt: Date.now() };
      this.storedDevices.set(updatedDevice.deviceId, updatedDevice);
      await this.state.storage.put(`device:${updatedDevice.deviceId}`, updatedDevice);
    }

    this.connections.delete(ws);
  }

  /**
   * Handle account deletion - return all session IDs then purge all data.
   * Called internally by the account deletion cascade (not user-facing).
   */
  private async handleDeleteAccount(): Promise<Response> {
    await this.ensureInitialized();
    const sql = this.state.storage.sql;

    // Collect all session IDs before deletion (needed to clean up SessionRooms)
    const sessionIds: string[] = [];
    for (const row of sql.exec<{ session_id: string }>(`SELECT session_id FROM session_index`)) {
      sessionIds.push(row.session_id);
    }

    log.info('Account deletion: purging', sessionIds.length, 'sessions from index');

    // Close all WebSocket connections first so no writes race the delete.
    for (const [ws] of this.connections) {
      try {
        ws.close(4003, 'Account deleted');
      } catch {
        // Connection may already be closed
      }
    }
    this.connections.clear();
    this.storedDevices.clear();

    // Bulk-drop all storage (SQL tables + KV). Explicit `DELETE FROM session_index`
    // previously ran first and hit the DO storage operation timeout on large
    // accounts, resetting the DO mid-delete and stranding partial state.
    await this.state.storage.deleteAll();

    return new Response(JSON.stringify({ deleted: true, sessionIds }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Status endpoint for debugging
   */
  private async handleStatusRequest(): Promise<Response> {
    await this.ensureInitialized();
    const sql = this.state.storage.sql;

    const sessionCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM session_index`
    ).toArray()[0]?.count ?? 0;

    const projectCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM project_index`
    ).toArray()[0]?.count ?? 0;

    return new Response(
      JSON.stringify({
        roomId: this.state.id.toString(),
        connections: this.connections.size,
        sessionCount,
        projectCount,
        devices: this.getConnectedDevices(),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ============================================================================
// Helper Types and Functions
// ============================================================================

// SQL row types use snake_case to match column names (internal, not on wire)
type SessionIndexRow = {
  [key: string]: SqlStorageValue;
  session_id: string;
  project_id: string;
  project_id_iv: string | null;
  title: string | null;
  encrypted_title: string | null;
  title_iv: string | null;
  provider: string | null;
  model: string | null;
  mode: string | null;
  message_count: number;
  last_message_at: number | null;
  created_at: number;
  updated_at: number;
  is_executing: number;
  last_read_at: number | null;
  encrypted_client_metadata: string | null;
  client_metadata_iv: string | null;
  parent_session_id: string | null;
  session_type: string | null;
  worktree_id: string | null;
  is_archived: number;
  is_pinned: number;
  branched_from_session_id: string | null;
  branch_point_message_id: number | null;
  branched_at: number | null;
};

type ProjectIndexRow = {
  [key: string]: SqlStorageValue;
  project_id: string;
  project_id_iv: string | null;
  name: string;
  name_iv: string | null;
  path: string | null;
  path_iv: string | null;
  session_count: number;
  last_activity_at: number | null;
  sync_enabled: number;
  encrypted_config: string | null;
  config_iv: string | null;
  git_remote_hash: string | null;
};

type FileIndexRow = {
  [key: string]: SqlStorageValue;
  doc_id: string;
  encrypted_project_id: string;
  project_id_iv: string;
  encrypted_relative_path: string;
  relative_path_iv: string;
  encrypted_title: string;
  title_iv: string;
  last_modified_at: number;
  synced_at: number;
};

// Map SQL rows (snake_case) to wire format (camelCase)
function rowToFileEntry(row: FileIndexRow): FileIndexEntry {
  return {
    docId: row.doc_id,
    encryptedProjectId: row.encrypted_project_id,
    projectIdIv: row.project_id_iv,
    encryptedRelativePath: row.encrypted_relative_path,
    relativePathIv: row.relative_path_iv,
    encryptedTitle: row.encrypted_title,
    titleIv: row.title_iv,
    lastModifiedAt: row.last_modified_at,
    syncedAt: row.synced_at,
  };
}

function rowToSessionEntry(row: SessionIndexRow): SessionIndexEntry {
  return {
    sessionId: row.session_id,
    encryptedProjectId: row.project_id,
    projectIdIv: row.project_id_iv ?? '',
    encryptedTitle: row.encrypted_title ?? undefined,
    titleIv: row.title_iv ?? undefined,
    provider: row.provider ?? 'unknown',
    model: row.model ?? undefined,
    mode: (row.mode as SessionIndexEntry['mode']) ?? undefined,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isExecuting: row.is_executing === 1,
    encryptedClientMetadata: row.encrypted_client_metadata ?? undefined,
    clientMetadataIv: row.client_metadata_iv ?? undefined,
    lastReadAt: row.last_read_at ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
    sessionType: row.session_type ?? undefined,
    worktreeId: row.worktree_id ?? undefined,
    isArchived: row.is_archived === 1,
    isPinned: row.is_pinned === 1,
    branchedFromSessionId: row.branched_from_session_id ?? undefined,
    branchPointMessageId: row.branch_point_message_id ?? undefined,
    branchedAt: row.branched_at ?? undefined,
  };
}

function rowToProjectEntry(row: ProjectIndexRow): ProjectIndexEntry {
  return {
    encryptedProjectId: row.project_id,
    projectIdIv: row.project_id_iv ?? '',
    encryptedName: row.name,
    nameIv: row.name_iv ?? '',
    encryptedPath: row.path ?? undefined,
    pathIv: row.path_iv ?? undefined,
    sessionCount: row.session_count,
    lastActivityAt: row.last_activity_at ?? 0,
    syncEnabled: row.sync_enabled === 1,
    encryptedConfig: row.encrypted_config ?? undefined,
    configIv: row.config_iv ?? undefined,
    gitRemoteHash: row.git_remote_hash ?? undefined,
  };
}
