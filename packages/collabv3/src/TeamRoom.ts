/**
 * TeamRoom Durable Object
 *
 * Consolidated org-scoped DO for all team-level state:
 * - Team metadata (name, git remote hash)
 * - Member roles (admin/member)
 * - ECDH identity public keys
 * - Key envelopes (wrapped org encryption keys)
 * - Shared document index (E2E encrypted titles)
 *
 * Handles both direct WebSocket messages (realtime sync, identity keys,
 * doc index) and internal HTTP mutations forwarded from the Worker
 * (member management, key envelopes -- operations that need Stytch API).
 *
 * One TeamRoom per org. Physical isolation: each org's data lives in
 * its own SQLite database inside the DO instance.
 */

import type {
  Env,
  TeamClientMessage,
  TeamServerMessage,
  TeamState,
  MemberInfo,
  EncryptedDocIndexEntry,
  AuthContext,
} from './types';
import { createLogger } from './logger';
import { validateP256PublicKey } from './validatePublicKey';

const log = createLogger('TeamRoom');

/** Team TTL: 365 days (teams are permanent, not ephemeral) */
const TEAM_TTL_MS = 365 * 24 * 60 * 60 * 1000;

interface ConnectionState {
  auth: AuthContext;
  synced: boolean;
}

// WebSocket tag prefixes for hibernation recovery
const TAG_USER = 'user:';
const TAG_ORG = 'org:';

export class TeamRoom implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private connections: Map<WebSocket, ConnectionState> = new Map();
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.restoreConnectionsFromHibernation();
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  private restoreConnectionsFromHibernation(): void {
    const webSockets = this.state.getWebSockets();
    for (const ws of webSockets) {
      const tags = this.state.getTags(ws);
      const userTag = tags.find(t => t.startsWith(TAG_USER));
      const orgTag = tags.find(t => t.startsWith(TAG_ORG));
      if (userTag && orgTag) {
        this.connections.set(ws, {
          auth: {
            userId: userTag.slice(TAG_USER.length),
            orgId: orgTag.slice(TAG_ORG.length),
          },
          synced: true,
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
      CREATE TABLE IF NOT EXISTS team_metadata (
        org_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        git_remote_hash TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS member_roles (
        user_id TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'member',
        email TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_member_email ON member_roles(email);

      CREATE TABLE IF NOT EXISTS identity_keys (
        user_id TEXT PRIMARY KEY,
        public_key_jwk TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS key_envelopes (
        target_user_id TEXT PRIMARY KEY,
        sender_user_id TEXT NOT NULL DEFAULT '',
        wrapped_key TEXT NOT NULL,
        iv TEXT NOT NULL,
        sender_public_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS document_index (
        document_id TEXT PRIMARY KEY,
        encrypted_title TEXT NOT NULL,
        title_iv TEXT NOT NULL,
        document_type TEXT NOT NULL DEFAULT 'markdown',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Migration: add sender_user_id to key_envelopes for DOs created before this column existed.
    // CREATE TABLE IF NOT EXISTS won't add columns to an existing table.
    try {
      sql.exec(`ALTER TABLE key_envelopes ADD COLUMN sender_user_id TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists -- expected for newly-created DOs
    }

    // Bootstrap TTL alarm
    const existingAlarm = await this.state.storage.getAlarm();
    if (!existingAlarm) {
      const hasData = sql.exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM member_roles`
      ).toArray()[0]?.count ?? 0;

      if (hasData > 0 && this.connections.size === 0) {
        await this.scheduleExpiryAlarm();
      }
    }

    this.initialized = true;
  }

  // ==========================================================================
  // HTTP Request Handler
  // ==========================================================================

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

    // Internal endpoints forwarded from the Worker
    if (url.pathname.includes('/internal/') && request.method === 'POST') {
      return this.handleInternalMutation(request, url);
    }

    // Internal read endpoints forwarded from the Worker
    if (url.pathname.includes('/internal/') && request.method === 'GET') {
      return this.handleInternalQuery(url);
    }

    return new Response('Expected WebSocket or internal endpoint', { status: 400 });
  }

  // ==========================================================================
  // WebSocket Connection
  // ==========================================================================

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const auth = this.parseAuth(request);
    if (!auth) {
      return new Response('Unauthorized', { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    await this.state.storage.deleteAlarm();

    const tags = [`${TAG_USER}${auth.userId}`, `${TAG_ORG}${auth.orgId}`];
    this.state.acceptWebSocket(server, tags);

    this.connections.set(server, { auth, synced: false });

    return new Response(null, { status: 101, webSocket: client });
  }

  private parseAuth(request: Request): AuthContext | null {
    const url = new URL(request.url);
    const userId = url.searchParams.get('user_id');
    const orgId = url.searchParams.get('org_id');
    if (userId && orgId) return { userId, orgId };
    return null;
  }

  // ==========================================================================
  // WebSocket Message Handler
  // ==========================================================================

  async webSocketMessage(ws: WebSocket, data: ArrayBuffer | string): Promise<void> {
    await this.ensureInitialized();

    const connState = this.connections.get(ws);
    if (!connState) {
      ws.close(4001, 'Unknown connection');
      return;
    }

    try {
      const rawData = typeof data === 'string' ? data : new TextDecoder().decode(data);
      const message: TeamClientMessage = JSON.parse(rawData);

      switch (message.type) {
        case 'teamSync':
          this.handleTeamSync(ws, connState);
          break;
        case 'uploadIdentityKey':
          this.handleUploadIdentityKey(ws, connState, message.publicKeyJwk);
          break;
        case 'requestIdentityKey':
          this.handleRequestIdentityKey(ws, message.targetUserId);
          break;
        case 'requestKeyEnvelope':
          this.handleRequestKeyEnvelope(ws, connState);
          break;
        case 'docIndexSync':
          this.handleDocIndexSync(ws);
          break;
        case 'docIndexRegister':
          this.handleDocIndexRegister(ws, connState, message.documentId, message.encryptedTitle, message.titleIv, message.documentType);
          break;
        case 'docIndexUpdate':
          this.handleDocIndexUpdate(ws, connState, message.documentId, message.encryptedTitle, message.titleIv);
          break;
        case 'docIndexRemove':
          this.handleDocIndexRemove(ws, connState, message.documentId);
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

  // ==========================================================================
  // Team Sync
  // ==========================================================================

  private handleTeamSync(ws: WebSocket, connState: ConnectionState): void {
    const sql = this.state.storage.sql;

    // Team metadata
    const metaRow = sql.exec<{
      org_id: string; name: string; git_remote_hash: string | null;
      created_by: string; created_at: number;
    }>(`SELECT org_id, name, git_remote_hash, created_by, created_at FROM team_metadata LIMIT 1`).toArray()[0];

    // Members
    const memberRows = sql.exec<{
      user_id: string; role: string; email: string | null;
    }>(`SELECT user_id, role, email FROM member_roles ORDER BY user_id`).toArray();

    // Build member info with key/envelope status
    const envelopeUserIds = new Set(
      sql.exec<{ target_user_id: string }>(`SELECT target_user_id FROM key_envelopes`).toArray().map(r => r.target_user_id)
    );
    const identityKeyUserIds = new Set(
      sql.exec<{ user_id: string }>(`SELECT user_id FROM identity_keys`).toArray().map(r => r.user_id)
    );

    const members: MemberInfo[] = memberRows.map(row => ({
      userId: row.user_id,
      role: row.role,
      email: row.email,
      hasKeyEnvelope: envelopeUserIds.has(row.user_id),
      hasIdentityKey: identityKeyUserIds.has(row.user_id),
    }));

    // Caller's own key envelope
    const envelopeRow = sql.exec<{
      wrapped_key: string; iv: string; sender_public_key: string; sender_user_id: string;
    }>(`SELECT wrapped_key, iv, sender_public_key, sender_user_id FROM key_envelopes WHERE target_user_id = ?`,
      connState.auth.userId
    ).toArray()[0];

    // Documents
    const docRows = sql.exec<{
      document_id: string; encrypted_title: string; title_iv: string;
      document_type: string; created_by: string; created_at: number; updated_at: number;
    }>(`SELECT * FROM document_index ORDER BY updated_at DESC`).toArray();

    const documents: EncryptedDocIndexEntry[] = docRows.map(row => ({
      documentId: row.document_id,
      encryptedTitle: row.encrypted_title,
      titleIv: row.title_iv,
      documentType: row.document_type,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    // Current org key fingerprint (if set)
    const orgKeyFpRow = sql.exec<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'current_org_key_fingerprint'`
    ).toArray()[0];

    const team: TeamState = {
      metadata: metaRow ? {
        orgId: metaRow.org_id,
        name: metaRow.name,
        gitRemoteHash: metaRow.git_remote_hash,
        createdBy: metaRow.created_by,
        createdAt: metaRow.created_at,
        currentOrgKeyFingerprint: orgKeyFpRow?.value ?? null,
      } : null,
      members,
      documents,
      keyEnvelope: envelopeRow ? {
        wrappedKey: envelopeRow.wrapped_key,
        iv: envelopeRow.iv,
        senderPublicKey: envelopeRow.sender_public_key,
        senderUserId: envelopeRow.sender_user_id || undefined,
      } : null,
    };

    const response: TeamServerMessage = { type: 'teamSyncResponse', team };
    ws.send(JSON.stringify(response));
    connState.synced = true;
  }

  // ==========================================================================
  // Identity Key Management (WebSocket)
  // ==========================================================================

  private handleUploadIdentityKey(ws: WebSocket, connState: ConnectionState, publicKeyJwk: string): void {
    const sql = this.state.storage.sql;
    const now = Date.now();

    sql.exec(
      `INSERT INTO identity_keys (user_id, public_key_jwk, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         public_key_jwk = excluded.public_key_jwk,
         updated_at = excluded.updated_at`,
      connState.auth.userId, publicKeyJwk, now, now
    );

    // Broadcast to other members so they can wrap the org key for this user
    this.broadcast(
      { type: 'identityKeyUploaded', userId: connState.auth.userId },
      ws // exclude the uploader
    );
  }

  private handleRequestIdentityKey(ws: WebSocket, targetUserId: string): void {
    const sql = this.state.storage.sql;
    const row = sql.exec<{ public_key_jwk: string }>(
      `SELECT public_key_jwk FROM identity_keys WHERE user_id = ?`, targetUserId
    ).toArray()[0];

    if (!row) {
      this.sendError(ws, 'identity_key_not_found', `No identity key found for user ${targetUserId}`);
      return;
    }

    const response: TeamServerMessage = {
      type: 'identityKeyResponse',
      userId: targetUserId,
      publicKeyJwk: row.public_key_jwk,
    };
    ws.send(JSON.stringify(response));
  }

  // ==========================================================================
  // Key Envelope Management (WebSocket read, internal HTTP write)
  // ==========================================================================

  private handleRequestKeyEnvelope(ws: WebSocket, connState: ConnectionState): void {
    const sql = this.state.storage.sql;
    const row = sql.exec<{
      wrapped_key: string; iv: string; sender_public_key: string; sender_user_id: string;
    }>(
      `SELECT wrapped_key, iv, sender_public_key, sender_user_id FROM key_envelopes WHERE target_user_id = ?`,
      connState.auth.userId
    ).toArray()[0];

    if (!row) {
      this.sendError(ws, 'no_key_envelope', 'No key envelope found');
      return;
    }

    const response: TeamServerMessage = {
      type: 'keyEnvelope',
      wrappedKey: row.wrapped_key,
      iv: row.iv,
      senderPublicKey: row.sender_public_key,
      senderUserId: row.sender_user_id,
    };
    ws.send(JSON.stringify(response));
  }

  // ==========================================================================
  // Document Index (WebSocket)
  // ==========================================================================

  private handleDocIndexSync(ws: WebSocket): void {
    const sql = this.state.storage.sql;
    const rows = sql.exec<{
      document_id: string; encrypted_title: string; title_iv: string;
      document_type: string; created_by: string; created_at: number; updated_at: number;
    }>(`SELECT * FROM document_index ORDER BY updated_at DESC`).toArray();

    const documents: EncryptedDocIndexEntry[] = rows.map(row => ({
      documentId: row.document_id,
      encryptedTitle: row.encrypted_title,
      titleIv: row.title_iv,
      documentType: row.document_type,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    const response: TeamServerMessage = { type: 'docIndexSyncResponse', documents };
    ws.send(JSON.stringify(response));
  }

  private handleDocIndexRegister(
    ws: WebSocket, connState: ConnectionState,
    documentId: string, encryptedTitle: string, titleIv: string, documentType: string
  ): void {
    const sql = this.state.storage.sql;
    const now = Date.now();

    sql.exec(
      `INSERT INTO document_index (document_id, encrypted_title, title_iv, document_type, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (document_id) DO UPDATE SET
         encrypted_title = excluded.encrypted_title,
         title_iv = excluded.title_iv,
         document_type = excluded.document_type,
         updated_at = excluded.updated_at`,
      documentId, encryptedTitle, titleIv, documentType, connState.auth.userId, now, now
    );

    const entry: EncryptedDocIndexEntry = {
      documentId, encryptedTitle, titleIv, documentType,
      createdBy: connState.auth.userId, createdAt: now, updatedAt: now,
    };

    this.broadcast({ type: 'docIndexBroadcast', document: entry }, ws);
    this.setMetadataValue('updated_at', String(now));
  }

  private handleDocIndexUpdate(
    ws: WebSocket, connState: ConnectionState,
    documentId: string, encryptedTitle: string, titleIv: string
  ): void {
    const sql = this.state.storage.sql;
    const now = Date.now();

    const existing = sql.exec<{ created_by: string; created_at: number; document_type: string }>(
      `SELECT created_by, created_at, document_type FROM document_index WHERE document_id = ?`, documentId
    ).toArray()[0];

    if (!existing) {
      this.sendError(ws, 'document_not_found', `Document ${documentId} not found in index`);
      return;
    }

    sql.exec(
      `UPDATE document_index SET encrypted_title = ?, title_iv = ?, updated_at = ? WHERE document_id = ?`,
      encryptedTitle, titleIv, now, documentId
    );

    const entry: EncryptedDocIndexEntry = {
      documentId, encryptedTitle, titleIv,
      documentType: existing.document_type,
      createdBy: existing.created_by,
      createdAt: existing.created_at,
      updatedAt: now,
    };

    this.broadcast({ type: 'docIndexBroadcast', document: entry }, ws);
    this.setMetadataValue('updated_at', String(now));
  }

  private handleDocIndexRemove(ws: WebSocket, connState: ConnectionState, documentId: string): void {
    const sql = this.state.storage.sql;

    sql.exec(`DELETE FROM document_index WHERE document_id = ?`, documentId);

    this.broadcast({ type: 'docIndexRemoveBroadcast', documentId }, ws);
    this.setMetadataValue('updated_at', String(Date.now()));

    // Cascade: delete the TeamDocumentRoom DO state so resharing gets a fresh document
    const orgId = connState.auth.orgId;
    const roomId = `org:${orgId}:doc:${documentId}`;
    const doId = this.env.DOCUMENT_ROOM.idFromName(roomId);
    const stub = this.env.DOCUMENT_ROOM.get(doId);
    stub.fetch(new Request(`https://internal/sync/${roomId}/delete`, { method: 'DELETE' }))
      .catch((err: unknown) => log.warn('Failed to delete TeamDocumentRoom for', documentId, err));
  }

  // ==========================================================================
  // Internal HTTP Mutations (forwarded from Worker)
  // ==========================================================================

  private async handleInternalMutation(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const sql = this.state.storage.sql;

    try {
      const body = await request.json() as Record<string, unknown>;
      const now = Date.now();

      if (path.endsWith('/internal/add-member')) {
        const { userId, role, email } = body as { userId: string; role: string; email?: string };
        if (!userId || !role) return this.jsonError('userId and role required', 400);

        sql.exec(
          `INSERT INTO member_roles (user_id, role, email, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET
             role = excluded.role,
             email = COALESCE(excluded.email, member_roles.email),
             updated_at = excluded.updated_at`,
          userId, role, email ?? null, now
        );

        const member: MemberInfo = {
          userId,
          role,
          email: (email as string) ?? null,
          hasKeyEnvelope: false,
          hasIdentityKey: false,
        };
        this.broadcast({ type: 'memberAdded', member });
        return this.jsonOk({ success: true });
      }

      if (path.endsWith('/internal/remove-member')) {
        const { userId } = body as { userId: string };
        if (!userId) return this.jsonError('userId required', 400);

        // Close connections BEFORE deleting member data.
        // If connection closure fails, the member stays in the team
        // rather than being removed with live connections still open.
        try {
          await this.closeUserConnectionsOnRooms(userId);
        } catch (err) {
          return this.jsonError(
            `Cannot remove member: failed to revoke active connections. ${err instanceof Error ? err.message : String(err)}`,
            503
          );
        }

        sql.exec(`DELETE FROM member_roles WHERE user_id = ?`, userId);
        sql.exec(`DELETE FROM key_envelopes WHERE target_user_id = ?`, userId);
        sql.exec(`DELETE FROM identity_keys WHERE user_id = ?`, userId);

        this.broadcast({ type: 'memberRemoved', userId });

        return this.jsonOk({ success: true });
      }

      if (path.endsWith('/internal/update-role')) {
        const { userId, role } = body as { userId: string; role: string };
        if (!userId || !role) return this.jsonError('userId and role required', 400);

        sql.exec(
          `UPDATE member_roles SET role = ?, updated_at = ? WHERE user_id = ?`,
          role, now, userId
        );

        this.broadcast({ type: 'memberRoleChanged', userId, role });
        return this.jsonOk({ success: true });
      }

      if (path.endsWith('/internal/set-metadata')) {
        const { orgId, name, gitRemoteHash, createdBy } = body as {
          orgId?: string; name?: string; gitRemoteHash?: string | null; createdBy?: string;
        };

        // Check if metadata exists
        const existing = sql.exec<{ org_id: string }>(
          `SELECT org_id FROM team_metadata LIMIT 1`
        ).toArray()[0];

        if (existing) {
          // Update existing
          if (name !== undefined) {
            sql.exec(`UPDATE team_metadata SET name = ?, updated_at = ?`, name, now);
          }
          if (gitRemoteHash !== undefined) {
            sql.exec(`UPDATE team_metadata SET git_remote_hash = ?, updated_at = ?`, gitRemoteHash, now);
          }
        } else if (orgId && name && createdBy) {
          // Insert new
          sql.exec(
            `INSERT INTO team_metadata (org_id, name, git_remote_hash, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            orgId, name, gitRemoteHash ?? null, createdBy, now, now
          );
        } else {
          return this.jsonError('orgId, name, and createdBy required for initial metadata', 400);
        }

        return this.jsonOk({ success: true });
      }

      if (path.endsWith('/internal/upload-envelope')) {
        const { targetUserId, wrappedKey, iv, senderPublicKey, senderUserId } = body as {
          targetUserId: string; wrappedKey: string; iv: string; senderPublicKey: string; senderUserId?: string;
        };
        if (!targetUserId || !wrappedKey || !iv || !senderPublicKey) {
          return this.jsonError('targetUserId, wrappedKey, iv, senderPublicKey required', 400);
        }

        // Validate senderPublicKey is a well-formed P-256 public key
        const keyError = validateP256PublicKey(senderPublicKey);
        if (keyError) {
          return this.jsonError(`Invalid senderPublicKey: ${keyError}`, 400);
        }

        sql.exec(
          `INSERT INTO key_envelopes (target_user_id, sender_user_id, wrapped_key, iv, sender_public_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (target_user_id) DO UPDATE SET
             sender_user_id = excluded.sender_user_id,
             wrapped_key = excluded.wrapped_key,
             iv = excluded.iv,
             sender_public_key = excluded.sender_public_key,
             created_at = excluded.created_at`,
          targetUserId, senderUserId ?? '', wrappedKey, iv, senderPublicKey, now
        );

        // Push notification to target user if connected
        this.broadcastToUser(targetUserId, { type: 'keyEnvelopeAvailable', targetUserId });
        return this.jsonOk({ success: true });
      }

      if (path.endsWith('/internal/delete-envelope')) {
        const { targetUserId } = body as { targetUserId: string };
        if (!targetUserId) return this.jsonError('targetUserId required', 400);

        sql.exec(`DELETE FROM key_envelopes WHERE target_user_id = ?`, targetUserId);
        return this.jsonOk({ success: true });
      }

      if (path.endsWith('/internal/delete-all-envelopes')) {
        sql.exec(`DELETE FROM key_envelopes`);
        return this.jsonOk({ success: true });
      }

      if (path.endsWith('/internal/upload-identity-key')) {
        const { userId, publicKeyJwk } = body as { userId: string; publicKeyJwk: string };
        if (!userId || !publicKeyJwk) return this.jsonError('userId and publicKeyJwk required', 400);

        sql.exec(
          `INSERT INTO identity_keys (user_id, public_key_jwk, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET
             public_key_jwk = excluded.public_key_jwk,
             updated_at = excluded.updated_at`,
          userId, publicKeyJwk, now, now
        );
        return this.jsonOk({ success: true });
      }

      if (path.endsWith('/internal/set-org-key-fingerprint')) {
        const { fingerprint } = body as { fingerprint: string };
        if (!fingerprint) return this.jsonError('fingerprint required', 400);

        this.setMetadataValue('current_org_key_fingerprint', fingerprint);
        this.broadcast({ type: 'orgKeyRotated', fingerprint });
        return this.jsonOk({ success: true });
      }

      if (path.endsWith('/internal/seed')) {
        // Phase 5: one-time D1 data seeding. Stub for now.
        return this.jsonOk({ success: true, seeded: false, message: 'Seeding not yet implemented' });
      }

      return this.jsonError('Unknown internal endpoint', 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Internal mutation error:', msg);
      return this.jsonError(`Internal error: ${msg}`, 500);
    }
  }

  // ==========================================================================
  // Internal Read Queries (forwarded from Worker via GET)
  // ==========================================================================

  private async handleInternalQuery(url: URL): Promise<Response> {
    const path = url.pathname;
    const sql = this.state.storage.sql;

    try {
      await this.ensureInitialized();

      // GET /internal/get-metadata
      // Returns team metadata { name, gitRemoteHash, createdAt } or 404 if not initialized
      if (path.endsWith('/internal/get-metadata')) {
        const row = sql.exec<{
          name: string; git_remote_hash: string | null; created_at: number;
        }>(`SELECT name, git_remote_hash, created_at FROM team_metadata LIMIT 1`).toArray()[0];

        if (!row) {
          return this.jsonError('Team not initialized', 404);
        }
        return this.jsonOk({
          name: row.name,
          gitRemoteHash: row.git_remote_hash,
          createdAt: row.created_at,
        });
      }

      // GET /internal/get-member-role?userId=...
      // Returns { role: string } or 404 if not a member
      if (path.endsWith('/internal/get-member-role')) {
        const userId = url.searchParams.get('userId');
        if (!userId) return this.jsonError('userId query param required', 400);

        const row = sql.exec<{ role: string }>(
          `SELECT role FROM member_roles WHERE user_id = ?`, userId
        ).toArray()[0];

        if (!row) {
          return this.jsonError('Not a member', 404);
        }
        return this.jsonOk({ role: row.role });
      }

      // GET /internal/list-members
      // Returns { members: Array<{ userId, role, email }> }
      if (path.endsWith('/internal/list-members')) {
        const rows = sql.exec<{ user_id: string; role: string; email: string | null }>(
          `SELECT user_id, role, email FROM member_roles`
        ).toArray();

        const members = rows.map(r => ({
          userId: r.user_id,
          role: r.role,
          email: r.email,
        }));
        return this.jsonOk({ members });
      }

      // GET /internal/get-org-key-fingerprint
      // Returns { fingerprint } (null if not yet set)
      if (path.endsWith('/internal/get-org-key-fingerprint')) {
        const row = sql.exec<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'current_org_key_fingerprint'`
        ).toArray()[0];
        return this.jsonOk({ fingerprint: row?.value ?? null });
      }

      // GET /internal/get-key-envelope?userId=...
      // Returns the key envelope for a specific user, or 404
      if (path.endsWith('/internal/get-key-envelope')) {
        const userId = url.searchParams.get('userId');
        if (!userId) return this.jsonError('userId query param required', 400);

        const row = sql.exec<{
          wrapped_key: string; iv: string; sender_public_key: string; sender_user_id: string; created_at: number;
        }>(
          `SELECT wrapped_key, iv, sender_public_key, sender_user_id, created_at
           FROM key_envelopes WHERE target_user_id = ?`, userId
        ).toArray()[0];

        if (!row) {
          return this.jsonError('No key envelope found', 404);
        }
        return this.jsonOk({
          wrappedKey: row.wrapped_key,
          iv: row.iv,
          senderPublicKey: row.sender_public_key,
          senderUserId: row.sender_user_id,
          createdAt: row.created_at,
        });
      }

      // GET /internal/list-key-envelopes
      // Returns { envelopes: Array<{ targetUserId, createdAt }> }
      if (path.endsWith('/internal/list-key-envelopes')) {
        const rows = sql.exec<{ target_user_id: string; created_at: number }>(
          `SELECT target_user_id, created_at FROM key_envelopes`
        ).toArray();

        const envelopes = rows.map(r => ({
          targetUserId: r.target_user_id,
          createdAt: r.created_at,
        }));
        return this.jsonOk({ envelopes });
      }

      // GET /internal/get-identity-key?userId=...
      // Returns { publicKeyJwk, updatedAt } or 404
      if (path.endsWith('/internal/get-identity-key')) {
        const userId = url.searchParams.get('userId');
        if (!userId) return this.jsonError('userId query param required', 400);

        const row = sql.exec<{ public_key_jwk: string; updated_at: number }>(
          `SELECT public_key_jwk, updated_at FROM identity_keys WHERE user_id = ?`, userId
        ).toArray()[0];

        if (!row) {
          return this.jsonError('Public key not found', 404);
        }
        return this.jsonOk({
          userId,
          publicKeyJwk: row.public_key_jwk,
          updatedAt: row.updated_at,
        });
      }

      // GET /internal/list-document-ids
      // Returns { documentIds: string[], orgId: string, gitRemoteHash: string | null }
      if (path.endsWith('/internal/list-document-ids')) {
        const docs = sql.exec<{ document_id: string }>(
          `SELECT document_id FROM document_index`
        ).toArray();
        const meta = sql.exec<{ org_id: string; git_remote_hash: string | null }>(
          `SELECT org_id, git_remote_hash FROM team_metadata LIMIT 1`
        ).toArray()[0];
        return this.jsonOk({
          documentIds: docs.map(d => d.document_id),
          orgId: meta?.org_id ?? null,
          gitRemoteHash: meta?.git_remote_hash ?? null,
        });
      }

      return this.jsonError('Unknown internal query endpoint', 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Internal query error:', msg);
      return this.jsonError(`Internal error: ${msg}`, 500);
    }
  }

  // ==========================================================================
  // Broadcasting
  // ==========================================================================

  private broadcast(message: TeamServerMessage, exclude?: WebSocket): void {
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

  /** Send a message to a specific user's connections only. */
  private broadcastToUser(targetUserId: string, message: TeamServerMessage): void {
    const data = JSON.stringify(message);
    for (const [ws, state] of this.connections) {
      if (state.auth.userId === targetUserId && state.synced) {
        try {
          ws.send(data);
        } catch (err) {
          log.error('User broadcast error:', err);
          this.connections.delete(ws);
        }
      }
    }
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private sendError(ws: WebSocket, code: string, message: string): void {
    ws.send(JSON.stringify({ type: 'error', code, message }));
  }

  private setMetadataValue(key: string, value: string): void {
    const sql = this.state.storage.sql;
    sql.exec(
      `INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)`,
      key, value, Date.now()
    );
  }

  private jsonOk(data: unknown): Response {
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private jsonError(error: string, status: number): Response {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ==========================================================================
  // WebSocket Lifecycle
  // ==========================================================================

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

  // ==========================================================================
  // Cross-DO connection closure (member removal)
  // ==========================================================================

  /**
   * Close a removed user's connections on all document and tracker rooms
   * owned by this org. This prevents the removed member from continuing
   * to read/write via existing WebSocket connections.
   */
  private async closeUserConnectionsOnRooms(userId: string): Promise<void> {
    const sql = this.state.storage.sql;

    // Get org metadata for room ID construction
    const meta = sql.exec<{ org_id: string; git_remote_hash: string | null }>(
      `SELECT org_id, git_remote_hash FROM team_metadata LIMIT 1`
    ).toArray()[0];
    if (!meta) return;

    const orgId = meta.org_id;
    const closeBody = JSON.stringify({ userId });
    const headers = { 'Content-Type': 'application/json' };

    // Close connections on all document rooms
    const docs = sql.exec<{ document_id: string }>(
      `SELECT document_id FROM document_index`
    ).toArray();

    const promises: Promise<{ roomId: string; ok: boolean; error?: string }>[] = [];

    for (const doc of docs) {
      const roomId = `org:${orgId}:doc:${doc.document_id}`;
      const doId = this.env.DOCUMENT_ROOM.idFromName(roomId);
      const stub = this.env.DOCUMENT_ROOM.get(doId);
      const url = `http://internal/sync/${roomId}/internal/close-user-connections`;
      promises.push(
        stub.fetch(new Request(url, { method: 'POST', headers, body: closeBody }))
          .then(() => ({ roomId, ok: true }))
          .catch(err => ({ roomId, ok: false, error: String(err) }))
      );
    }

    // Close connections on the tracker room (project ID = git remote hash)
    if (meta.git_remote_hash) {
      const roomId = `org:${orgId}:tracker:${meta.git_remote_hash}`;
      const doId = this.env.TRACKER_ROOM.idFromName(roomId);
      const stub = this.env.TRACKER_ROOM.get(doId);
      const url = `http://internal/sync/${roomId}/internal/close-user-connections`;
      promises.push(
        stub.fetch(new Request(url, { method: 'POST', headers, body: closeBody }))
          .then(() => ({ roomId, ok: true }))
          .catch(err => ({ roomId, ok: false, error: String(err) }))
      );
    }

    const results = await Promise.all(promises);
    const failures = results.filter(r => !r.ok);
    if (failures.length > 0) {
      const failedRooms = failures.map(f => `${f.roomId}: ${f.error}`).join('; ');
      log.error(`Failed to close connections for user ${userId} in ${failures.length} room(s): ${failedRooms}`);
      throw new Error(`Connection revocation failed for ${failures.length} room(s). Member removal aborted to prevent stale access.`);
    }
    log.info(`Propagated connection closure for user ${userId} to ${docs.length} doc room(s) + tracker room`);
  }

  // ==========================================================================
  // TTL Alarm
  // ==========================================================================

  private async scheduleExpiryAlarm(): Promise<void> {
    if (this.connections.size > 0) return;
    await this.state.storage.setAlarm(Date.now() + TEAM_TTL_MS);
  }

  async alarm(): Promise<void> {
    await this.ensureInitialized();

    if (this.connections.size > 0) {
      log.info('Alarm fired but team has active connections, rescheduling');
      await this.scheduleExpiryAlarm();
      return;
    }

    const sql = this.state.storage.sql;
    const row = sql.exec<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'updated_at'`
    ).toArray()[0];

    const lastActivity = row ? parseInt(row.value, 10) : 0;
    const elapsed = Date.now() - lastActivity;

    if (elapsed < TEAM_TTL_MS) {
      const remaining = TEAM_TTL_MS - elapsed;
      await this.state.storage.setAlarm(Date.now() + remaining);
      log.info('Alarm fired early, rescheduling for', remaining, 'ms');
      return;
    }

    log.info('Team TTL expired, deleting data. Last activity:', lastActivity);
    sql.exec(`DELETE FROM team_metadata`);
    sql.exec(`DELETE FROM member_roles`);
    sql.exec(`DELETE FROM identity_keys`);
    sql.exec(`DELETE FROM key_envelopes`);
    sql.exec(`DELETE FROM document_index`);
    sql.exec(`DELETE FROM metadata`);
  }

  // ==========================================================================
  // Account Deletion & Status
  // ==========================================================================

  private async handleDeleteAccount(): Promise<Response> {
    // Close all WebSocket connections first so no writes race the delete.
    for (const [ws] of this.connections) {
      try { ws.close(4003, 'Account deleted'); } catch { /* noop */ }
    }
    this.connections.clear();

    // Bulk-drop all storage. Per-table `DELETE FROM` previously hit the DO
    // storage operation timeout on large teams and reset the DO mid-delete.
    await this.state.storage.deleteAll();

    return this.jsonOk({ deleted: true });
  }

  private handleStatusRequest(): Response {
    const sql = this.state.storage.sql;

    const memberCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM member_roles`
    ).toArray()[0]?.count ?? 0;

    const documentCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM document_index`
    ).toArray()[0]?.count ?? 0;

    const envelopeCount = sql.exec<{ count: number }>(
      `SELECT COUNT(*) as count FROM key_envelopes`
    ).toArray()[0]?.count ?? 0;

    return new Response(JSON.stringify({
      roomId: this.state.id.toString(),
      connections: this.connections.size,
      memberCount,
      documentCount,
      envelopeCount,
    }), { headers: { 'Content-Type': 'application/json' } });
  }
}
