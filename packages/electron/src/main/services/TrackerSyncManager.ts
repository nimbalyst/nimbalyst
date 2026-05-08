/**
 * TrackerSyncManager - Manages optional tracker item sync via TrackerRoom.
 *
 * This service bridges the TrackerSyncProvider (runtime) to the Electron main process:
 * - Reads sync config and auth from SyncManager's infrastructure
 * - Instantiates TrackerSyncProvider per project (supports multiple workspaces)
 * - Hydrates decrypted items into local PGLite tracker_items table
 * - Sends IPC events to renderer for status changes and item mutations
 *
 * Tracker sync is completely optional. If sync is not enabled or the user
 * is not authenticated, nothing happens.
 */

import { BrowserWindow } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { getNormalizedGitRemote } from '../utils/gitUtils';
import { database } from '../database/PGLiteDatabaseWorker';
import { getSessionSyncConfig } from '../utils/store';
import { getStytchUserId, isAuthenticated } from './StytchAuthService';
import { findTeamForWorkspace, getOrgScopedJwt, autoWrapForNewMembers } from './TeamService';
import { getOrgKey, getOrgKeyFingerprint, clearOrgKey, fetchAndUnwrapOrgKey, getOrCreateIdentityKeyPair, uploadIdentityKeyToOrg } from './OrgKeyService';
import { windows as windowMap, windowStates } from '../window/windowState';
import { removeInlineTrackerItem } from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterUtils';
import type { TrackerSyncStatus, TrackerItemPayload } from '@nimbalyst/runtime/sync';
import * as syncModule from '@nimbalyst/runtime/sync';
import { DEFAULT_SLOW_STARTUP_MS } from '../utils/startupTiming';

function loadSyncModule() {
  return syncModule;
}


// ============================================================================
// State - per-workspace connections
// ============================================================================

interface WorkspaceSyncState {
  provider: import('@nimbalyst/runtime/sync').TrackerSyncProvider;
  encryptionKey: CryptoKey;
  projectId: string;
  status: TrackerSyncStatus;
  /** Test-only: userId injected by tracker-sync:connect-test for E2E tests */
  testUserId?: string;
}

/** Map from workspace path to its sync state */
const workspaceStates = new Map<string, WorkspaceSyncState>();

// Status listeners
type TrackerSyncStatusListener = (status: TrackerSyncStatus) => void;
const statusListeners = new Set<TrackerSyncStatusListener>();

function buildPayloadsFromRows(
  rows: any[],
  userId: string,
): TrackerItemPayload[] {
  const { trackerItemToPayload } = loadSyncModule();
  const payloads: TrackerItemPayload[] = [];
  for (const row of rows) {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const item = {
      id: row.id,
      issueNumber: row.issue_number ?? undefined,
      issueKey: row.issue_key ?? undefined,
      type: row.type,
      title: data.title || row.title,
      description: data.description,
      status: data.status || row.status,
      priority: data.priority,
      owner: data.owner,
      module: row.document_path,
      workspace: row.workspace,
      tags: data.tags,
      created: data.created || row.created,
      updated: data.updated || row.updated,
      lastIndexed: new Date(row.last_indexed),
      authorIdentity: data.authorIdentity,
      lastModifiedBy: data.lastModifiedBy,
      createdByAgent: data.createdByAgent,
      assigneeEmail: data.assigneeEmail,
      reporterEmail: data.reporterEmail,
      assigneeId: data.assigneeId,
      reporterId: data.reporterId,
      labels: data.labels,
      linkedCommitSha: data.linkedCommitSha,
      documentId: data.documentId,
      content: row.content != null ? row.content : undefined,
      // Thread persisted per-field LWW timestamps through to the upload payload.
      // Without this, trackerItemToRecord stamps every field with Date.now(),
      // making field-level merge non-deterministic for items uploaded from PGLite.
      fieldUpdatedAt: data._fieldUpdatedAt || undefined,
    };
    const itemKeys = new Set(Object.keys(item));
    const extra: Record<string, any> = {};
    if (data) {
      for (const [k, v] of Object.entries(data)) {
        // Skip _fieldUpdatedAt: it is consumed via item.fieldUpdatedAt above
        // and is not a user field. linkedSessions remains local-only and must
        // never be promoted back into shared tracker payloads as a custom field.
        if (k === '_fieldUpdatedAt' || k === 'linkedSessions') continue;
        if (!itemKeys.has(k) && v !== undefined) extra[k] = v;
      }
    }
    if (data.customFields && typeof data.customFields === 'object') {
      Object.assign(extra, data.customFields);
    }
    if (Object.keys(extra).length > 0) (item as any).customFields = extra;
    payloads.push(trackerItemToPayload(item as any, userId));
  }
  return payloads;
}

async function uploadTrackerRows(
  provider: import('@nimbalyst/runtime/sync').TrackerSyncProvider,
  rows: any[],
  userId: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const payloads = buildPayloadsFromRows(rows, userId);
  await provider.batchUpsertItems(payloads);
  return payloads.length;
}

// ============================================================================
// IPC Broadcasting
// ============================================================================

function sendToAllWindows(channel: string, data?: unknown): void {
  const windows = BrowserWindow.getAllWindows();
  logger.main.debug(`[TrackerSyncManager] sendToAllWindows(${channel}) to ${windows.length} window(s)`);
  windows.forEach(window => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, data);
    } else {
      logger.main.warn(`[TrackerSyncManager] Skipping destroyed window`);
    }
  });
}

/**
 * Send an IPC message only to windows that belong to a specific workspace.
 * Prevents tracker items from leaking across workspaces in the renderer.
 */
function sendToWorkspaceWindows(workspacePath: string, channel: string, data?: unknown): void {
  let sent = 0;
  for (const [windowId, browserWindow] of windowMap as Map<number, BrowserWindow>) {
    if (browserWindow.isDestroyed()) continue;
    const state = windowStates.get(windowId);
    if (state?.workspacePath === workspacePath) {
      browserWindow.webContents.send(channel, data);
      sent++;
    }
  }
  logger.main.debug(`[TrackerSyncManager] sendToWorkspaceWindows(${channel}, ${workspacePath}) sent to ${sent} window(s)`);
}

// ============================================================================
// Project Identity
// ============================================================================

// ============================================================================
// Internal helpers
// ============================================================================

/** Get the aggregate status across all workspace connections */
function getAggregateStatus(): TrackerSyncStatus {
  if (workspaceStates.size === 0) return 'disconnected';
  const statuses = Array.from(workspaceStates.values()).map(s => s.status);
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('connected')) return 'connected';
  if (statuses.includes('connecting')) return 'connecting';
  return 'disconnected';
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Subscribe to tracker sync status changes.
 */
export function onTrackerSyncStatusChange(listener: TrackerSyncStatusListener): () => void {
  statusListeners.add(listener);
  listener(getAggregateStatus());
  return () => statusListeners.delete(listener);
}

/**
 * Get the current tracker sync status.
 */
export function getTrackerSyncStatus(): TrackerSyncStatus {
  return getAggregateStatus();
}

/**
 * Get the TrackerSyncProvider instance for a workspace (if connected).
 */
export function getTrackerSyncProvider(workspacePath?: string): import('@nimbalyst/runtime/sync').TrackerSyncProvider | null {
  if (workspacePath) {
    return workspaceStates.get(workspacePath)?.provider ?? null;
  }
  // Fallback: return first connected provider (for backward compat)
  for (const ws of workspaceStates.values()) {
    if (ws.provider) return ws.provider;
  }
  return null;
}

/**
 * Trigger an immediate reconnect on every active TrackerSyncProvider. Called
 * by SyncManager.attemptReconnect after the CollabV3 index is confirmed ready,
 * so each tracker WS bypasses its internal backoff and reconnects right away.
 */
export function reconnectAllTrackerSyncs(): void {
  for (const [workspacePath, state] of workspaceStates) {
    try {
      state.provider.reconnectNow();
    } catch (err) {
      console.error(`[TrackerSyncManager] reconnectNow failed for ${workspacePath}:`, err);
    }
  }
}

/**
 * Check if tracker sync is active for a given workspace (or any workspace).
 */
export function isTrackerSyncActive(workspacePath?: string): boolean {
  if (workspacePath) {
    return workspaceStates.has(workspacePath);
  }
  return workspaceStates.size > 0;
}

/**
 * Initialize tracker sync for a workspace.
 *
 * Requires:
 * - Session sync enabled in settings
 * - User authenticated with Stytch
 * - Workspace has a git remote (for project identity)
 */
export async function initializeTrackerSync(workspacePath: string): Promise<void> {
  logger.main.debug('[TrackerSyncManager] initializeTrackerSync called', { workspacePath });

  // If already connected for this workspace, skip
  if (workspaceStates.has(workspacePath)) {
    return;
  }

  // Read sync config for server URL / environment only.
  // Tracker sync connects whenever the workspace is matched to a team --
  // it does NOT require session/document sync to be enabled.
  const config = getSessionSyncConfig();

  // Require authentication
  if (!isAuthenticated()) {
    return;
  }

  const userId = getStytchUserId();
  if (!userId) {
    return;
  }

  // Get git remote once -- used both for team lookup and as the projectId
  const projectId = await getNormalizedGitRemote(workspacePath);
  if (!projectId) {
    return;
  }

  // Look up the team org for this workspace (by git remote match)
  // Users auth to their personal org, but tracker rooms are scoped to team orgs
  const team = await findTeamForWorkspace(workspacePath, projectId);
  if (!team) {
    return;
  }
  const orgId = team.orgId;

  // Determine server URL (same logic as SyncManager)
  const PRODUCTION_SYNC_URL = 'wss://sync.nimbalyst.com';
  const DEVELOPMENT_SYNC_URL = 'ws://localhost:8790';
  const isDevelopmentBuild = process.env.NODE_ENV !== 'production';
  const effectiveEnvironment = isDevelopmentBuild ? config?.environment : undefined;
  const serverUrl = effectiveEnvironment === 'development' ? DEVELOPMENT_SYNC_URL : PRODUCTION_SYNC_URL;

  try {
    // logger.main.info('[TrackerSyncManager] Connecting tracker sync', { orgId, projectId });

    const { TrackerSyncProvider, payloadToTrackerItem } = loadSyncModule();
    const preexistingSyncedRowsResult = await database.query<any>(
      `SELECT * FROM tracker_items WHERE workspace = $1 AND sync_status = 'synced'`,
      [workspacePath]
    );
    const preexistingSyncedRows = preexistingSyncedRowsResult.rows;

    // Use the shared org encryption key (distributed via key envelopes)
    // All team members share this key so they can decrypt each other's items
    let encryptionKey = await getOrgKey(orgId);
    if (!encryptionKey) {
      // Key not cached locally - try to fetch from server via key envelope
      try {
        const orgJwt = await getOrgScopedJwt(orgId);
        await getOrCreateIdentityKeyPair();
        await uploadIdentityKeyToOrg(orgJwt);
        encryptionKey = await fetchAndUnwrapOrgKey(orgId, orgJwt);
      } catch (err) {
        logger.main.warn('[TrackerSyncManager] Failed to fetch org key envelope:', err);
      }
      if (!encryptionKey) {
        logger.main.warn('[TrackerSyncManager] No org key available, skipping tracker sync');
        return;
      }
    }

    // Verify local key fingerprint against server to detect stale keys
    const localFingerprint = getOrgKeyFingerprint(orgId);
    if (localFingerprint) {
      try {
        const fpJwt = await getOrgScopedJwt(orgId);
        const { net } = await import('electron');
        const httpUrl = serverUrl.replace('wss://', 'https://').replace('ws://', 'http://');
        const fpResp = await net.fetch(`${httpUrl}/api/teams/${orgId}/org-key-fingerprint`, {
          headers: { 'Authorization': `Bearer ${fpJwt}` },
        });
        if (fpResp.ok) {
          const fpData = await fpResp.json() as { fingerprint: string | null };
          if (fpData.fingerprint && fpData.fingerprint !== localFingerprint) {
            logger.main.warn('[TrackerSyncManager] Stale key detected! Local:', localFingerprint.slice(0, 12), 'Server:', fpData.fingerprint.slice(0, 12));
            clearOrgKey(orgId);
            const freshJwt = await getOrgScopedJwt(orgId);
            encryptionKey = await fetchAndUnwrapOrgKey(orgId, freshJwt);
            if (!encryptionKey) {
              logger.main.warn('[TrackerSyncManager] Key rotation occurred, unable to fetch new key');
              return;
            }
          }
        }
      } catch (err) {
        logger.main.error('[TrackerSyncManager] Failed to verify key fingerprint:', err);
        // Fail-closed: do not connect with a potentially stale key
        return;
      }
    }

    // Fire-and-forget: wrap org key for any new team members missing envelopes
    autoWrapForNewMembers(orgId).catch(err => {
      logger.main.warn(`[TrackerSyncManager] Auto-wrap for new members of ${projectId} failed:`, err);
    });

    const orgKeyFingerprint = getOrgKeyFingerprint(orgId) ?? undefined;

    // After stale key verification, encryptionKey is guaranteed non-null
    // (we return early if re-fetch fails)
    const validatedKey = encryptionKey!;

    // Track wall-clock from connect() until hasMore:false so we can warn in
    // user logs when the initial websocket+decrypt loop is dragging. Set just
    // before provider.connect() below.
    let initialSyncStart: number | null = null;

    let provider: import('@nimbalyst/runtime/sync').TrackerSyncProvider;
    provider = new TrackerSyncProvider({
      serverUrl,
      orgId,
      projectId,
      userId,
      encryptionKey: validatedKey,
      orgKeyFingerprint,

      getJwt: async () => {
        // Use org-scoped JWT for the team org, not the personal session JWT
        const jwt = await getOrgScopedJwt(orgId);
        if (!jwt || jwt.split('.').length !== 3) {
          throw new Error('Failed to get valid JWT for tracker sync');
        }
        return jwt;
      },

      onStatusChange: (newStatus: TrackerSyncStatus) => {
        const wsState = workspaceStates.get(workspacePath);
        if (wsState) {
          wsState.status = newStatus;
        }
        statusListeners.forEach(listener => listener(getAggregateStatus()));
        sendToAllWindows('tracker-sync:status-changed', { workspacePath, status: newStatus });
      },

      onItemUpserted: (payload: TrackerItemPayload) => {
        hydrateTrackerItem(payload, workspacePath, payloadToTrackerItem)
          .catch(err => logger.main.error('[TrackerSyncManager] Failed to hydrate upserted item:', err));
      },

      onItemDeleted: (itemId: string) => {
        removeTrackerItem(itemId, workspacePath)
          .catch(err => logger.main.error('[TrackerSyncManager] Failed to remove deleted item:', err));
      },

      onConfigChanged: (config) => {
        // Broadcast config changes to renderer
        sendToWorkspaceWindows(workspacePath, 'tracker-sync:config-changed', {
          workspacePath,
          config,
        });
      },

      onDecryptFailed: async (itemId: string): Promise<TrackerItemPayload | null> => {
        try {
          const result = await database.query<any>(
            `SELECT * FROM tracker_items WHERE id = $1`,
            [itemId]
          );
          if (result.rows.length === 0) return null;
          const payloads = buildPayloadsFromRows(result.rows, userId);
          return payloads[0] ?? null;
        } catch (err) {
          logger.main.error('[TrackerSyncManager] Failed to build repair payload for:', itemId, err);
          return null;
        }
      },

      onInitialSyncComplete: async (summary) => {
        if (initialSyncStart !== null) {
          const duration = Date.now() - initialSyncStart;
          if (duration >= DEFAULT_SLOW_STARTUP_MS) {
            logger.main.info(
              `[StartupSlow] TrackerSync.initialSync(${projectId}) took ${duration}ms ` +
              `(threshold ${DEFAULT_SLOW_STARTUP_MS}ms, ${summary.remoteItemCount} items, ` +
              `${summary.remoteDeletedCount} deletions, sequence ${summary.sequence})`
            );
          }
          initialSyncStart = null;
        }

        if (
          summary.remoteItemCount !== 0 ||
          summary.remoteDeletedCount !== 0 ||
          summary.sequence !== 0
        ) {
          return;
        }

        try {
          if (preexistingSyncedRows.length === 0) {
            return;
          }

          await uploadTrackerRows(provider, preexistingSyncedRows, userId);
        } catch (err) {
          logger.main.warn('[TrackerSyncManager] Failed to recover synced tracker items for empty room:', err);
        }
      },
    });

    workspaceStates.set(workspacePath, {
      provider,
      encryptionKey: validatedKey,
      projectId,
      status: 'connecting',
    });

    // Connect
    // logger.main.info('[TrackerSyncManager] Connecting tracker sync', { serverUrl, orgId, projectId });
    initialSyncStart = Date.now();
    await provider.connect();

    // Push shareable unsynced items to the server.
    // `pending` means "should sync once a provider is available".
    // `local` means "never sync".
    try {
      const localResult = await database.query<any>(
        `SELECT * FROM tracker_items WHERE workspace = $1 AND (sync_status = 'pending' OR sync_status IS NULL)`,
        [workspacePath]
      );
      if (localResult.rows.length > 0) {
        await uploadTrackerRows(provider, localResult.rows, userId);
        // Mark items as synced
        const ids = localResult.rows.map((r: any) => r.id);
        await database.query(
          `UPDATE tracker_items SET sync_status = 'synced' WHERE id = ANY($1::text[])`,
          [ids]
        );
        // logger.main.info('[TrackerSyncManager] Uploaded', payloads.length, 'local items to server');
      }

    } catch (uploadErr) {
      // Non-fatal -- items can be synced individually later
      logger.main.warn('[TrackerSyncManager] Failed to upload local items:', uploadErr);
    }
  } catch (error) {
    logger.main.error('[TrackerSyncManager] Failed to initialize tracker sync:', error);
    workspaceStates.delete(workspacePath);
    statusListeners.forEach(listener => listener(getAggregateStatus()));
    sendToAllWindows('tracker-sync:status-changed', { workspacePath, status: 'error' });
  }
}

/**
 * Shutdown tracker sync for a specific workspace, or all workspaces.
 */
export function shutdownTrackerSync(workspacePath?: string): void {
  if (workspacePath) {
    const wsState = workspaceStates.get(workspacePath);
    if (wsState) {
      // logger.main.info('[TrackerSyncManager] Shutting down tracker sync for', workspacePath);
      wsState.provider.destroy();
      workspaceStates.delete(workspacePath);
      statusListeners.forEach(listener => listener(getAggregateStatus()));
      sendToAllWindows('tracker-sync:status-changed', { workspacePath, status: 'disconnected' });
    }
  } else {
    // Shut down all
    if (workspaceStates.size > 0) {
      // logger.main.info('[TrackerSyncManager] Shutting down all tracker sync connections...');
      for (const [wp, wsState] of workspaceStates) {
        wsState.provider.destroy();
        sendToAllWindows('tracker-sync:status-changed', { workspacePath: wp, status: 'disconnected' });
      }
      workspaceStates.clear();
      statusListeners.forEach(listener => listener('disconnected'));
    }
  }
}

/**
 * Reinitialize tracker sync (e.g., after settings change or auth change).
 */
export async function reinitializeTrackerSync(workspacePath: string): Promise<void> {
  shutdownTrackerSync(workspacePath);
  await initializeTrackerSync(workspacePath);
}

// ============================================================================
// PGLite Hydration
// ============================================================================

/**
 * Hydrate a synced tracker item into the local PGLite tracker_items table.
 * Called when TrackerSyncProvider delivers a decrypted item.
 */
async function hydrateTrackerItem(
  payload: TrackerItemPayload,
  workspacePath: string,
  payloadToTrackerItem: typeof import('@nimbalyst/runtime/sync').payloadToTrackerItem,
): Promise<void> {
  // logger.main.info('[TrackerSyncManager] Hydrating item:', payload.itemId, payload.title, 'into workspace:', workspacePath);
  const item = payloadToTrackerItem(payload, workspacePath);

  // Build JSONB data object with collaborative fields
  const data: Record<string, any> = {
    title: item.title,
    description: item.description,
    status: item.status,
    priority: item.priority,
    owner: item.owner,
    tags: item.tags || [],
    authorIdentity: item.authorIdentity,
    lastModifiedBy: item.lastModifiedBy,
    createdByAgent: item.createdByAgent,
    assigneeEmail: item.assigneeEmail,
    reporterEmail: item.reporterEmail,
    assigneeId: item.assigneeId,
    reporterId: item.reporterId,
    labels: item.labels,
    linkedCommitSha: item.linkedCommitSha,
    documentId: item.documentId,
    // Spread customFields at the top level so generated columns (e.g. kanban_sort_order)
    // can read them via data->>'fieldName'. Don't nest under a customFields sub-key.
    ...(item.customFields || {}),
    // Preserve per-field LWW timestamps from the sync payload for conflict resolution
    _fieldUpdatedAt: payload.fieldUpdatedAt,
  };

  // Preserve local-only fields (like kanbanSortOrder) that the server may not have.
  // Read the existing row's data to carry forward fields that aren't part of the sync payload.
  try {
    const existing = await database.query<any>(
      `SELECT data FROM tracker_items WHERE id = $1`,
      [item.id]
    );
    if (existing.rows.length > 0) {
      const existingData = typeof existing.rows[0].data === 'string'
        ? JSON.parse(existing.rows[0].data) : existing.rows[0].data;
      // Carry forward local-only fields not present in the incoming data
      if (existingData?.kanbanSortOrder && !data.kanbanSortOrder) {
        data.kanbanSortOrder = existingData.kanbanSortOrder;
      }
      if (existingData?.linkedSessions && !data.linkedSessions) {
        data.linkedSessions = existingData.linkedSessions;
      }

      // Merge comments (union by ID, keep newer version per comment)
      const incomingComments = payload.comments ?? [];
      const localComments = existingData?.comments ?? [];
      if (incomingComments.length || localComments.length) {
        const commentMap = new Map<string, any>();
        for (const c of localComments) commentMap.set(c.id, c);
        for (const c of incomingComments) {
          const local = commentMap.get(c.id);
          if (!local || (c.updatedAt ?? c.createdAt) >= (local.updatedAt ?? local.createdAt)) {
            commentMap.set(c.id, c);
          }
        }
        data.comments = Array.from(commentMap.values()).sort((a: any, b: any) => a.createdAt - b.createdAt);
      }

      // Merge activity (union by ID, bounded to 100)
      const incomingActivity = payload.activity ?? [];
      const localActivity = existingData?.activity ?? [];
      if (incomingActivity.length || localActivity.length) {
        const activityMap = new Map<string, any>();
        for (const a of localActivity) activityMap.set(a.id, a);
        for (const a of incomingActivity) activityMap.set(a.id, a);
        data.activity = Array.from(activityMap.values())
          .sort((a: any, b: any) => a.timestamp - b.timestamp)
          .slice(-100);
      }
    } else {
      // No existing row -- use incoming data directly
      if (payload.comments?.length) data.comments = payload.comments;
      if (payload.activity?.length) data.activity = payload.activity;
    }
  } catch (_e) {
    // Non-fatal: item may not exist yet -- use incoming data directly
    if (payload.comments?.length) data.comments = payload.comments;
    if (payload.activity?.length) data.activity = payload.activity;
  }

  const isArchived = item.archived === true;

  // Use server timestamps when available (from EncryptedTrackerItem envelope),
  // falling back to NOW() only for items without server timestamps.
  // This prevents sync from bumping the "updated" time on every re-sync.
  const serverCreated = payload.serverCreatedAt ? new Date(payload.serverCreatedAt) : null;
  const serverUpdated = payload.serverUpdatedAt ? new Date(payload.serverUpdatedAt) : null;

  // Content comes from the payload (Lexical editor state), stored in a separate SQL column
  const contentJson = payload.content != null ? JSON.stringify(payload.content) : null;

  await database.query(
    `INSERT INTO tracker_items (
      id, issue_number, issue_key, type, data, workspace, document_path, line_number, created, updated, last_indexed, sync_status, archived, archived_at, content, source
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, COALESCE($11, NOW()), COALESCE($12, NOW()), $8, 'synced', $9, $10, $13, 'native')
    ON CONFLICT (id) DO UPDATE SET
      issue_number = COALESCE($2, tracker_items.issue_number),
      issue_key = COALESCE($3, tracker_items.issue_key),
      type = $4, data = $5, last_indexed = $8, sync_status = 'synced',
      archived = CASE WHEN $9 = TRUE THEN TRUE ELSE tracker_items.archived END,
      archived_at = CASE WHEN $9 = TRUE THEN $10 ELSE tracker_items.archived_at END,
      content = COALESCE($13, tracker_items.content),
      source = 'native'`,
    [
      item.id,
      item.issueNumber ?? null,
      item.issueKey ?? null,
      item.type,
      JSON.stringify(data),
      workspacePath,
      item.module || '', // synced items have empty module (no source file)
      item.lastIndexed,
      isArchived,
      isArchived ? (item.archivedAt || new Date().toISOString()) : null,
      serverCreated,
      serverUpdated,
      contentJson,
    ]
  );

  // logger.main.info('[TrackerSyncManager] Hydrated item:', payload.itemId, 'into PGLite. Notifying renderer...');

  // Re-read the item from DB to get authoritative state including comments/activity
  // that were just written to the data JSONB column.
  let dbItem: any = item;
  try {
    const dbResult = await database.query<any>(
      `SELECT * FROM tracker_items WHERE id = $1`,
      [item.id]
    );
    if (dbResult.rows.length > 0) {
      const row = dbResult.rows[0];
      const rowData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data || {};
      const typeTags: string[] = row.type_tags?.length > 0 ? row.type_tags : [row.type];
      // Build a full TrackerItem from the DB row (same pattern as other rowToTrackerItem functions)
      const result: any = {
        id: row.id, issueNumber: row.issue_number ?? undefined, issueKey: row.issue_key ?? undefined,
        type: row.type, typeTags, title: rowData.title || row.title,
        description: rowData.description || undefined, status: rowData.status || row.status,
        priority: rowData.priority || undefined, owner: rowData.owner || undefined,
        module: row.document_path || undefined, workspace: row.workspace,
        tags: rowData.tags || undefined, created: rowData.created || row.created || undefined,
        updated: rowData.updated || row.updated || undefined,
        lastIndexed: new Date(row.last_indexed), content: row.content != null ? row.content : undefined,
        archived: row.archived ?? false,
        archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : undefined,
        source: row.source || (row.document_path ? 'inline' : 'native'),
        authorIdentity: rowData.authorIdentity || undefined,
        lastModifiedBy: rowData.lastModifiedBy || undefined,
        createdByAgent: rowData.createdByAgent || false,
        assigneeEmail: rowData.assigneeEmail || undefined, reporterEmail: rowData.reporterEmail || undefined,
        assigneeId: rowData.assigneeId || undefined, reporterId: rowData.reporterId || undefined,
        labels: rowData.labels || undefined, linkedSessions: rowData.linkedSessions || undefined,
        linkedCommitSha: rowData.linkedCommitSha || undefined, documentId: rowData.documentId || undefined,
        syncStatus: row.sync_status || 'local',
        fieldUpdatedAt: rowData._fieldUpdatedAt || undefined,
      };
      // Include extra data fields as customFields (comments, activity, etc.)
      const resultKeys = new Set(Object.keys(result));
      const extra: Record<string, any> = {};
      for (const [k, v] of Object.entries(rowData)) {
        if (v !== undefined && !resultKeys.has(k)) extra[k] = v;
      }
      if (Object.keys(extra).length > 0) result.customFields = extra;
      dbItem = result;
    }
  } catch {
    // Fall back to sync item if DB read fails
  }

  // Notify renderer of item change via the document-service channel
  // that TrackerTable's watchTrackerItems is already subscribed to.
  // Only send to windows for this workspace to prevent cross-project item leakage.
  sendToWorkspaceWindows(workspacePath, 'document-service:tracker-items-changed', {
    added: [],
    updated: [dbItem],
    removed: [],
    timestamp: new Date(),
  });
  // Status events can go to all windows (they include workspace context)
  sendToAllWindows('tracker-sync:item-upserted', {
    itemId: payload.itemId,
    type: payload.primaryType,
    title: payload.fields.title,
    status: payload.fields.status,
  });
}

/**
 * Remove a tracker item from PGLite when deleted remotely.
 * For inline items, also removes the line from the source markdown file
 * to prevent the file scanner from re-creating the item.
 */
async function removeTrackerItem(itemId: string, workspacePath: string): Promise<void> {
  // Check if this is an inline item before deleting from DB
  const result = await database.query<any>(
    `SELECT source, document_path FROM tracker_items WHERE id = $1`,
    [itemId]
  );
  const row = result.rows[0];

  // Remove inline item from source markdown file
  if (row?.source === 'inline' && row.document_path) {
    const fullPath = path.join(workspacePath, row.document_path);
    try {
      const fileContent = await fs.readFile(fullPath, 'utf-8');
      const updated = removeInlineTrackerItem(fileContent, itemId);
      if (updated !== null) {
        await fs.writeFile(fullPath, updated, 'utf-8');
        logger.main.info('[TrackerSyncManager] Removed inline item from file:', row.document_path);
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        logger.main.warn('[TrackerSyncManager] Failed to remove inline item from file:', err);
      }
    }
  }

  await database.query(
    `DELETE FROM tracker_items WHERE id = $1 AND sync_status = 'synced'`,
    [itemId]
  );

  // Only notify windows for this workspace to prevent cross-project leakage
  sendToWorkspaceWindows(workspacePath, 'document-service:tracker-items-changed', {
    added: [],
    updated: [],
    removed: [itemId],
    timestamp: new Date(),
  });
  sendToAllWindows('tracker-sync:item-deleted', { itemId });
}

// ============================================================================
// Public Mutation API (called from renderer via IPC)
// ============================================================================

/**
 * Push a local tracker item to the sync server.
 * Finds the right workspace provider based on the item's workspace field.
 */
export async function syncTrackerItem(item: import('@nimbalyst/runtime').TrackerItem): Promise<void> {
  const wsState = workspaceStates.get(item.workspace);
  if (!wsState) {
    throw new Error(`Tracker sync not connected for workspace: ${item.workspace}`);
  }

  const userId = getStytchUserId() ?? wsState.testUserId;
  if (!userId) {
    throw new Error('No user ID for tracker sync');
  }

  const { trackerItemToPayload } = loadSyncModule();
  const payload = trackerItemToPayload(item, userId);
  await wsState.provider.upsertItem(payload);

  // Update local sync_status to 'synced'
  await database.query(
    `UPDATE tracker_items SET sync_status = 'synced' WHERE id = $1`,
    [item.id]
  );
}

/**
 * Delete a tracker item from the sync server.
 * Needs workspace path to find the right provider.
 */
export async function unsyncTrackerItem(itemId: string, workspacePath?: string): Promise<void> {
  let provider: import('@nimbalyst/runtime/sync').TrackerSyncProvider | null = null;

  if (workspacePath) {
    provider = workspaceStates.get(workspacePath)?.provider ?? null;
  } else {
    // Fallback: try to find from any connected workspace
    for (const wsState of workspaceStates.values()) {
      provider = wsState.provider;
      break;
    }
  }

  if (!provider) {
    throw new Error('Tracker sync not connected');
  }

  await provider.deleteItem(itemId);
}

// ============================================================================
// IPC Handler Registration
// ============================================================================

/**
 * Register IPC handlers for tracker sync operations.
 * Call this once during app initialization.
 */
export function registerTrackerSyncHandlers(): void {
  safeHandle('tracker-sync:get-status', async (_event, payload?: { workspacePath?: string }) => {
    if (payload?.workspacePath) {
      const wsState = workspaceStates.get(payload.workspacePath);
      return {
        status: wsState?.status ?? 'disconnected',
        projectId: wsState?.projectId ?? null,
        active: !!wsState,
      };
    }
    return {
      status: getAggregateStatus(),
      projectId: null,
      active: workspaceStates.size > 0,
    };
  });

  safeHandle('tracker-sync:connect', async (_event, payload: { workspacePath: string }) => {
    try {
      await initializeTrackerSync(payload.workspacePath);
      const wsState = workspaceStates.get(payload.workspacePath);
      return { success: true, status: wsState?.status ?? 'disconnected', projectId: wsState?.projectId ?? null };
    } catch (error) {
      logger.main.error('[TrackerSyncManager] connect failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('tracker-sync:disconnect', async (_event, payload?: { workspacePath?: string }) => {
    shutdownTrackerSync(payload?.workspacePath);
    return { success: true };
  });

  /**
   * Restart tracker sync for a workspace with a fresh encryption key.
   * Called after org key rotation so the tracker provider uses the new key.
   */
  safeHandle('tracker-sync:restart-for-workspace', async (_event, workspacePath: string) => {
    try {
      logger.main.info('[TrackerSyncManager] Restarting tracker sync after key rotation for:', workspacePath);
      await reinitializeTrackerSync(workspacePath);
      return { success: true };
    } catch (error) {
      logger.main.error('[TrackerSyncManager] restart-for-workspace failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('tracker-sync:upsert-item', async (_event, payload: { item: import('@nimbalyst/runtime').TrackerItem }) => {
    try {
      await syncTrackerItem(payload.item);
      return { success: true };
    } catch (error) {
      logger.main.error('[TrackerSyncManager] upsert-item failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('tracker-sync:delete-item', async (_event, payload: { itemId: string; workspacePath?: string }) => {
    try {
      await unsyncTrackerItem(payload.itemId, payload.workspacePath);
      return { success: true };
    } catch (error) {
      logger.main.error('[TrackerSyncManager] delete-item failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('tracker-sync:set-config', async (_event, payload: { workspacePath: string; key: string; value: string }) => {
    try {
      const wsState = workspaceStates.get(payload.workspacePath);
      if (!wsState) {
        return { success: false, error: 'Tracker sync not connected for workspace' };
      }
      wsState.provider.setConfig(payload.key, payload.value);
      return { success: true };
    } catch (error) {
      logger.main.error('[TrackerSyncManager] set-config failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // -----------------------------------------------------------------------
  // Test-only handler: bypass Stytch/team/key-envelope auth for E2E tests.
  // Accepts a JWK encryption key and test auth bypass URL directly.
  // Only registered when PLAYWRIGHT=1.
  // -----------------------------------------------------------------------
  if (process.env.PLAYWRIGHT === '1') {
    safeHandle('tracker-sync:connect-test', async (_event, payload: {
      workspacePath: string;
      serverUrl: string;
      projectId: string;
      orgId: string;
      userId: string;
      encryptionKeyJwk: JsonWebKey;
    }) => {
      try {
        // If already connected for this workspace, disconnect first
        if (workspaceStates.has(payload.workspacePath)) {
          shutdownTrackerSync(payload.workspacePath);
        }

        // Import the JWK as a CryptoKey
        const encryptionKey = await crypto.subtle.importKey(
          'jwk',
          payload.encryptionKeyJwk,
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt'],
        );

        const { TrackerSyncProvider, payloadToTrackerItem } = loadSyncModule();

        const provider = new TrackerSyncProvider({
          serverUrl: payload.serverUrl,
          orgId: payload.orgId,
          projectId: payload.projectId,
          userId: payload.userId,
          encryptionKey,

          // Use test auth bypass URL instead of JWT
          buildUrl: (roomId: string) =>
            `${payload.serverUrl.replace('http', 'ws')}/sync/${roomId}?test_user_id=${payload.userId}&test_org_id=${payload.orgId}`,

          getJwt: async () => 'test-jwt',

          onStatusChange: (newStatus: TrackerSyncStatus) => {
            const wsState = workspaceStates.get(payload.workspacePath);
            if (wsState) {
              wsState.status = newStatus;
            }
            statusListeners.forEach(listener => listener(getAggregateStatus()));
            sendToAllWindows('tracker-sync:status-changed', { workspacePath: payload.workspacePath, status: newStatus });
          },

          onItemUpserted: (itemPayload: TrackerItemPayload) => {
            hydrateTrackerItem(itemPayload, payload.workspacePath, payloadToTrackerItem)
              .catch(err => logger.main.error('[TrackerSyncManager] Test: Failed to hydrate upserted item:', err));
          },

          onItemDeleted: (itemId: string) => {
            removeTrackerItem(itemId, payload.workspacePath)
              .catch(err => logger.main.error('[TrackerSyncManager] Test: Failed to remove deleted item:', err));
          },
        });

        workspaceStates.set(payload.workspacePath, {
          provider,
          encryptionKey,
          projectId: payload.projectId,
          status: 'connecting',
          testUserId: payload.userId,
        });

        await provider.connect();

        // logger.main.info('[TrackerSyncManager] Test: Tracker sync connected for', payload.workspacePath);
        const wsState = workspaceStates.get(payload.workspacePath);
        return { success: true, status: wsState?.status ?? 'connecting', projectId: payload.projectId };
      } catch (error) {
        logger.main.error('[TrackerSyncManager] Test connect failed:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }
}
