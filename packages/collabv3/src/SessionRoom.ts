/**
 * PersonalSessionRoom Durable Object
 *
 * Manages a single AI session's messages and real-time sync.
 * Uses DO SQLite for message storage (no 2MB BLOB limit).
 */

import type {
  Env,
  ClientMessage,
  ServerMessage,
  EncryptedMessage,
  SessionMetadata,
  SyncResponseMessage,
  AuthContext,
} from './types';
import { createLogger } from './logger';
import { track } from './analytics';

const log = createLogger('PersonalSessionRoom');

/** Session TTL: 30 days in milliseconds */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface ConnectionState {
  auth: AuthContext;
  synced: boolean;
}

// WebSocket tag prefixes for hibernation recovery
const TAG_USER = 'user:';
const TAG_ORG = 'org:';

// Message batch size for sync responses
const SYNC_BATCH_SIZE = 100;

export class PersonalSessionRoom implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  // Note: This map is rebuilt after hibernation using getWebSockets() and tags
  private connections: Map<WebSocket, ConnectionState> = new Map();
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Restore connections from hibernation
    // getWebSockets() returns all WebSockets that survived hibernation
    this.restoreConnectionsFromHibernation();
  }

  /**
   * Restore connection state from WebSocket tags after hibernation
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
    if (webSockets.length > 0) {
      log.info(`Restored ${webSockets.length} connections from hibernation`);
    }
  }

  /**
   * Initialize SQLite schema on first access
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const sql = this.state.storage.sql;

    // Create messages table
    sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        direction TEXT NOT NULL,
        encrypted_content TEXT NOT NULL,
        iv TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_sequence ON messages(sequence);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    `);

    // Create metadata table (key-value store for session metadata)
    sql.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Migration: Delete old sessions that have plaintext project_id
    // New sessions use encryptedProjectId instead
    const hasOldProjectId = sql.exec<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'project_id'`
    ).toArray()[0];
    const hasNewProjectId = sql.exec<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'encrypted_project_id'`
    ).toArray()[0];

    if (hasOldProjectId && !hasNewProjectId) {
      // Old unencrypted session - clear all data
      sql.exec(`DELETE FROM messages`);
      sql.exec(`DELETE FROM metadata`);
    }

    // Bootstrap TTL alarm for existing sessions that don't have one yet
    const existingAlarm = await this.state.storage.getAlarm();
    if (!existingAlarm) {
      const hasData = sql.exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM metadata`
      ).toArray()[0]?.count ?? 0;

      if (hasData > 0 && this.connections.size === 0) {
        await this.scheduleExpiryAlarm();
      }
    }

    this.initialized = true;
  }

  /**
   * Handle HTTP requests (WebSocket upgrades and REST endpoints)
   */
  async fetch(request: Request): Promise<Response> {
    // Ensure tables exist and old data is cleaned up
    await this.ensureInitialized();

    const url = new URL(request.url);

    // Handle WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    // REST endpoints for debugging
    if (url.pathname.endsWith('/status')) {
      return this.handleStatusRequest();
    }

    // Account deletion - purge all data in this PersonalSessionRoom
    if (url.pathname.endsWith('/delete-account') && request.method === 'DELETE') {
      return this.handleDeleteAccount();
    }

    return new Response('Expected WebSocket', { status: 400 });
  }

  /**
   * Upgrade HTTP to WebSocket
   */
  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    // Parse auth from query params or headers
    const auth = this.parseAuth(request);
    if (!auth) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Cancel TTL alarm since session is now actively connected
    await this.state.storage.deleteAlarm();

    // Accept with hibernation support, storing auth in tags for recovery
    // Tags persist across hibernation and allow us to restore connection state
    const tags = [`${TAG_USER}${auth.userId}`];
    if (auth.orgId) {
      tags.push(`${TAG_ORG}${auth.orgId}`);
    }
    this.state.acceptWebSocket(server, tags);

    // Store connection state in memory (will be restored from tags after hibernation)
    this.connections.set(server, {
      auth,
      synced: false,
    });

    return new Response(null, { status: 101, webSocket: client });
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
      const rawData = typeof data === 'string' ? data : new TextDecoder().decode(data);
      const message: ClientMessage = JSON.parse(rawData);

      switch (message.type) {
        case 'syncRequest':
          await this.handleSyncRequest(ws, connState, message.sinceId, message.sinceSeq);
          break;

        case 'appendMessage':
          await this.handleAppendMessage(ws, connState, message.message);
          break;

        case 'updateMetadata':
          await this.handleUpdateMetadata(ws, connState, message.metadata);
          break;

        case 'deleteSession':
          await this.handleDeleteSession(ws, connState);
          break;

        default:
          log.warn('Unknown message type:', (message as { type: string }).type);
          this.sendError(ws, 'unknown_message_type', `Unknown message type`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error('Error handling message:', errorMessage);
      this.sendError(ws, 'parse_error', `Failed to parse message: ${errorMessage}`);
    }
  }

  /**
   * Handle sync request - return messages since cursor
   */
  private async handleSyncRequest(
    ws: WebSocket,
    connState: ConnectionState,
    sinceId?: string,
    sinceSeq?: number
  ): Promise<void> {
    const sql = this.state.storage.sql;

    // Build query based on cursor
    let messages: EncryptedMessage[];
    let cursor: string | null = null;

    if (sinceSeq !== undefined) {
      // Cursor-based pagination by sequence
      const rows = sql.exec<{
        id: string;
        sequence: number;
        created_at: number;
        source: string;
        direction: string;
        encrypted_content: string;
        iv: string;
        metadata_json: string | null;
      }>(
        `SELECT * FROM messages WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`,
        sinceSeq,
        SYNC_BATCH_SIZE + 1
      ).toArray();

      const hasMore = rows.length > SYNC_BATCH_SIZE;
      const resultRows = hasMore ? rows.slice(0, SYNC_BATCH_SIZE) : rows;

      messages = resultRows.map((row) => ({
        id: row.id,
        sequence: row.sequence,
        createdAt: row.created_at,
        source: row.source as EncryptedMessage['source'],
        direction: row.direction as EncryptedMessage['direction'],
        encryptedContent: row.encrypted_content,
        iv: row.iv,
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
      }));

      if (hasMore && resultRows.length > 0) {
        cursor = String(resultRows[resultRows.length - 1].sequence);
      }
    } else {
      // Initial sync - get all messages
      const rows = sql.exec<{
        id: string;
        sequence: number;
        created_at: number;
        source: string;
        direction: string;
        encrypted_content: string;
        iv: string;
        metadata_json: string | null;
      }>(
        `SELECT * FROM messages ORDER BY sequence ASC LIMIT ?`,
        SYNC_BATCH_SIZE + 1
      ).toArray();

      const hasMore = rows.length > SYNC_BATCH_SIZE;
      const resultRows = hasMore ? rows.slice(0, SYNC_BATCH_SIZE) : rows;

      messages = resultRows.map((row) => ({
        id: row.id,
        sequence: row.sequence,
        createdAt: row.created_at,
        source: row.source as EncryptedMessage['source'],
        direction: row.direction as EncryptedMessage['direction'],
        encryptedContent: row.encrypted_content,
        iv: row.iv,
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
      }));

      if (hasMore && resultRows.length > 0) {
        cursor = String(resultRows[resultRows.length - 1].sequence);
      }
    }

    // Get metadata
    const metadata = this.getMetadata();

    const response: SyncResponseMessage = {
      type: 'syncResponse',
      messages,
      metadata,
      hasMore: cursor !== null,
      cursor,
    };

    ws.send(JSON.stringify(response));
    connState.synced = true;

    // Analytics: track session sync activity
    track(this.env, 'session_sync', [connState.auth.userId, this.state.id.toString(), metadata?.provider ?? ''], [messages.length]);
  }

  /**
   * Handle append message - store and broadcast
   * Deduplicates by message ID to prevent sync loops from creating duplicates
   */
  private async handleAppendMessage(
    ws: WebSocket,
    connState: ConnectionState,
    message: EncryptedMessage
  ): Promise<void> {
    const sql = this.state.storage.sql;

    // Check if message with this ID already exists (deduplication)
    const existing = sql.exec<{ id: string }>(
      `SELECT id FROM messages WHERE id = ?`,
      message.id
    ).toArray();

    if (existing.length > 0) {
      // Message already exists - skip insert, don't broadcast (expected during initial sync)
      return;
    }

    // Get next sequence number
    const maxSeqResult = sql.exec<{ max_seq: number | null }>(
      `SELECT MAX(sequence) as max_seq FROM messages`
    ).toArray();
    const nextSeq = (maxSeqResult[0]?.max_seq ?? 0) + 1;

    // Override sequence with server-assigned value
    const storedMessage: EncryptedMessage = {
      ...message,
      sequence: nextSeq,
    };

    // Insert message
    sql.exec(
      `INSERT INTO messages (id, sequence, created_at, source, direction, encrypted_content, iv, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      storedMessage.id,
      storedMessage.sequence,
      storedMessage.createdAt,
      storedMessage.source,
      storedMessage.direction,
      storedMessage.encryptedContent,
      storedMessage.iv,
      JSON.stringify(storedMessage.metadata)
    );

    // Update metadata timestamp
    this.setMetadataValue('updated_at', String(Date.now()));

    // Analytics: track message appended
    track(this.env, 'message_append', [connState.auth.userId, this.state.id.toString()], [storedMessage.encryptedContent.length]);

    // Broadcast to other connections
    this.broadcast(
      {
        type: 'messageBroadcast',
        message: storedMessage,
        fromConnectionId: this.getConnectionId(ws),
      },
      ws
    );
  }

  /**
   * Handle metadata update
   */
  private async handleUpdateMetadata(
    ws: WebSocket,
    connState: ConnectionState,
    updates: Partial<SessionMetadata>
  ): Promise<void> {
    const now = Date.now();

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        this.setMetadataValue(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }

    // NOTE: Do NOT update 'updated_at' here. Metadata updates (read state, isExecuting,
    // context usage) should not change the session's sort timestamp. Only message appends
    // (handleAppendMessage) should bump updated_at, matching the desktop behavior where
    // updated_at reflects the last message time. Without this, clicking a session on
    // desktop causes it to jump to the top of the iOS session list.

    // Broadcast to other connections (without updatedAt to avoid sort disruption)
    this.broadcast(
      {
        type: 'metadataBroadcast',
        metadata: { ...updates },
        fromConnectionId: this.getConnectionId(ws),
      },
      ws
    );
  }

  /**
   * Handle session deletion
   */
  private async handleDeleteSession(
    ws: WebSocket,
    connState: ConnectionState
  ): Promise<void> {
    const sql = this.state.storage.sql;

    // Delete all messages
    sql.exec(`DELETE FROM messages`);

    // Mark metadata as deleted
    this.setMetadataValue('deleted', 'true');
    this.setMetadataValue('deleted_at', String(Date.now()));

    // Close all connections
    for (const [conn] of this.connections) {
      conn.close(4002, 'Session deleted');
    }
  }

  /**
   * Get all metadata as object
   */
  private getMetadata(): SessionMetadata | null {
    const sql = this.state.storage.sql;
    const rows = sql.exec<{ key: string; value: string }>(
      `SELECT key, value FROM metadata`
    ).toArray();

    if (rows.length === 0) return null;

    const metadata: Record<string, string> = {};
    for (const row of rows) {
      metadata[row.key] = row.value;
    }

    return {
      title: metadata.title ?? 'Untitled',
      provider: metadata.provider ?? 'unknown',
      model: metadata.model,
      mode: metadata.mode as SessionMetadata['mode'],
      // Server stores encrypted values opaquely - pass through as-is
      encryptedProjectId: metadata.encrypted_project_id ?? '',
      projectIdIv: metadata.project_id_iv ?? '',
      createdAt: parseInt(metadata.created_at ?? '0', 10),
      updatedAt: parseInt(metadata.updated_at ?? '0', 10),
      // Include executing state for mobile sync
      isExecuting: metadata.isExecuting === 'true',
    };
  }

  /**
   * Set a single metadata value
   */
  private setMetadataValue(key: string, value: string): void {
    const sql = this.state.storage.sql;
    sql.exec(
      `INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)`,
      key,
      value,
      Date.now()
    );
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
   * Get unique ID for a connection (for dedup on broadcast)
   */
  private getConnectionId(ws: WebSocket): string {
    // Use object identity as a simple ID
    for (const [conn, state] of this.connections) {
      if (conn === ws) {
        return state.auth.userId + '_' + Date.now();
      }
    }
    return 'unknown';
  }

  /**
   * Handle WebSocket close
   */
  async webSocketClose(ws: WebSocket): Promise<void> {
    this.connections.delete(ws);

    if (this.connections.size === 0) {
      await this.scheduleExpiryAlarm();
    }
  }

  /**
   * Handle WebSocket error
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    log.error('WebSocket error:', error);
    this.connections.delete(ws);

    if (this.connections.size === 0) {
      await this.scheduleExpiryAlarm();
    }
  }

  /**
   * Schedule (or reschedule) the TTL expiry alarm.
   */
  private async scheduleExpiryAlarm(): Promise<void> {
    if (this.connections.size > 0) return;
    await this.state.storage.setAlarm(Date.now() + SESSION_TTL_MS);
  }

  /**
   * Alarm handler - called when the TTL expires.
   * Checks if the session is truly expired before deleting.
   */
  async alarm(): Promise<void> {
    await this.ensureInitialized();

    // Don't delete if there are active connections
    if (this.connections.size > 0) {
      log.info('Alarm fired but session has active connections, rescheduling');
      await this.scheduleExpiryAlarm();
      return;
    }

    const sql = this.state.storage.sql;
    const row = sql.exec<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'updated_at'`
    ).toArray()[0];

    const lastActivity = row ? parseInt(row.value, 10) : 0;
    const elapsed = Date.now() - lastActivity;

    if (elapsed < SESSION_TTL_MS) {
      // Not yet expired - reschedule for the correct future time
      const remaining = SESSION_TTL_MS - elapsed;
      await this.state.storage.setAlarm(Date.now() + remaining);
      log.info('Alarm fired early, rescheduling for', remaining, 'ms');
      return;
    }

    // Session is expired - delete all data
    log.info('Session TTL expired, deleting data. Last activity:', lastActivity);
    sql.exec(`DELETE FROM messages`);
    sql.exec(`DELETE FROM metadata`);
  }

  /**
   * Handle account deletion - purge all data and disconnect clients.
   * Called internally by the account deletion cascade (not user-facing).
   */
  private handleDeleteAccount(): Response {
    const sql = this.state.storage.sql;

    // Delete all messages and metadata
    sql.exec(`DELETE FROM messages`);
    sql.exec(`DELETE FROM metadata`);

    // Close all WebSocket connections
    for (const [ws] of this.connections) {
      try {
        ws.close(4003, 'Account deleted');
      } catch {
        // Connection may already be closed
      }
    }
    this.connections.clear();

    // Cancel any TTL alarm
    this.state.storage.deleteAlarm();

    return new Response(JSON.stringify({ deleted: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Status endpoint for debugging
   */
  private handleStatusRequest(): Response {
    const sql = this.state.storage.sql;

    const messageCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM messages`
    ).toArray()[0]?.count ?? 0;

    const metadata = this.getMetadata();

    return new Response(
      JSON.stringify({
        roomId: this.state.id.toString(),
        connections: this.connections.size,
        messageCount,
        metadata,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}
