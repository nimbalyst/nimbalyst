/**
 * TrackerSyncManager (host adapter)
 *
 * Per-workspace `TrackerSyncEngine` lifecycle, plus the IPC + service
 * surface the rest of the Electron main process expects. The engine
 * itself is platform-neutral and lives in
 * `@nimbalyst/runtime/sync/TrackerSyncEngine`; this file is the Electron
 * host: it wires PGLite (`TrackerPGLiteStore`), team metadata
 * (`TeamService`) and the
 * Stytch JWT into a `TrackerSyncEngineConfig`.
 *
 * Lifecycle:
 *   - `initializeTrackerSync(workspacePath)` builds and connects the
 *     engine. Called from `RepositoryManager` per open workspace and
 *     from `WorkspaceManagerWindow`.
 *   - `shutdownTrackerSync(workspacePath?)` tears down one or all engines.
 *   - `reinitializeTrackerSync(workspacePath)` destroys + rebuilds the engine
 *     against freshly resolved routing. Triggered when the project's tracker
 *     room moves to another org (`onRoomMoved`, Epic H3 P1) and by the
 *     `tracker-sync:restart-for-workspace` IPC. It is no longer a key-rotation
 *     handler: the team DEK is server-held and the client carries no key
 *     material to refresh.
 *
 * Renderer bridge:
 *   The 7 `tracker-sync:*` IPC handlers preserved here keep the existing
 *   atoms in `store/listeners/trackerSyncListeners.ts` and
 *   `store/atoms/trackerSync.ts` functional without renderer changes.
 *   `tracker-sync:connect-test` is also registered here; the collab E2E
 *   specs drive tracker sync through it.
 */

import { BrowserWindow, dialog } from 'electron';
import {
  TrackerSyncEngine,
  applyLabelDiff,
  type TrackerSyncEngineConfig,
  type TrackerSyncStatus,
  type AppliedTrackerItem,
  type RejectedTrackerMutation,
  type TrackerItemPayload,
  type TrackerRoomConfig,
  type LabelsMap,
} from '@nimbalyst/runtime/sync';
import { asTeamJwt, asTeamMemberId, type TrackerItem } from '@nimbalyst/runtime';
import { trackerItemToRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import WebSocket from 'ws';

import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { isAuthenticated } from './StytchAuthService';
import { findTeamForWorkspace, getOrgScopedIdentity, getOrgScopedJwt } from './TeamService';
import { getCollabSyncWsUrl } from '../utils/collabSyncUrl';
import { getDatabase } from '../database/initialize';
import { TrackerPGLiteStore } from './tracker/TrackerPGLiteStore';
import {
  listUnsyncedTrackerSchemaDefs,
} from './tracker/trackerTypeDefStore';
import {
  applyRemoteWorkspaceTrackerSchemaDef,
  encodeTrackerSchemaDefForPush,
} from './TrackerSchemaService';
import {
  applyRemoteWorkspaceTrackerNavigationEntry,
  registerTrackerNavigationFlushHandler,
} from './TrackerNavigationService';
import {
  getMaxTrackerNavigationSyncId,
  listUnsyncedTrackerNavigationEntries,
} from './tracker/trackerNavigationStore';
import {
  getMaxSharedSavedViewSyncId,
  listUnsyncedSharedSavedViews,
} from './tracker/trackerSavedViewStore';
import {
  applyRemoteWorkspaceSharedSavedView,
  registerTrackerSavedViewFlushHandler,
} from './TrackerSavedViewService';
import { windows, windowStates } from '../window/windowState';
import { getEffectiveTrackerSharingPolicy, decideBackfillAction } from './TrackerPolicyService';
import { rowToTrackerItem } from '../mcp/tools/trackerToolHandlers';
import { getWorkspaceState, updateWorkspaceState } from '../utils/store';
import { AnalyticsService } from './analytics/AnalyticsService';
import { sendTeamAnalyticsEvent } from './analytics/TeamAnalytics';
import { CollaborationHealthAttemptTracker } from '../../shared/analytics/collaborationHealth';
import { categorizeTeamAnalyticsError, toStableAnalyticsCategory } from '../../shared/analytics/teamAnalytics';

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
const trackerSyncAnalytics = AnalyticsService.getInstance();
const initializedTrackerSyncWorkspaces = new Set<string>();

/**
 * Local lookup of a rejected item's tracker type. Only the type name is
 * reported; the item id never leaves the process.
 */
async function resolveTrackerTypeForItem(itemId: string): Promise<string> {
  try {
    const db = getDatabase();
    if (!db) return 'unknown';
    const row = await db.query<{ type: string }>(
      `SELECT type FROM tracker_items WHERE id = $1 LIMIT 1`,
      [itemId],
    );
    return toStableAnalyticsCategory(row.rows[0]?.type);
  } catch {
    return 'unknown';
  }
}

registerTrackerNavigationFlushHandler((workspacePath) =>
  engines.get(workspacePath)?.engine.flushNavigation(),
);

registerTrackerSavedViewFlushHandler((workspacePath) =>
  engines.get(workspacePath)?.engine.flushSavedViews(),
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

type AppliedItemListener = (workspacePath: string, applied: AppliedTrackerItem) => void;
const appliedItemListeners = new Set<AppliedItemListener>();

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

/**
 * Observe items as the room acks them, from inside the main process.
 *
 * `emitItemApplied` already has the server-assigned `issueKey` in hand but only
 * fans it out over IPC, which is useless to a main-process caller. The MCP
 * publish/create path needs it: a published item has no key until the room
 * assigns one, and main-process callers need to report that assignment without
 * inventing a client-side placeholder.
 */
export function onTrackerItemApplied(listener: AppliedItemListener): () => void {
  appliedItemListeners.add(listener);
  return () => appliedItemListeners.delete(listener);
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

  const healthAttempt = new CollaborationHealthAttemptTracker('tracker', 'server_managed');
  healthAttempt.start(initializedTrackerSyncWorkspaces.has(workspacePath) ? 'reconnect' : 'initial');
  initializedTrackerSyncWorkspaces.add(workspacePath);

  const db = getDatabase();
  if (!db) {
    logger.main.error('[TrackerSyncManager] database not available; cannot start engine');
    const healthProperties = healthAttempt.observe('error', new Error('Local sync database unavailable'));
    if (healthProperties) {
      sendTeamAnalyticsEvent(trackerSyncAnalytics, 'collab_sync_attempt_completed', healthProperties);
    }
    return;
  }

  const persistence = new TrackerPGLiteStore(db, workspacePath);
  const { teamMemberId } = await getOrgScopedIdentity(team.orgId);

  const config: TrackerSyncEngineConfig = {
    serverUrl: getCollabSyncWsUrl(),
    orgId: team.orgId,
    teamProjectId: team.teamProjectId,
    teamMemberId,
    persistence,
    initializeIssueKeyPrefix: getWorkspaceState(workspacePath).issueKeyPrefix,
    schemaSync: {
      // An override of a builtin goes out as a DELTA so each peer resolves it
      // against its own builtin and keeps receiving shipped fields (#1178).
      listUnsynced: async () =>
        (await listUnsyncedTrackerSchemaDefs(workspacePath)).map(encodeTrackerSchemaDefForPush),
      applyRemote: (def) => applyRemoteWorkspaceTrackerSchemaDef(workspacePath, def),
    },
    navigationSync: {
      getMaxSyncId: () => getMaxTrackerNavigationSyncId(workspacePath),
      listUnsynced: () => listUnsyncedTrackerNavigationEntries(workspacePath),
      applyRemote: (def) => applyRemoteWorkspaceTrackerNavigationEntry(workspacePath, def),
    },
    savedViewSync: {
      getMaxSyncId: () => getMaxSharedSavedViewSyncId(workspacePath),
      listUnsynced: () => listUnsyncedSharedSavedViews(workspacePath),
      applyRemote: (def) => applyRemoteWorkspaceSharedSavedView(workspacePath, def),
    },
    getJwt: () => getOrgScopedJwt(team.orgId),
    // Node.js 22+ ships a global WebSocket, but Electron's main process
    // historically pinned a Chromium-era version; use `ws` from the same
    // import DocumentSyncHandlers does for reliability across Electron
    // version bumps. The `ws` constructor's instance lacks `dispatchEvent`
    // so it does not satisfy lib.dom's WebSocket interface structurally;
    // the cast is intentional and matches DocumentSyncHandlers' approach.
    createWebSocket: ((url: string) => new WebSocket(url)) as unknown as TrackerSyncEngineConfig['createWebSocket'],
    onStatusChange: (status) => {
      const healthProperties = healthAttempt.observe(status);
      if (healthProperties) {
        sendTeamAnalyticsEvent(trackerSyncAnalytics, 'collab_sync_attempt_completed', healthProperties);
      }
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
      updateWorkspaceState(workspacePath, state => {
        state.issueKeyPrefix = roomConfig.issueKeyPrefix;
      });
      broadcastToAllWindows('tracker-sync:config-changed', { workspacePath, config: roomConfig });
    },
    onServerError: (error) => {
      logger.main.warn('[TrackerSyncManager] server diagnostic for', workspacePath, 'code:', error.code, 'message:', error.message);
      broadcastToAllWindows('tracker-sync:config-error', { workspacePath, error });
    },
    onRejection: (rejection) => {
      logger.main.warn('[TrackerSyncManager] onRejection for', workspacePath, 'itemId:', rejection.itemId, 'code:', rejection.rejection.code, 'message:', rejection.rejection.message);
      // Resolve the tracker type so the rejection dashboards can break down by
      // type; the lookup is local-only and only the type name is reported.
      void resolveTrackerTypeForItem(rejection.itemId).then((trackerType) => {
        const errorCategory = categorizeTeamAnalyticsError(
          'sync',
          `${rejection.rejection.code} ${rejection.rejection.message}`,
        );
        sendTeamAnalyticsEvent(trackerSyncAnalytics, 'tracker_mutation_rejected', {
          surface: 'desktop',
          // A rejection names the item, not which mutation produced it.
          action: 'unknown',
          trackerType,
          errorCategory,
        });
        sendTeamAnalyticsEvent(trackerSyncAnalytics, 'collab_server_mutation_rejected', {
          surface: 'desktop',
          resourceType: 'tracker',
          operation: 'mutation',
          errorCategory,
          // `connectionPath` is intentionally omitted: a rejection arrives on
          // whatever connection is open and we cannot attribute it to an
          // initial connect versus a reconnect without guessing.
        });
      });
      emitRejection(workspacePath, rejection);
    },
    onBootstrapError: (err) => {
      const healthProperties = healthAttempt.observe('error', err);
      if (healthProperties) {
        sendTeamAnalyticsEvent(trackerSyncAnalytics, 'collab_sync_attempt_completed', healthProperties);
      }
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
    const healthProperties = healthAttempt.observe('error', err);
    if (healthProperties) {
      sendTeamAnalyticsEvent(trackerSyncAnalytics, 'collab_sync_attempt_completed', healthProperties);
    }
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
 * Per-workspace guard so we only run the historical backfill once per engine
 * lifecycle. Idempotent within an engine but prevents redundant scans on
 * reconnect / status flapping.
 */
const backfilledWorkspaces = new Set<string>();

/**
 * Drop the once-per-engine backfill guard for a workspace and re-run the
 * scan immediately if an engine is connected. Called when a tracker becomes
 * team-shared -- without this hook
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
 * We only push published items from team trackers. Personal tracker items and
 * drafts stay local.
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
    const policy = getEffectiveTrackerSharingPolicy(workspacePath, row.type as string);
    const item = rowToTrackerItem(row) as TrackerItem;
    // Per-item gate (NIM-876 / NIM-880): team drafts sync only once published.
    //   - published                  -> upsert
    //   - previously published (sync_id set) but now draft -> delete from the
    //       room (propagates an offline unshare; previously this re-uploaded the
    //       item or left a stale copy behind)
    //   - never published draft     -> skip (local-only, no leak)
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
  // Main-process subscribers first: they are waiting on this synchronously
  // (see `awaitServerIssueKey`) and must not be gated behind the tombstone
  // early-return or the async row read-back below.
  for (const cb of appliedItemListeners) {
    try { cb(workspacePath, applied); } catch (err) {
      logger.main.warn('[TrackerSyncManager] applied-item listener threw:', err);
    }
  }
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
// IPC surface
// ============================================================================

export async function setTrackerIssueKeyPrefix(
  workspacePath: string,
  prefix: string,
): Promise<{
  success: boolean;
  error?: string;
  code?: string;
  suggestedPrefix?: string;
  conflictingProjectName?: string;
}> {
  const entry = engines.get(workspacePath);
  if (!entry || entry.status !== 'connected') {
    return { success: false, error: 'Tracker sync must be connected before changing the team project prefix.' };
  }
  const result = await entry.engine.setIssueKeyPrefix(prefix, 'explicit');
  if (!result.success) {
    if (entry.config) {
      updateWorkspaceState(workspacePath, state => {
        state.issueKeyPrefix = entry.config?.issueKeyPrefix;
      });
      broadcastToAllWindows('tracker-sync:config-changed', { workspacePath, config: entry.config });
    }
    return {
      success: false,
      error: result.message ?? 'The server rejected the issue-key prefix.',
      code: result.code,
      suggestedPrefix: result.suggestedPrefix,
      conflictingProjectName: result.conflictingProjectName,
    };
  }
  updateWorkspaceState(workspacePath, state => {
    state.issueKeyPrefix = result.config?.issueKeyPrefix ?? prefix;
  });
  return { success: true };
}

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

  safeHandle('tracker-sync:set-config', async (event, payload: {
    workspacePath: string;
    key: 'issueKeyPrefix';
    value: string;
  }) => {
    if (!payload?.workspacePath || payload.key !== 'issueKeyPrefix') {
      return { success: false, error: 'workspacePath and issueKeyPrefix required' };
    }
    const result = await setTrackerIssueKeyPrefix(payload.workspacePath, payload.value);
    if (!result.success) {
      const detail = result.suggestedPrefix
        ? `${result.error ?? 'That prefix is unavailable'} Suggested prefix: ${result.suggestedPrefix}.`
        : result.error ?? 'The server rejected that prefix.';
      const parent = BrowserWindow.fromWebContents(event.sender);
      const options = {
        type: 'warning',
        title: 'Issue Key Prefix Unavailable',
        message: 'That issue-key prefix could not be assigned.',
        detail,
      } as const;
      if (parent) await dialog.showMessageBox(parent, options);
      else await dialog.showMessageBox(options);
    }
    return result;
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
      // identity-scope-allow: Playwright IPC payload is branded at the test-only handler boundary
      teamMemberId: string;
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

        const persistence = new TrackerPGLiteStore(db, payload.workspacePath);

        const workspacePath = payload.workspacePath;
        const config: TrackerSyncEngineConfig = {
          serverUrl: payload.serverUrl,
          orgId: payload.orgId,
          teamProjectId: payload.teamProjectId,
          teamMemberId: asTeamMemberId(payload.teamMemberId),
          persistence,
          schemaSync: {
                  listUnsynced: async () =>
              (await listUnsyncedTrackerSchemaDefs(workspacePath)).map(
                encodeTrackerSchemaDefForPush,
              ),
            applyRemote: (def) => applyRemoteWorkspaceTrackerSchemaDef(workspacePath, def),
          },
          navigationSync: {
            getMaxSyncId: () => getMaxTrackerNavigationSyncId(workspacePath),
            listUnsynced: () => listUnsyncedTrackerNavigationEntries(workspacePath),
            applyRemote: (def) => applyRemoteWorkspaceTrackerNavigationEntry(workspacePath, def),
          },
          getJwt: async () => asTeamJwt('test-jwt'),
          buildUrl: (roomId) => {
            const wsBase = payload.serverUrl
              .replace(/^http:/, 'ws:')
              .replace(/^https:/, 'wss:')
              .replace(/\/$/, '');
            return `${wsBase}/sync/${roomId}?test_user_id=${encodeURIComponent(payload.teamMemberId)}&test_org_id=${encodeURIComponent(payload.orgId)}`;
          },
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
    activity: record.system.activity ?? [],
    system: {
      authorIdentity: record.system.authorIdentity ?? null,
      lastModifiedBy: record.system.lastModifiedBy ?? null,
      createdByAgent: record.system.createdByAgent,
      linkedCommitSha: record.system.linkedCommitSha,
      linkedCommits: record.system.linkedCommits,
      linkedPullRequests: record.system.linkedPullRequests,
      documentId: record.system.documentId,
      createdAt: record.system.createdAt,
      updatedAt: record.system.updatedAt,
      // Structured origin (external-source imports) must travel with the
      // payload so imported items keep their provenance through the optimistic
      // local apply and across the sync wire to teammates. Without this the
      // first upsert rewrites `data` from the payload and drops `data.origin`,
      // emptying the URN index.
      origin: record.system.origin,
      // Triage is a team decision, so it travels: a colleague clearing an item
      // from their inbox clears it from yours.
      triagedAt: record.system.triagedAt,
      triagedBy: record.system.triagedBy,
    },
  };
}
