/**
 * TrackerSyncManager (host adapter)
 *
 * Per-workspace `TrackerSyncEngine` lifecycle, plus the IPC + service
 * surface the rest of the Electron main process expects. The engine
 * itself is platform-neutral and lives in
 * `@nimbalyst/runtime/sync/TrackerSyncEngine`; this file is the Electron
 * host: it wires PGLite (`TrackerPGLiteStore`), team metadata
 * (`TeamService`), the org encryption key (`OrgKeyService`), and the
 * Stytch JWT into a `TrackerSyncEngineConfig`.
 *
 * Lifecycle:
 *   - `initializeTrackerSync(workspacePath)` builds and connects the
 *     engine. Called from `RepositoryManager` per open workspace and
 *     from `WorkspaceManagerWindow`.
 *   - `shutdownTrackerSync(workspacePath?)` tears down one or all engines.
 *   - `reinitializeTrackerSync(workspacePath)` is the rotation handler:
 *     destroys + rebuilds the engine with fresh key material.
 *
 * Renderer bridge:
 *   The 7 `tracker-sync:*` IPC handlers preserved here keep the existing
 *   atoms in `store/listeners/trackerSyncListeners.ts` and
 *   `store/atoms/trackerSync.ts` functional without renderer changes.
 *   The legacy `tracker-sync:connect-test` channel is intentionally
 *   removed (per phase-3 plan question 5; nothing in the current
 *   Playwright suite calls it).
 */

import { BrowserWindow } from 'electron';
import {
  TrackerSyncEngine,
  fingerprintTrackerKey,
  applyLabelDiff,
  type TrackerSyncEngineConfig,
  type TrackerSyncStatus,
  type AppliedTrackerItem,
  type RejectedTrackerMutation,
  type TrackerKeyMaterial,
  type TrackerItemPayload,
  type TrackerRoomConfig,
  type LabelsMap,
} from '@nimbalyst/runtime/sync';
import type { TrackerItem } from '@nimbalyst/runtime';
import { trackerItemToRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import WebSocket from 'ws';

import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { isAuthenticated } from './StytchAuthService';
import { findTeamForWorkspace, getOrgScopedJwt } from './TeamService';
import { getOrgKey, getOrgKeyFingerprint, fetchAndUnwrapOrgKey, fetchTeamKeyStatus, getLastKnownTeamKeyStatus, setTeamKeyCustodyMode } from './OrgKeyService';
import { getCollabSyncWsUrl } from '../utils/collabSyncUrl';
import { getDatabase } from '../database/initialize';
import { TrackerPGLiteStore } from './tracker/TrackerPGLiteStore';
import {
  getMaxTrackerSchemaSyncId,
  listUnsyncedTrackerSchemaDefs,
} from './tracker/trackerTypeDefStore';
import { applyRemoteWorkspaceTrackerSchemaDef } from './TrackerSchemaService';
import {
  applyRemoteWorkspaceTrackerNavigationEntry,
  registerTrackerNavigationFlushHandler,
} from './TrackerNavigationService';
import {
  getMaxTrackerNavigationSyncId,
  listUnsyncedTrackerNavigationEntries,
} from './tracker/trackerNavigationStore';
import { windows, windowStates } from '../window/windowState';
import { getEffectiveTrackerSyncPolicy, decideBackfillAction } from './TrackerPolicyService';
import { rowToTrackerItem } from '../mcp/tools/trackerToolHandlers';
import { getWorkspaceState } from '../utils/store';
import { backupCollabOrganization, verifyOrMarkCollabBackups } from './CollabBackupCoordinator';
import { getCollabBackupService } from './CollabBackupService';

// ============================================================================
// Engine registry (per workspace)
// ============================================================================

interface EngineEntry {
  workspacePath: string;
  orgId: string;
  engine: TrackerSyncEngine;
  status: TrackerSyncStatus;
  /** Last known room config; renderer queries this via `tracker-sync:get-status`. */
  config: TrackerRoomConfig | null;
  /** Back-reference to the persistence store so `emitItemApplied` can read
   * the just-written row back as a `TrackerItem`. */
  store: TrackerPGLiteStore;
}

// One engine per workspace. Two workspaces that resolve to the same team
// (same git remote, same `teamProjectId`) will open two engines and two
// WebSocket connections to the same TrackerRoom -- this is intentional.
// Each workspace has its own PGLite projection and its own renderer window,
// and sharing an engine across workspaces would require splitting the
// projection's row stream per consumer. Phase 4's per-window broadcast
// could later collapse to a single engine per team.
const engines = new Map<string, EngineEntry>();

registerTrackerNavigationFlushHandler((workspacePath) =>
  engines.get(workspacePath)?.engine.flushNavigation(),
);

/**
 * In-flight `initializeTrackerSync` promises, keyed by workspace path.
 * Prevents two near-simultaneous callers (e.g. RepositoryManager +
 * WorkspaceManagerWindow start-up race) from each constructing their own
 * `TrackerSyncEngine` and opening duplicate WebSocket connections. The
 * second caller awaits the first's result.
 */
const inflightInits = new Map<string, Promise<void>>();

// ============================================================================
// Status listeners (legacy export surface)
// ============================================================================

type StatusListener = (status: TrackerSyncStatus) => void;
const statusListeners = new Set<StatusListener>();

function notifyStatus(status: TrackerSyncStatus): void {
  for (const cb of statusListeners) {
    try { cb(status); } catch (err) { logger.main.warn('[TrackerSyncManager] status listener error:', err); }
  }
}

// ============================================================================
// Renderer broadcast helpers
// ============================================================================

function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch { /* ignore */ }
    }
  }
}

/**
 * Send an IPC message only to windows whose primary workspace matches
 * `workspacePath`. Prevents tracker items from leaking across workspaces in
 * the renderer (e.g. a delta on workspace A should not paint into the
 * tracker view of workspace B's window).
 */
function broadcastToWorkspaceWindows(workspacePath: string, channel: string, payload: unknown): void {
  for (const [windowId, browserWindow] of windows) {
    if (browserWindow.isDestroyed()) continue;
    const state = windowStates.get(windowId);
    if (state?.workspacePath !== workspacePath) continue;
    try { browserWindow.webContents.send(channel, payload); } catch { /* ignore */ }
  }
}

// ============================================================================
// Public API (preserved across phases)
// ============================================================================

export function onTrackerSyncStatusChange(listener: StatusListener): () => void {
  statusListeners.add(listener);
  // Fire-once with the current "best" status across all engines; matches
  // the v1 contract that callers want a startup-time signal.
  listener(currentAggregateStatus());
  return () => statusListeners.delete(listener);
}

export function getTrackerSyncStatus(): TrackerSyncStatus {
  return currentAggregateStatus();
}

function currentAggregateStatus(): TrackerSyncStatus {
  if (engines.size === 0) return 'disconnected';
  // Pick the "happiest" status: prefer connected > syncing > connecting > error > disconnected.
  const order: TrackerSyncStatus[] = ['connected', 'syncing', 'connecting', 'error', 'disconnected'];
  for (const candidate of order) {
    for (const entry of engines.values()) {
      if (entry.status === candidate) return candidate;
    }
  }
  return 'disconnected';
}

/**
 * Legacy hook. The v1 implementation returned a `TrackerSyncProvider`
 * instance; phase 3 no longer exposes that surface (renderer reads PGLite
 * via existing IPC and observes engine events via `tracker-sync:*`).
 * Kept as `null` so callers that don't actually use the return type
 * still link.
 */
export function getTrackerSyncProvider(_workspacePath?: string): null {
  return null;
}

export function reconnectAllTrackerSyncs(): void {
  for (const entry of engines.values()) {
    void entry.engine.connect();
  }
}

/** Whether a connected engine exists for the workspace. */
export function isTrackerSyncActive(workspacePath?: string): boolean {
  if (!workspacePath) {
    for (const entry of engines.values()) {
      if (entry.status === 'connected') return true;
    }
    return false;
  }
  const entry = engines.get(workspacePath);
  return !!entry && entry.status === 'connected';
}

/**
 * Initialize a tracker sync engine for the given workspace. Idempotent --
 * calling twice with the same workspace is a no-op.
 *
 * Fails closed (returns early without throwing) when:
 *   - The user is not authenticated.
 *   - No team is associated with the workspace.
 *   - The team predates the D8 migration (no `teamProjectId` minted).
 *   - The org encryption key envelope cannot be unwrapped (typical:
 *     admin hasn't shared it yet).
 */
export async function initializeTrackerSync(workspacePath: string): Promise<void> {
  if (engines.has(workspacePath)) {
    logger.main.debug('[TrackerSyncManager] engine already exists for', workspacePath);
    return;
  }
  const inflight = inflightInits.get(workspacePath);
  if (inflight) return inflight;
  const promise = doInitializeTrackerSync(workspacePath).finally(() => {
    inflightInits.delete(workspacePath);
  });
  inflightInits.set(workspacePath, promise);
  return promise;
}

async function doInitializeTrackerSync(workspacePath: string): Promise<void> {
  // TEMP DIAGNOSTIC: bump all bails to info so we can see why the engine
  // never starts after the autoMatchTeamForWorkspace race fix.
  logger.main.info('[TrackerSyncManager] doInitializeTrackerSync entered for', workspacePath);

  if (engines.has(workspacePath)) {
    logger.main.info('[TrackerSyncManager] engine already in map for', workspacePath, '-- skipping');
    return;
  }

  if (!isAuthenticated()) {
    logger.main.info('[TrackerSyncManager] not authenticated, skipping init for', workspacePath);
    return;
  }

  const team = await findTeamForWorkspace(workspacePath);
  if (!team) {
    logger.main.info('[TrackerSyncManager] no team for workspace, skipping init:', workspacePath);
    return;
  }

  logger.main.info('[TrackerSyncManager] team found for', workspacePath, '-> orgId:', team.orgId, 'teamProjectId:', team.teamProjectId);

  if (!team.teamProjectId) {
    logger.main.warn(
      '[TrackerSyncManager] team', team.orgId,
      'has no teamProjectId -- engine not started. Server must run the D8 migration to mint one.',
    );
    return;
  }

  // Epic H2: decide the key-custody lane BEFORE touching the ECDH envelope
  // path. In server-managed mode the server holds the per-team DEK and the
  // engine syncs PLAINTEXT, so no org key is fetched or required.
  let keyStatusMode: 'legacy-e2e' | 'server-managed' = 'legacy-e2e';
  try {
    const orgJwt = await getOrgScopedJwt(team.orgId);
    keyStatusMode = (await fetchTeamKeyStatus(team.orgId, orgJwt)).mode;
  } catch (err) {
    // Offline JWT mint failure (NIM-1778): fall back to the last-known mode
    // instead of assuming legacy-e2e, which poisons the tracker sync lane.
    keyStatusMode = getLastKnownTeamKeyStatus(team.orgId)?.mode ?? 'legacy-e2e';
    logger.main.warn('[TrackerSyncManager] key-status resolve failed; using last-known mode', keyStatusMode, ':', err);
  }
  const serverManaged = keyStatusMode === 'server-managed';

  // Resolve org encryption key (legacy mode only). If the envelope hasn't been
  // shared with us yet, surface a status update but don't crash; the user can
  // ask an admin to share, then we'll reinitialize.
  let encryptionKey: CryptoKey | null = null;
  if (!serverManaged) {
    encryptionKey = await getOrgKey(team.orgId);
    if (!encryptionKey) {
      try {
        const orgJwt = await getOrgScopedJwt(team.orgId);
        encryptionKey = await fetchAndUnwrapOrgKey(team.orgId, orgJwt);
      } catch (err) {
        logger.main.warn('[TrackerSyncManager] failed to fetch org key envelope:', err);
      }
      if (!encryptionKey) {
        logger.main.warn(
          '[TrackerSyncManager] no encryption key for', team.orgId,
          '-- engine not started until admin shares envelope.',
        );
        return;
      }
    }
  } else {
    logger.main.info('[TrackerSyncManager] team', team.orgId, 'is server-managed; skipping ECDH org-key unwrap');
  }

  const orgKeyFingerprint = serverManaged ? null : getOrgKeyFingerprint(team.orgId);

  const db = getDatabase();
  if (!db) {
    logger.main.error('[TrackerSyncManager] database not available; cannot start engine');
    return;
  }

  const persistence = new TrackerPGLiteStore(db, workspacePath);

  const config: TrackerSyncEngineConfig = {
    serverUrl: getCollabSyncWsUrl(),
    orgId: team.orgId,
    teamProjectId: team.teamProjectId,
    userId: '',  // informational only; the JWT carries the authoritative sub
    keyCustody: serverManaged ? 'server-managed' : 'legacy-e2e',
    encryptionKey: encryptionKey ?? undefined,
    orgKeyFingerprint,
    persistence,
    initializeIssueKeyPrefix: getWorkspaceState(workspacePath).issueKeyPrefix,
    schemaSync: {
      getMaxSyncId: () => getMaxTrackerSchemaSyncId(workspacePath),
      listUnsynced: () => listUnsyncedTrackerSchemaDefs(workspacePath),
      applyRemote: (def) => applyRemoteWorkspaceTrackerSchemaDef(workspacePath, def),
    },
    navigationSync: {
      getMaxSyncId: () => getMaxTrackerNavigationSyncId(workspacePath),
      listUnsynced: () => listUnsyncedTrackerNavigationEntries(workspacePath),
      applyRemote: (def) => applyRemoteWorkspaceTrackerNavigationEntry(workspacePath, def),
    },
    getJwt: () => getOrgScopedJwt(team.orgId),
    // Legacy-only: server-managed mode never hits staleKeyEpoch (server owns
    // the epoch), so a key-refresh callback would be dead weight.
    refreshKey: serverManaged ? undefined : () => refreshKeyForOrg(team.orgId),
    // Node.js 22+ ships a global WebSocket, but Electron's main process
    // historically pinned a Chromium-era version; use `ws` from the same
    // import DocumentSyncHandlers does for reliability across Electron
    // version bumps. The `ws` constructor's instance lacks `dispatchEvent`
    // so it does not satisfy lib.dom's WebSocket interface structurally;
    // the cast is intentional and matches DocumentSyncHandlers' approach.
    createWebSocket: ((url: string) => new WebSocket(url)) as unknown as TrackerSyncEngineConfig['createWebSocket'],
    onStatusChange: (status) => {
      // logger.main.info('[TrackerSyncManager] onStatusChange for', workspacePath, '->', status);
      const entry = engines.get(workspacePath);
      if (entry) {
        entry.status = status;
      }
      notifyStatus(status);
      broadcastToAllWindows('tracker-sync:status-changed', { workspacePath, status, shared: true });
      // First successful connect to this room: catch up the server with
      // any items that were created locally before the engine existed (or
      // before the team's TrackerRoom DO was minted). Without this, a user
      // who has 163 local bugs and flips a tracker to "Shared" never sees
      // those bugs on their other devices -- the new engine only knows
      // what was queued through it. Gated on `sync_id IS NULL` so we don't
      // re-push items the server already confirmed.
      if (status === 'connected') {
        void backfillSharedLocalItems(workspacePath).catch(err => {
          logger.main.warn('[TrackerSyncManager] backfillSharedLocalItems failed for', workspacePath, err);
        });
      }
    },
    onItemApplied: (applied) => {
      // logger.main.info('[TrackerSyncManager] onItemApplied for', workspacePath, 'itemId:', applied.itemId, 'tombstone:', applied.isTombstone);
      emitItemApplied(workspacePath, applied);
    },
    onConfigChange: (roomConfig) => {
      // logger.main.info('[TrackerSyncManager] onConfigChange for', workspacePath, 'issueKeyPrefix:', roomConfig.issueKeyPrefix);
      const entry = engines.get(workspacePath);
      if (entry) {
        entry.config = roomConfig;
      }
      broadcastToAllWindows('tracker-sync:config-changed', { workspacePath, config: roomConfig });
    },
    onRejection: (rejection) => {
      logger.main.warn('[TrackerSyncManager] onRejection for', workspacePath, 'itemId:', rejection.itemId, 'code:', rejection.rejection.code, 'message:', rejection.rejection.message);
      emitRejection(workspacePath, rejection);
    },
    onBootstrapError: (err) => {
      // Surface engine bootstrap failures explicitly. Without this the
      // engine sits at `syncing` indefinitely (the catch in runBootstrap
      // used to swallow the error). Now we get a single error line that
      // names the failure mode -- decrypt failure, websocket drop, etc.
      logger.main.error('[TrackerSyncManager] bootstrap failed for', workspacePath, ':', err);
    },
    onRoomMoved: (dest) => {
      // Epic H3 P1: the project's tracker room was relocated to another org.
      // Re-resolve routing (findTeamForWorkspace now reflects the flipped D1
      // project_discovery) and reconnect to the destination room.
      logger.main.info('[TrackerSyncManager] room moved for', workspacePath, '->', `${dest.destOrgId}:${dest.destTeamProjectId}`, '; re-resolving routing');
      void reinitializeTrackerSync(workspacePath).catch(err =>
        logger.main.warn('[TrackerSyncManager] reinitialize after room-moved failed for', workspacePath, err));
    },
  };

  logger.main.info('[TrackerSyncManager] creating engine for', workspacePath, 'roomId:', `org:${team.orgId}:tracker:${team.teamProjectId}`);

  const engine = new TrackerSyncEngine(config);
  engines.set(workspacePath, {
    workspacePath,
    orgId: team.orgId,
    engine,
    status: 'disconnected',
    config: null,
    store: persistence,
  });

  try {
    logger.main.info('[TrackerSyncManager] calling engine.connect() for', workspacePath);
    await engine.connect();
    logger.main.info('[TrackerSyncManager] engine.connect() resolved for', workspacePath);
  } catch (err) {
    logger.main.error('[TrackerSyncManager] engine.connect failed for', workspacePath, ':', err);
  }
}

export function shutdownTrackerSync(workspacePath?: string): void {
  if (workspacePath) {
    const entry = engines.get(workspacePath);
    if (entry) {
      try { entry.engine.destroy(); } catch { /* ignore */ }
      engines.delete(workspacePath);
    }
    return;
  }
  for (const entry of engines.values()) {
    try { entry.engine.destroy(); } catch { /* ignore */ }
  }
  engines.clear();
}

export async function reinitializeTrackerSync(workspacePath: string): Promise<void> {
  shutdownTrackerSync(workspacePath);
  await initializeTrackerSync(workspacePath);
}

/**
 * Epic H2 client-assisted migration cutover (admin action).
 *
 * Flips a team from legacy-e2e (client-side zero-knowledge) to server-managed,
 * then re-uploads the team's locally-decrypted tracker data as PLAINTEXT so the
 * server can re-encrypt it at rest with the team DEK. The legacy ciphertext rows
 * (written under the old org key, undecryptable to keyless clients) are thereby
 * replaced.
 *
 * Steps:
 *   1. POST set-key-custody-mode=server-managed (admin-gated server-side).
 *   2. Mark every shared local tracker item AND schema def for re-push
 *      (`sync_id = NULL`, `sync_status = 'pending'`).
 *   3. Reinitialize the engine — it fetches key-status (now server-managed),
 *      runs in plaintext pass-through, and the on-connect backfill re-uploads
 *      the marked items; `pushPendingSchemas` re-uploads the marked schemas.
 *
 * NOTE (documents): doc-index TITLES self-heal (NIM-906) — on the next
 * server-managed reconnect, a client holding the legacy org key decrypts the
 * pre-migration ciphertext titles and re-registers them as plaintext, so the
 * server re-keys them under the DEK and broadcasts clean titles to the team.
 * Document BODIES re-compact as plaintext when their Yjs client next elects.
 * The migrating caller must hold the legacy org key (enforced above) so this
 * healing can actually happen.
 *
 * Returns the orgId and how many items were marked for re-push. Requires the
 * caller to be a team admin (enforced by the server REST gate).
 */
export async function migrateTeamToServerManaged(
  orgId: string,
  workspacePath?: string,
): Promise<{ orgId: string; itemsMarked: number; schemasMarked: number; workspacesMarked: string[] }> {
  if (!orgId) throw new Error('orgId required');

  if (workspacePath) {
    const team = await findTeamForWorkspace(workspacePath);
    if (!team) throw new Error('No team found for this workspace');
    if (team.orgId !== orgId) {
      throw new Error('Selected organization does not match the active workspace.');
    }
  }

  const db = getDatabase();
  if (!db) throw new Error('Database not available');

  const orgJwt = await getOrgScopedJwt(orgId);
  if ((await fetchTeamKeyStatus(orgId, orgJwt)).mode === 'server-managed') {
    return { orgId, itemsMarked: 0, schemasMarked: 0, workspacesMarked: [] };
  }

  // NIM-906: doc-index TITLES and document BODIES written before the flip stay
  // AES-ciphertext on the server (it never held the zero-knowledge org key, so
  // it cannot re-key them). Only a client that still holds the legacy org key
  // can recover the plaintext and re-register it (TeamSync self-heals titles;
  // bodies re-compact as plaintext on next elect). So the precondition for a
  // CLEAN cutover is that THIS migrating client holds the legacy org key —
  // not that no docs are linked (the old guard blocked on linked docs yet did
  // nothing to guarantee the data could actually be healed, and silently left
  // the index as ciphertext when an admin migrated from a device that had no
  // local bindings).
  let legacyKey = await getOrgKey(orgId);
  if (!legacyKey) {
    try {
      legacyKey = await fetchAndUnwrapOrgKey(orgId, await getOrgScopedJwt(orgId));
    } catch {
      // fall through to the guard below
    }
  }
  if (!legacyKey) {
    throw new Error(
      'Cannot update encryption: this device does not have the team’s current encryption key, ' +
      'so existing shared documents could not be re-encrypted. Migrate from a device that has ' +
      'been an active member of this team (or ask an admin to re-share keys), then retry.',
    );
  }

  const workspaceRows = await db.query<{ workspace: string }>(
    `
      SELECT DISTINCT workspace FROM tracker_items WHERE workspace IS NOT NULL
      UNION
      SELECT DISTINCT workspace FROM tracker_type_defs WHERE workspace IS NOT NULL
    `,
  );
  const workspacesForOrg: string[] = [];
  const unresolvedWorkspaces: Array<{ workspace: string; error: string }> = [];
  for (const row of workspaceRows.rows) {
    if (!row.workspace) continue;
    try {
      const team = await findTeamForWorkspace(row.workspace);
      if (team?.orgId === orgId) {
        workspacesForOrg.push(row.workspace);
      }
    } catch (err) {
      // A THROW (not a null return) means we could not even resolve this
      // workspace's org -- e.g. its git remote is gone. We cannot classify it,
      // so it is neither swept nor excluded with confidence. Do NOT silently
      // drop it: if it holds shared tracker bodies for THIS org, they would go
      // uncaptured and the gate would pass without them (backup review 3a).
      unresolvedWorkspaces.push({
        workspace: row.workspace,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (unresolvedWorkspaces.length > 0) {
    logger.main.warn(
      '[TeamMigration] Pre-migration sweep could not resolve some local workspaces; ' +
      'any shared tracker bodies they hold for this org were not backed up',
      { orgId, unresolvedWorkspaces },
    );
  }
  if (workspacePath && !workspacesForOrg.includes(workspacePath)) {
    workspacesForOrg.push(workspacePath);
  }
  // Gating safety precondition: capture every locally-known shared document
  // and tracker body while the legacy key is still usable. The custody flip
  // must not happen unless each sweep confirms a fresh plaintext backup.
  const backupSummaries = await backupCollabOrganization(orgId, workspacesForOrg);
  const backupProjectIds = await verifyOrMarkCollabBackups(
    backupSummaries,
    (projectIds, reason) => getCollabBackupService().markNeedsRecovery(orgId, projectIds, reason),
  );

  let cutoverComplete = false;
  try {
    // 1. Server cutover (admin-gated; throws on non-admin / failure).
    await setTeamKeyCustodyMode(orgId, 'server-managed', orgJwt);
    cutoverComplete = true;

    // 2. Mark shared local items + schema defs for re-push as plaintext. Count
    // first (cross-backend: the query seam doesn't expose an affected-row count).
    const countRows = async (table: string, workspace: string): Promise<number> => {
      const res = await db.query(
        `SELECT COUNT(*) AS n FROM ${table} WHERE workspace = $1 AND deleted_at IS NULL`,
        [workspace],
      );
      return Number((res.rows[0] as { n: number | string } | undefined)?.n ?? 0);
    };
    let itemsMarked = 0;
    let schemasMarked = 0;
    for (const workspace of workspacesForOrg) {
      itemsMarked += await countRows('tracker_items', workspace);
      schemasMarked += await countRows('tracker_type_defs', workspace);
      await db.query(
        `UPDATE tracker_items
            SET sync_id = NULL, sync_status = 'pending'
          WHERE workspace = $1 AND deleted_at IS NULL`,
        [workspace],
      );
      await db.query(
        `UPDATE tracker_type_defs
            SET sync_id = NULL, sync_status = 'pending'
          WHERE workspace = $1 AND deleted_at IS NULL`,
        [workspace],
      );
    }
    logger.main.info(
      '[TrackerSyncManager] migrate-to-server-managed for', orgId,
      '-- marked', itemsMarked, 'items and', schemasMarked, 'schemas across', workspacesForOrg.length, 'workspaces for plaintext re-push',
    );

    // 3. Reconnect in server-managed mode; on-connect backfill re-uploads.
    for (const workspace of workspacesForOrg) {
      backfilledWorkspaces.delete(workspace);
      await reinitializeTrackerSync(workspace);
    }

    return { orgId, itemsMarked, schemasMarked, workspacesMarked: workspacesForOrg };
  } catch (error) {
    if (!cutoverComplete) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await getCollabBackupService().markNeedsRecovery(orgId, backupProjectIds, reason);
    } catch (markerError) {
      logger.main.error('[TrackerSyncManager] Could not persist needs-recovery marker', {
        orgId,
        markerError,
      });
    }
    logger.main.error('[TrackerSyncManager] Migration failed after custody cutover; org needs recovery', {
      orgId,
      reason,
    });
    throw new Error(
      'Encryption migration failed after the server cutover. This organization needs recovery ' +
      'from its local plaintext collaboration backup; no rollback was attempted. Cause: ' + reason,
    );
  }
}

/**
 * Per-workspace guard so we only run the historical backfill once per engine
 * lifecycle. Idempotent within an engine but prevents redundant scans on
 * reconnect / status flapping.
 */
const backfilledWorkspaces = new Set<string>();

/**
 * Drop the once-per-engine backfill guard for a workspace and re-run the
 * scan immediately if an engine is connected. Called when the user flips
 * a tracker type's sync policy to `shared`/`hybrid` -- without this hook
 * the items they already have locally would never make it to the room.
 *
 * Safe to call when no engine exists; it's a no-op until the engine
 * connects (the on-connect path will run backfill anyway).
 */
export async function requestTrackerBackfillForWorkspace(workspacePath: string): Promise<void> {
  backfilledWorkspaces.delete(workspacePath);
  const entry = engines.get(workspacePath);
  if (!entry || entry.status !== 'connected') return;
  await backfillSharedLocalItems(workspacePath);
}

/**
 * Push every workspace-local tracker item that should be shared but has
 * never been confirmed by the new TrackerSyncEngine (`sync_id IS NULL`)
 * up to the room.
 *
 * Why this exists: items created before the engine was running -- or
 * before the team's TrackerRoom DO was minted -- never went through
 * `syncTrackerItem`, so the server room is empty and other devices see
 * nothing. The historical `sync_status='synced'` flag was set by the
 * previous sync system and means nothing to the new engine.
 *
 * We only push items whose effective policy is shared/hybrid (per the
 * workspace's per-type sync policy). Local-only items stay local.
 * Idempotent: the engine's `engines.has()` guard prevents repeats, and
 * once an item's `sync_id` is populated by `applyRemoteItem` (on
 * server-confirmed apply) it falls out of the candidate set.
 */
async function backfillSharedLocalItems(workspacePath: string): Promise<void> {
  if (backfilledWorkspaces.has(workspacePath)) return;
  backfilledWorkspaces.add(workspacePath);

  const entry = engines.get(workspacePath);
  if (!entry) {
    backfilledWorkspaces.delete(workspacePath);
    return;
  }
  const db = getDatabase();
  if (!db) {
    backfilledWorkspaces.delete(workspacePath);
    return;
  }

  // Candidates: never-synced items (`sync_id IS NULL`) plus items left
  // `sync_status='pending'` by an offline mutation -- including the `nim` CLI
  // writing directly to SQLite while the app was closed. Re-pushing an
  // already-synced item is idempotent: `applyRemoteItem` flips it back to
  // 'synced' on ack, so it falls out of this set on the next launch.
  const candidates = await db.query(
    `SELECT * FROM tracker_items
     WHERE workspace = $1
       AND (sync_id IS NULL OR sync_status = 'pending')
       AND deleted_at IS NULL
     ORDER BY created ASC`,
    [workspacePath],
  );

  if (candidates.rows.length === 0) {
    logger.main.info('[TrackerSyncManager] backfill: no candidate items for', workspacePath);
    return;
  }

  let queued = 0;
  let skipped = 0;
  let deleted = 0;
  for (const row of candidates.rows) {
    const policy = getEffectiveTrackerSyncPolicy(workspacePath, row.type as string);
    const item = rowToTrackerItem(row) as TrackerItem;
    // Per-item gate (NIM-876 / NIM-880): hybrid types sync ONLY flagged items.
    //   - flagged/shared            -> upsert
    //   - previously shared (sync_id set) but now UNFLAGGED -> delete from the
    //       room (propagates an offline unshare; previously this re-uploaded the
    //       item or left a stale copy behind)
    //   - never shared + unflagged  -> skip (local-only, no leak)
    const previouslyShared = row.sync_id != null;
    const action = decideBackfillAction(policy, item, previouslyShared);
    if (action === 'skip') {
      skipped++;
      continue;
    }
    if (action === 'delete') {
      try {
        await entry.engine.deleteItem(row.id as string);
        // Reset the local row so it isn't re-processed (or re-deleted) on the
        // next reconnect.
        await db.query(
          `UPDATE tracker_items SET sync_status = 'local', sync_id = NULL WHERE id = $1`,
          [row.id],
        );
        deleted++;
      } catch (err) {
        logger.main.warn('[TrackerSyncManager] backfill deleteItem failed for item', row.id, err);
      }
      continue;
    }
    try {
      const payload = trackerItemToPayload(item);
      await entry.engine.upsertItem(payload);
      queued++;
    } catch (err) {
      logger.main.warn('[TrackerSyncManager] backfill upsertItem failed for item', row.id, err);
    }
  }

  logger.main.info(
    '[TrackerSyncManager] backfill complete for', workspacePath,
    'queued:', queued, 'deleted:', deleted, 'skipped-local-only:', skipped, 'total-candidates:', candidates.rows.length,
  );
}

/**
 * Race-safe entry point used by callers (TeamService.autoMatchTeamForWorkspace)
 * that only learn the workspace<->team binding after init has already raced
 * ahead and bailed at the "no team" check.
 *
 * Why this exists: `initializeTrackerSync` dedups concurrent calls via
 * `inflightInits`. If an earlier parallel call is mid-`findTeamForWorkspace`
 * when we re-trigger here, we'd share its promise and inherit its silent
 * "no team" bail. After awaiting, if no engine ended up in the map, we
 * explicitly retry with a fresh `doInitializeTrackerSync` run.
 */
export async function ensureTrackerSyncForWorkspace(workspacePath: string): Promise<void> {
  await initializeTrackerSync(workspacePath);
  if (engines.has(workspacePath)) return;
  // The shared inflight bailed silently. Now that the team binding is
  // committed (caller just confirmed it), try once more from scratch.
  logger.main.info('[TrackerSyncManager] ensureTrackerSyncForWorkspace: first init produced no engine, retrying for', workspacePath);
  await initializeTrackerSync(workspacePath);
}

/**
 * Convert a legacy TrackerItem (the shape every existing caller uses)
 * into a TrackerItemPayload (the wire shape the engine expects), then
 * enqueue it for upload via the active engine.
 *
 * If no engine is active for the item's workspace, this is a no-op (the
 * caller is expected to consult `isTrackerSyncActive` first).
 */
export async function syncTrackerItem(item: TrackerItem): Promise<void> {
  const workspacePath = item.workspace;
  const entry = workspacePath ? engines.get(workspacePath) : undefined;
  if (!entry) return;

  const payload = trackerItemToPayload(item);
  await entry.engine.upsertItem(payload);
}

export async function unsyncTrackerItem(itemId: string, workspacePath?: string): Promise<void> {
  if (!workspacePath) {
    // Best-effort: try every engine. v1 callers occasionally omit the
    // workspace path; we want them to keep working without surprises.
    for (const entry of engines.values()) {
      try { await entry.engine.deleteItem(itemId); } catch { /* ignore */ }
    }
    return;
  }
  const entry = engines.get(workspacePath);
  if (!entry) return;
  await entry.engine.deleteItem(itemId);
}

// ============================================================================
// Renderer event emitters
// ============================================================================

function emitItemApplied(workspacePath: string, applied: AppliedTrackerItem): void {
  if (applied.isTombstone) {
    broadcastToAllWindows('tracker-sync:item-deleted', {
      workspacePath,
      itemId: applied.itemId,
    });
    // Workspace-scoped: the renderer's tracker atoms listen to
    // `document-service:tracker-items-changed`, NOT `tracker-sync:*`. Without
    // this second broadcast the kanban / table view would not repaint when a
    // remote peer deletes an item.
    broadcastToWorkspaceWindows(workspacePath, 'document-service:tracker-items-changed', {
      added: [],
      updated: [],
      removed: [applied.itemId],
      timestamp: new Date(),
    });
    return;
  }
  const fields = applied.payload?.fields ?? {};
  broadcastToAllWindows('tracker-sync:item-upserted', {
    workspacePath,
    itemId: applied.itemId,
    type: applied.payload?.primaryType ?? 'unknown',
    title: typeof fields.title === 'string' ? fields.title : '',
    status: typeof fields.status === 'string' ? fields.status : '',
    issueNumber: applied.issueNumber,
    issueKey: applied.issueKey,
  });
  // Read the just-written row back and broadcast it through the
  // document-service channel so renderer atoms refresh. We deliberately use
  // the per-workspace channel here -- workspaces can map to different rooms,
  // and a delta from workspace A's room must not leak into workspace B's
  // tracker view.
  const entry = engines.get(workspacePath);
  if (!entry) return;
  void entry.store.getTrackerItem(applied.itemId)
    .then((item) => {
      if (!item) return;
      broadcastToWorkspaceWindows(workspacePath, 'document-service:tracker-items-changed', {
        added: [],
        updated: [item],
        removed: [],
        timestamp: new Date(),
      });
    })
    .catch((err) => {
      logger.main.warn('[TrackerSyncManager] failed to read back applied item for renderer broadcast:', err);
    });
}

function emitRejection(workspacePath: string, rejection: RejectedTrackerMutation): void {
  broadcastToAllWindows('tracker-sync:mutation-rejected', {
    workspacePath,
    itemId: rejection.itemId,
    clientMutationId: rejection.clientMutationId,
    code: rejection.rejection.code,
    message: rejection.rejection.message,
  });
}

// ============================================================================
// Key rotation refresh path
// ============================================================================

async function refreshKeyForOrg(orgId: string): Promise<TrackerKeyMaterial | null> {
  try {
    const orgJwt = await getOrgScopedJwt(orgId);
    const fresh = await fetchAndUnwrapOrgKey(orgId, orgJwt);
    if (!fresh) return null;
    const fingerprint = await fingerprintTrackerKey(fresh);
    return { encryptionKey: fresh, orgKeyFingerprint: fingerprint };
  } catch (err) {
    logger.main.warn('[TrackerSyncManager] refreshKey failed for', orgId, ':', err);
    return null;
  }
}

// ============================================================================
// IPC surface (7 channels; connect-test deleted per phase-3 plan Q5)
// ============================================================================

export function registerTrackerSyncHandlers(): void {
  safeHandle('tracker-sync:get-status', async (_event, payload?: { workspacePath?: string }) => {
    const wp = payload?.workspacePath;
    if (wp) {
      const entry = engines.get(wp);
      return {
        status: entry?.status ?? 'disconnected',
        projectId: entry?.orgId ?? null,
        active: entry?.status === 'connected',
        issueKeyPrefix: entry?.config?.issueKeyPrefix,
      };
    }
    return {
      status: currentAggregateStatus(),
      projectId: null,
      active: currentAggregateStatus() === 'connected',
    };
  });

  safeHandle('tracker-sync:connect', async (_event, payload: { workspacePath: string }) => {
    if (!payload?.workspacePath) {
      return { success: false, error: 'workspacePath required' };
    }
    try {
      await initializeTrackerSync(payload.workspacePath);
      const entry = engines.get(payload.workspacePath);
      return {
        success: !!entry,
        status: entry?.status ?? 'disconnected',
        projectId: entry?.orgId,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('tracker-sync:disconnect', async (_event, payload?: { workspacePath?: string }) => {
    shutdownTrackerSync(payload?.workspacePath);
    return { success: true };
  });

  safeHandle('tracker-sync:restart-for-workspace', async (_event, payload: string | { workspacePath: string }) => {
    const wp = typeof payload === 'string' ? payload : payload?.workspacePath;
    if (!wp) {
      return { success: false, error: 'workspacePath required' };
    }
    try {
      await reinitializeTrackerSync(wp);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Epic H2 admin action: migrate this workspace's team from legacy-e2e to
  // server-managed key custody, then re-push local tracker data as plaintext.
  safeHandle('tracker-sync:migrate-to-server-managed', async (_event, payload: string | { orgId?: string; workspacePath?: string }) => {
    const orgId = typeof payload === 'string' ? undefined : payload?.orgId;
    const wp = typeof payload === 'string' ? payload : payload?.workspacePath;
    if (!orgId) {
      return { success: false, error: 'orgId required' };
    }
    try {
      const result = await migrateTeamToServerManaged(orgId, wp);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('tracker-sync:upsert-item', async (_event, payload: { item: TrackerItem }) => {
    if (!payload?.item) {
      return { success: false, error: 'item required' };
    }
    try {
      await syncTrackerItem(payload.item);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('tracker-sync:delete-item', async (_event, payload: { itemId: string; workspacePath?: string }) => {
    if (!payload?.itemId) {
      return { success: false, error: 'itemId required' };
    }
    try {
      await unsyncTrackerItem(payload.itemId, payload.workspacePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('tracker-sync:set-config', async (_event, payload: {
    workspacePath: string;
    key: 'issueKeyPrefix';
    value: string;
  }) => {
    if (!payload?.workspacePath || payload.key !== 'issueKeyPrefix') {
      return { success: false, error: 'workspacePath and issueKeyPrefix required' };
    }
    const entry = engines.get(payload.workspacePath);
    if (!entry) {
      return { success: false, error: 'No active tracker sync for workspace' };
    }
    entry.engine.setIssueKeyPrefix(payload.value);
    return { success: true };
  });

  // Test-only: bypass Stytch / TeamService / org-key-envelope unwrap and
  // wire a TrackerSyncEngine directly to a wrangler-dev TrackerRoom for
  // the resurrected E2E specs. Gated on `process.env.PLAYWRIGHT === '1'`,
  // mirroring `document-sync:open-test` in DocumentSyncHandlers.
  // Reinstated for Limitation 5 of the tracker-sync phase 3+4 resolution
  // plan; the original handler was intentionally deleted in phase 3 with
  // the legacy `TrackerSyncProvider`.
  if (process.env.PLAYWRIGHT === '1') {
    safeHandle('tracker-sync:connect-test', async (_event, payload: {
      workspacePath: string;
      serverUrl: string;
      teamProjectId: string;
      orgId: string;
      userId: string;
      encryptionKeyJwk: JsonWebKey;
    }) => {
      try {
        if (!payload?.workspacePath || !payload?.teamProjectId || !payload?.orgId) {
          return { success: false, error: 'workspacePath, teamProjectId, orgId required' };
        }
        const db = getDatabase();
        if (!db) {
          return { success: false, error: 'database unavailable' };
        }

        // Tear down any pre-existing engine for this workspace so the
        // test starts from a clean slate.
        const existing = engines.get(payload.workspacePath);
        if (existing) {
          try { existing.engine.destroy(); } catch { /* ignore */ }
          engines.delete(payload.workspacePath);
        }

        const encryptionKey = await crypto.subtle.importKey(
          'jwk',
          payload.encryptionKeyJwk,
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt'],
        );
        const orgKeyFingerprint = await fingerprintTrackerKey(encryptionKey);
        const persistence = new TrackerPGLiteStore(db, payload.workspacePath);

        const workspacePath = payload.workspacePath;
        const config: TrackerSyncEngineConfig = {
          serverUrl: payload.serverUrl,
          orgId: payload.orgId,
          teamProjectId: payload.teamProjectId,
          userId: payload.userId,
          encryptionKey,
          orgKeyFingerprint,
          persistence,
          schemaSync: {
            getMaxSyncId: () => getMaxTrackerSchemaSyncId(workspacePath),
            listUnsynced: () => listUnsyncedTrackerSchemaDefs(workspacePath),
            applyRemote: (def) => applyRemoteWorkspaceTrackerSchemaDef(workspacePath, def),
          },
          navigationSync: {
            getMaxSyncId: () => getMaxTrackerNavigationSyncId(workspacePath),
            listUnsynced: () => listUnsyncedTrackerNavigationEntries(workspacePath),
            applyRemote: (def) => applyRemoteWorkspaceTrackerNavigationEntry(workspacePath, def),
          },
          getJwt: async () => 'test-jwt',
          createWebSocket: ((url: string) => new WebSocket(url)) as unknown as TrackerSyncEngineConfig['createWebSocket'],
          onStatusChange: (status) => {
            const entry = engines.get(workspacePath);
            if (entry) entry.status = status;
            broadcastToAllWindows('tracker-sync:status-changed', { workspacePath, status, shared: true });
          },
          onItemApplied: (applied) => {
            emitItemApplied(workspacePath, applied);
          },
          onConfigChange: (roomConfig) => {
            const entry = engines.get(workspacePath);
            if (entry) entry.config = roomConfig;
            broadcastToAllWindows('tracker-sync:config-changed', { workspacePath, config: roomConfig });
          },
          onRejection: (rejection) => emitRejection(workspacePath, rejection),
        };

        const engine = new TrackerSyncEngine(config);
        engines.set(workspacePath, {
          workspacePath,
          orgId: payload.orgId,
          engine,
          status: 'disconnected',
          config: null,
          store: persistence,
        });
        await engine.connect();
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }
}

// ============================================================================
// TrackerItem -> TrackerItemPayload converter
// ============================================================================

/**
 * Convert the legacy TrackerItem shape that every existing caller passes
 * into the wire payload the engine ships. Uses the canonical
 * `trackerItemToRecord` first so the field / system-key separation stays
 * consistent with the rest of the codebase.
 *
 * The engine separately calls `stripLocalOnlyFields` at encryption time,
 * so device-local fields (e.g. `linkedSessions`) that survive this
 * conversion get stripped before they cross the wire.
 */
export function trackerItemToPayload(item: TrackerItem): TrackerItemPayload {
  const record = trackerItemToRecord(item);
  // Labels CRDT (D3): ship the add-wins map. Legacy items written before
  // the CRDT shipped only have `labels: string[]`; for those we reconcile
  // by treating the array as the desired state against an empty prior map
  // -- mints fresh per-element IDs and produces a valid map. Items that
  // already carry a `labelsMap` ship it unchanged.
  const priorMap: LabelsMap | undefined = item.labelsMap as LabelsMap | undefined;
  const labelsMap = applyLabelDiff(priorMap, item.labels);
  return {
    itemId: record.id,
    primaryType: record.primaryType,
    archived: record.archived,
    issueNumber: record.issueNumber,
    issueKey: record.issueKey,
    // Phase 4b: surface the local body-version pointer through the wire
    // envelope. Defaults to 0 for items whose body has never been saved.
    // The receiving client uses this to detect remote body changes and
    // invalidate cold caches.
    bodyVersion: item.bodyVersion ?? 0,
    // `record.fields.labels` is still shipped as a string[] for legacy
    // peers (engines on the rewrite branch read `payload.labels`; older
    // clients on `fields.labels` still see the projection). The CRDT map
    // travels in `payload.labels`.
    fields: { ...record.fields },
    labels: labelsMap,
    comments: record.system.comments ?? [],
    system: {
      authorIdentity: record.system.authorIdentity ?? null,
      lastModifiedBy: record.system.lastModifiedBy ?? null,
      createdByAgent: record.system.createdByAgent,
      linkedCommitSha: record.system.linkedCommitSha,
      linkedCommits: record.system.linkedCommits,
      documentId: record.system.documentId,
      createdAt: record.system.createdAt,
      updatedAt: record.system.updatedAt,
      // Structured origin (external-source imports) must travel with the
      // payload so imported items keep their provenance through the optimistic
      // local apply and across the sync wire to teammates. Without this the
      // first upsert rewrites `data` from the payload and drops `data.origin`,
      // emptying the URN index.
      origin: record.system.origin,
    },
  };
}
