import { directoryDeviceId } from './sync/directoryDeviceIdentity';
import { remoteSessions } from './ai/remoteSessions';
import Store from '../utils/privateSettingsStore';
import { getProviderCredentials, subscribeProviderCredentialChanges } from './credentials/providerCredentials';
/**
 * SyncManager - Manages optional session sync.
 *
 * This service is responsible for:
 * - Reading sync configuration from app settings
 * - Creating and managing the SyncProvider instance
 * - Wrapping the session store with sync capabilities when enabled
 *
 * Supports two sync backends:
 * - CollabV3 (recommended): Simple append-only protocol with DO SQLite storage
 * - Y.js (legacy): CRDT-based sync with D1 BLOB storage
 *
 * The sync feature is completely optional. If not configured, nothing happens.
 */

import type { SessionStore } from '@nimbalyst/runtime';
import { asPersonalMemberId } from '@nimbalyst/runtime';
import type { PersonalJwt, PersonalMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import type { DeviceInfo } from '@nimbalyst/runtime/sync';
import * as syncModule from '@nimbalyst/runtime/sync';
import { deriveEncryptionKey, personalSyncEncryptionSalt } from '@nimbalyst/runtime/sync';
import { getSessionSyncConfig, setSessionSyncConfig, getReleaseChannel, getDefaultAIModel, getAlphaFeatures, getPreferredAgentLanguage, getAttachmentStagingConfig, store, type SessionSyncConfig } from '../utils/store';
import { logger } from '../utils/logger';
import { getCredentials } from './CredentialService';
import { getStytchUserId, isAuthenticated, getPersonalOrgId, getPersonalUserId, resolvePersonalUserId, getPersonalSessionJwt, refreshPersonalSessionDetailed } from './StytchAuthService';
import { describePersonalJwtFailure, type PersonalRefreshFailureReason } from './auth/personalJwtFailure';
import { app } from 'electron';
import * as os from 'os';
import { getProjectFileSyncService } from './ProjectFileSyncService';
import { startProjectFileSync, stopAllProjectFileSync } from '../file/WorkspaceWatcher';
import { windowStates } from '../window/WindowManager';
import { createProjectConfigSync } from './sync/projectConfigSync';
import { projectConfigSources } from './sync/projectConfigSources';
import { nextMobileSettingsVersion } from './sync/mobileSettingsVersion';
import { resolveProjectPath } from '../utils/workspaceDetection';
import { selectSessionsForIndexSync } from './sync/selectSessionsForIndexSync';
import { setSleepPreventionMode, setSyncConnected, shutdownSleepPrevention, type PreventSleepMode } from './PowerSaveService';
import { reconnectAllTrackerSyncs } from './TrackerSyncManager';
import { BrowserWindow } from 'electron';
import { timeStartupPhase } from '../utils/startupTiming';
import { compressImageIfNeeded } from '../mcp/mcpImageCompression';
import { resolveWorkspaceAttachmentStagingDirectory } from './attachments/attachmentStagingRoot';

// Screenshots taken by a desktop session are only viewable on mobile if their
// bytes ride along in the synced message -- there is no desktop -> mobile
// attachment channel. Give the truncator a way to downscale the big ones
// instead of dropping them (nativeImage lives in main, the truncator does not).
//
// The budget is much tighter than the MCP one: every screenshot permanently
// occupies part of a SessionRoom's storage cap on the sync server. 150 KB at
// 1600px still gives real zoom headroom on a phone.
const MOBILE_SYNC_IMAGE_MAX_BYTES = 150 * 1024;
const MOBILE_SYNC_IMAGE_MAX_DIMENSION = 1600;

syncModule.setSyncImageCompressor((data, mimeType) => {
  const { data: out, mimeType: outMime } = compressImageIfNeeded(data, mimeType, {
    maxBytes: MOBILE_SYNC_IMAGE_MAX_BYTES,
    maxDimension: MOBILE_SYNC_IMAGE_MAX_DIMENSION,
  });
  return { data: out, mimeType: outMime };
});

function loadSyncModule() {
  return syncModule;
}

// `deriveEncryptionKey` used to be defined here. It moved to
// `@nimbalyst/runtime/sync` (src/sync/encryptionKey.ts) so the headless Node
// host derives bit-identical keys; its parameters are pinned by fixed vectors
// in that package's tests.

interface SyncManagerState {
  provider: import('@nimbalyst/runtime/sync').SyncProvider | null;
  config: SessionSyncConfig | null;
  messageSyncHandler: ReturnType<typeof import('@nimbalyst/runtime/sync').createMessageSyncHandler> | null;
  encryptionKey: CryptoKey | null;
  connected: boolean;
  syncing: boolean;
  error: string | null;
  skippedRowCount?: number;
  sessionKeepAliveInterval: ReturnType<typeof setInterval> | null;
}

const state: SyncManagerState = {
  provider: null,
  config: null,
  messageSyncHandler: null,
  encryptionKey: null,
  connected: false,
  syncing: false,
  error: null,
  sessionKeepAliveInterval: null,
};

// Guard against overlapping incremental syncs (initial + triggered) and enforce minimum interval
let incrementalSyncInFlight = false;
let lastIncrementalSyncAt = 0;
const MIN_INCREMENTAL_SYNC_INTERVAL = 5000; // 5 seconds minimum between syncs

/**
 * Predicate handed to `getAllSessionsForSync` so reconciliation never loads
 * sessions from projects the user did not enable. An empty enabled list means
 * "sync nothing", which is what the per-session filter this replaced already
 * did.
 *
 * Sessions running in a git worktree may have a workspaceId of
 * ".../<project>_worktrees/<name>" rather than the parent project path the user
 * enabled in Settings > Sync. Claude sessions normally adopt the parent path via
 * adoptWorktreeForSession(), but the Codex provider currently does not, so a
 * Codex worktree session keeps the raw worktree path. Accept either form.
 * `resolveProjectPath` touches the disk, so this runs once per distinct
 * workspace path rather than once per session.
 */
function createEnabledProjectFilter(): (workspaceId: string) => boolean {
  const enabledProjectIds = new Set(store.get('sessionSync')?.enabledProjects ?? []);
  return (workspaceId: string) =>
    enabledProjectIds.has(workspaceId) || enabledProjectIds.has(resolveProjectPath(workspaceId));
}

// Event emitter for sync status changes
type SyncStatusListener = (status: { connected: boolean; syncing: boolean; error: string | null; skippedRowCount?: number }) => void;
const statusListeners = new Set<SyncStatusListener>();

/**
 * The provider's update-required block, mirrored into `state.error`.
 * Kept separately because a reconnect clears transport errors but must never
 * clear this one (GitHub #1117).
 */
let personalSyncGateMessage: string | null = null;
let personalSyncGateUnsubscribe: (() => void) | null = null;

/**
 * Subscribe to sync status changes.
 * Returns an unsubscribe function.
 */
export function onSyncStatusChange(listener: SyncStatusListener): () => void {
  statusListeners.add(listener);
  // Immediately emit current status
  listener({ connected: state.connected, syncing: state.syncing, error: state.error, skippedRowCount: state.skippedRowCount });
  return () => statusListeners.delete(listener);
}

/**
 * Update sync status and notify listeners.
 */
function updateSyncStatus(update: Partial<{ connected: boolean; syncing: boolean; error: string | null; skippedRowCount: number }>) {
  let changed = false;
  if (update.skippedRowCount !== undefined && update.skippedRowCount !== state.skippedRowCount) {
    state.skippedRowCount = update.skippedRowCount;
    changed = true;
  }
  if (update.connected !== undefined && update.connected !== state.connected) {
    state.connected = update.connected;
    changed = true;
  }
  if (update.syncing !== undefined && update.syncing !== state.syncing) {
    state.syncing = update.syncing;
    changed = true;
  }
  if (update.error !== undefined && update.error !== state.error) {
    state.error = update.error;
    changed = true;
  }

  if (changed) {
    const status = { connected: state.connected, syncing: state.syncing, error: state.error, skippedRowCount: state.skippedRowCount };
    statusListeners.forEach(listener => listener(status));

    // Manage sleep prevention based on connection state and user preference
    if (update.connected !== undefined) {
      setSyncConnected(update.connected);
    }
  }
}

// ============================================================================
// Desktop Presence Tracking
// ============================================================================

/** Timestamp of last user activity (keypress, click, etc.) */
let lastActivityAt = Date.now();

/** Whether any app window is currently focused */
let isAnyWindowFocused = true;

/** Whether the screen is locked */
let isScreenLocked = false;

/** Timestamp when the desktop first connected */
let connectionTime = Date.now();

/** Configurable idle threshold - default 5 minutes, can be set lower for testing */
let idleThresholdMs = 5 * 60 * 1000; // 5 minutes default

/**
 * Report user activity from the renderer.
 * Called via IPC when user interacts with the app.
 */
export function reportDesktopActivity(): void {
  lastActivityAt = Date.now();
}

/**
 * Update the window focus state.
 * Called when any window gains/loses focus.
 */
export function setWindowFocused(focused: boolean): void {
  isAnyWindowFocused = focused;
  if (focused) {
    // Gaining focus counts as activity
    lastActivityAt = Date.now();
  }
}

/**
 * Update the screen lock state.
 * Called when the OS screen is locked/unlocked.
 */
export function setScreenLocked(locked: boolean): void {
  isScreenLocked = locked;
  logger.main.info(`[SyncManager] Screen lock state changed: ${locked ? 'locked' : 'unlocked'}`);
  if (!locked) {
    // Unlocking counts as activity
    lastActivityAt = Date.now();
  }
}

/**
 * Set the idle threshold in milliseconds.
 * For testing, set to a low value like 10000 (10 seconds).
 */
export function setIdleThresholdMs(ms: number): void {
  idleThresholdMs = ms;
  logger.main.info(`[SyncManager] Idle threshold set to ${ms}ms`);
}

/**
 * Whether the user has truly left their computer (screen locked or idle past threshold).
 * This is stricter than deriveDeviceStatus() === 'away', which also triggers when the
 * Nimbalyst window simply loses focus (user switched to another app on the same Mac).
 * Use this to gate mobile push notifications so they don't duplicate Electron notifications.
 */
export function isDesktopTrulyAway(): boolean {
  if (isScreenLocked) return true;
  const idleTime = Date.now() - lastActivityAt;
  return idleTime > idleThresholdMs;
}

/**
 * Derive the device status based on focus, activity, and screen lock.
 */
export function deriveDeviceStatus(): 'active' | 'idle' | 'away' {
  const idleTime = Date.now() - lastActivityAt;

  // If screen is locked, user is definitely "away"
  if (isScreenLocked) {
    return 'away';
  }

  // If no window is focused, user is "away"
  if (!isAnyWindowFocused) {
    return 'away';
  }

  // If window is focused but no recent activity, user is "idle"
  if (idleTime > idleThresholdMs) {
    return 'idle';
  }

  return 'active';
}

/**
 * Get device info for sync presence awareness.
 * Returns current presence state (focus, activity, status).
 */
function getDeviceInfo(personalMemberId: PersonalMemberId): DeviceInfo {
  const platform = process.platform === 'darwin' ? 'macos'
    : process.platform === 'win32' ? 'windows'
    : process.platform === 'linux' ? 'linux'
    : 'unknown';

  // Get a friendly device name
  const hostname = os.hostname();
  // Clean up common hostname patterns
  const friendlyName = hostname
    .replace(/\.local$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  return {
    deviceId: directoryDeviceId(app.getPath('userData'), personalMemberId),
    name: friendlyName || 'Desktop',
    type: 'desktop',
    platform,
    appVersion: app.getVersion(),
    connectedAt: connectionTime,
    lastActiveAt: lastActivityAt,
    isFocused: isAnyWindowFocused,
    status: deriveDeviceStatus(),
  };
}

/**
 * Initialize sync if configured.
 * Returns a wrapped session store if sync is enabled, or the original store if not.
 */
export async function initializeSync(baseStore: SessionStore): Promise<SessionStore> {
  logger.main.info('[SyncManager] initializeSync called');

  // Label every sync WebSocket connection with this client build so the server
  // can attribute connect/disconnect telemetry to a platform + version.
  syncModule.setSyncClientInfo({ platform: 'desktop', version: app.getVersion() });

  const config = getSessionSyncConfig();
  logger.main.info('[SyncManager] config:', JSON.stringify(config));

  if (!config?.enabled) {
    logger.main.info('[SyncManager] Session sync not enabled in config');
    return baseStore;
  }

  // Initialize sleep prevention mode from persisted config
  setSleepPreventionMode(resolvePreventSleepMode(config));

  // Determine server URL based on environment setting
  const PRODUCTION_SYNC_URL = 'wss://sync.nimbalyst.com';
  const DEVELOPMENT_SYNC_URL = 'ws://localhost:8790';

  // Only honor the environment config in dev builds - production builds always use production sync
  const isDevelopmentBuild = process.env.NODE_ENV !== 'production';
  const effectiveEnvironment = isDevelopmentBuild ? config.environment : undefined;

  // Derive server URL from environment - don't rely on persisted serverUrl as it may be stale
  // (e.g., user switched from dev to production but old localhost URL was persisted)
  let serverUrl: string;
  if (effectiveEnvironment === 'development') {
    serverUrl = DEVELOPMENT_SYNC_URL;
  } else {
    serverUrl = PRODUCTION_SYNC_URL;
  }
  logger.main.info(`[SyncManager] isDevelopmentBuild=${isDevelopmentBuild}, effectiveEnvironment=${effectiveEnvironment}, serverUrl=${serverUrl}`);

  // Require Stytch authentication for sync
  const authenticated = isAuthenticated();
  if (!authenticated) {
    return baseStore;
  }

  // Get user ID from Stytch (for encryption key derivation and device info)
  // Note: JWT refresh happens on-demand before each WebSocket connection via getJwt callback
  const stytchUserId = getStytchUserId();
  if (!stytchUserId) {
    return baseStore;
  }

  try {
    // Credential failures disable optional sync through the normal error path,
    // while keeping local sessions available and preserving the existing key.
    const credentials = getCredentials();

    // Use personalUserId for stable identity across team session exchanges.
    // In Stytch B2B, each org has its own member record. After joining a team,
    // the session gets exchanged to the team org and the JWT sub / user_id changes
    // to the team org member ID. We must use the personal org member ID for:
    // 1. Encryption key salt (must match iOS which always uses personal member ID)
    // 2. Sync room IDs (must be same room as iOS to see each other's data)
    // Always re-derive from the authoritative personal-org exchange so a stale
    // persisted personalUserId is corrected BEFORE we build the sync provider
    // (NIM-859). resolvePersonalUserId() falls back to the cached value when it
    // can't reach the server, so offline init is unchanged.
    let personalUserId = await resolvePersonalUserId(serverUrl);
    if (!personalUserId) {
      personalUserId = getPersonalUserId();
    }
    if (!personalUserId) {
      logger.main.warn('[SyncManager] Could not resolve a personal member id; personal session sync remains disabled');
      return baseStore;
    }

    logger.main.info('[SyncManager] Initializing session sync...', {
      serverUrl,
      activeMemberId: stytchUserId,
      personalUserId,
    });

    const {
      createCollabV3Sync,
      createSyncedSessionStore,
      createMessageSyncHandler,
    } = loadSyncModule();

    // CollabV3 uses the encryption key seed from CredentialService for E2E encryption
    // Use personalUserId for salt to ensure same encryption key across devices
    const encryptionKey = await deriveEncryptionKey(credentials.encryptionKeySeed, personalSyncEncryptionSalt(personalUserId));
    state.encryptionKey = encryptionKey;

    connectionTime = Date.now(); // Reset connection time on init

    // Apply idle timeout from config (default 5 minutes)
    if (config.idleTimeoutMinutes !== undefined) {
      setIdleThresholdMs(config.idleTimeoutMinutes * 60 * 1000);
    }

    // Get initial device info for logging
    const initialDeviceInfo = getDeviceInfo(personalUserId);
    logger.main.info('[SyncManager] Initial device info:', JSON.stringify(initialDeviceInfo));

    // Refresh the personal JWT when its `exp` claim is within this window.
    // Stytch JWTs live ~5 minutes; refreshing inside the last minute keeps a
    // comfortable margin against clock skew and round-trip time without
    // hammering Stytch on every reconnect.
    const REFRESH_SKEW_MS = 60_000;
    // Minimum gap between refresh *attempts* when the prior attempt failed.
    // Without this, a reconnect storm (every WS in the stack calling getJwt
    // back-to-back) would spam Stytch with doomed refresh calls. We do NOT
    // throttle on success -- the expiry check above is what gates that path.
    const FAILED_REFRESH_BACKOFF_MS = 5_000;
    let lastFailedRefreshTime = 0;
    /** Why the most recent refresh attempt failed, so the thrown error can say so. */
    let lastRefreshFailureReason: PersonalRefreshFailureReason | null = null;
    /** The rendered transport error behind a `network` failure, for the log line. */
    let lastRefreshFailureDetail: string | null = null;

    /**
     * Returns the `exp` claim (in ms since epoch) for the JWT, or null if it
     * can't be decoded. JWT signatures are verified by the server; we only
     * read `exp` to decide if a refresh is needed before reconnect.
     */
    function getJwtExpiryMs(jwt: PersonalJwt | null): number | null {
      if (!jwt) return null;
      const parts = jwt.split('.');
      if (parts.length !== 3) return null;
      try {
        const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
        const payload = JSON.parse(
          Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
        ) as { exp?: number };
        return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
      } catch {
        return null;
      }
    }

    // Use personalOrgId and personalUserId for session sync room IDs -- these stay
    // stable even when the JWT is scoped to a team org (after a Stytch session exchange).
    // The server relaxes the orgId check for user-scoped rooms (session/index).
    //
    // IMPORTANT: Prefer the persisted config values over live auth state.
    // The live auth state's personalOrgId depends on which account was logged in
    // first (login order), which can be wrong after a sign-out/re-login cycle.
    // The persisted config was set when sync was enabled or pairing happened,
    // so it reflects the correct org regardless of login order.
    const personalOrgId = config.personalOrgId || getPersonalOrgId();
    if (!personalOrgId) {
      logger.main.warn('[SyncManager] No personal org ID available - cannot initialize sync');
      return baseStore;
    }

    // If the config didn't have a persisted personalOrgId, persist it now
    // so future restarts/re-logins use the correct value.
    if (!config.personalOrgId && personalOrgId) {
      const currentConfig = getSessionSyncConfig();
      if (currentConfig) {
        setSessionSyncConfig({
          ...currentConfig,
          personalOrgId,
          personalUserId,
        });
        logger.main.info('[SyncManager] Persisted personalOrgId to sync config:', personalOrgId);
      }
    }

    // If the persisted sync config disagrees with the personalUserId we just
    // resolved from the authoritative personal-org exchange, the config value is
    // stale (NIM-859). Prefer the resolved id and rewrite the config -- but only
    // when both refer to the same personal org, to avoid clobbering a config
    // written under a different login order (see personalOrgId note above).
    if (config.personalUserId && config.personalUserId !== personalUserId) {
      const sameOrg = !config.personalOrgId || config.personalOrgId === getPersonalOrgId();
      if (sameOrg && personalUserId) {
        logger.main.info(`[SyncManager] Correcting stale sync-config personalUserId ${config.personalUserId} -> ${personalUserId}`);
        const currentConfig = getSessionSyncConfig();
        if (currentConfig) {
          setSessionSyncConfig({ ...currentConfig, personalUserId });
        }
      } else {
        logger.main.info(`[SyncManager] Using persisted personalUserId=${config.personalUserId} (resolved ${personalUserId}; differing org, not overriding)`);
        personalUserId = asPersonalMemberId(config.personalUserId);
      }
    }

    logger.main.info(`[SyncManager] Using personalOrgId=${personalOrgId} personalUserId=${personalUserId} for sync room IDs`);

    const provider = createCollabV3Sync({
      serverUrl,
      orgId: personalOrgId,
      personalMemberId: personalUserId,
      getJwt: async () => {
        // Session sync uses the PERSONAL JWT -- its sub claim matches personalUserId
        // which the server validates against the room URL path. The team-scoped JWT
        // (from getSessionJwt) has a different sub and would fail auth.
        const now = Date.now();
        const cachedJwt = getPersonalSessionJwt();
        const expiryMs = getJwtExpiryMs(cachedJwt);
        const cachedIsFresh = expiryMs !== null && expiryMs - now > REFRESH_SKEW_MS;

        if (!cachedIsFresh) {
          // Avoid hammering Stytch in a tight reconnect loop when the prior
          // refresh just failed. The backoff is short enough that legitimate
          // recovery (network coming back after sleep) happens within a couple
          // of WS retry attempts.
          const failedRecently =
            lastFailedRefreshTime > 0 && now - lastFailedRefreshTime < FAILED_REFRESH_BACKOFF_MS;
          if (!failedRecently) {
            const outcome = await refreshPersonalSessionDetailed(serverUrl);
            if (!outcome.ok) {
              lastFailedRefreshTime = Date.now();
              lastRefreshFailureReason = outcome.reason;
              lastRefreshFailureDetail = outcome.reason === 'network' ? outcome.detail ?? null : null;
              // Name the URL AND the transport error. "refresh failed" alone is
              // what made an unreachable collab worker unreadable in main.log.
              logger.main.warn(
                outcome.reason === 'network'
                  ? `[SyncManager] Sync server ${serverUrl} is unreachable (${lastRefreshFailureDetail ?? 'unknown transport error'}) - personal session refresh will retry; credentials are NOT being cleared`
                  : `[SyncManager] Personal session refresh rejected by ${serverUrl} (${outcome.reason}), JWT may be stale`,
              );
            } else {
              lastFailedRefreshTime = 0;
              lastRefreshFailureReason = null;
              lastRefreshFailureDetail = null;
            }
          }
        }

        const freshJwt = getPersonalSessionJwt();
        if (!freshJwt || freshJwt.split('.').length !== 3) {
          throw new Error('Failed to get valid personal JWT for session sync');
        }

        const freshExpiryMs = getJwtExpiryMs(freshJwt);
        if (freshExpiryMs !== null && freshExpiryMs <= now) {
          // Returning an already-expired JWT guarantees the server rejects the
          // upgrade and the WS error loop never escapes. Throw so the caller's
          // reconnect-with-backoff path runs instead of the bad-token hammer.
          // The message must name the ACTUAL cause: an unreachable sync server
          // is not a token problem, and calling it one has twice sent
          // investigations after a JWT bug that did not exist.
          throw describePersonalJwtFailure({
            reason: lastRefreshFailureReason,
            expiryMs: freshExpiryMs,
            serverUrl,
            detail: lastRefreshFailureDetail,
          });
        }

        return freshJwt;
      },
      encryptionKey,
      // Use callback for dynamic presence updates (called every 30s)
      getDeviceInfo: () => getDeviceInfo(personalUserId),
    });
    logger.main.info('[SyncManager] Created CollabV3 sync provider with device:', initialDeviceInfo.name);

    // Create message sync handler
    const messageSyncHandler = createMessageSyncHandler(provider);

    // Keep the Stytch session token alive while sync is active.
    // The WebSocket only refreshes JWT on reconnect, so if it stays connected
    // for hours the session token can expire. This breaks HTTP endpoints
    // (share links, shared links list) that need a fresh JWT via refresh.
    // Refresh every 30 minutes to keep the session token valid.
    if (state.sessionKeepAliveInterval) {
      clearInterval(state.sessionKeepAliveInterval);
    }
    state.sessionKeepAliveInterval = setInterval(async () => {
      try {
        const { refreshSession: doRefresh } = await import('./StytchAuthService');
        await doRefresh(serverUrl);
      } catch {
        // Refresh failure is non-fatal here -- just means the session token
        // may expire if this keeps failing, but sync stays connected.
      }
    }, 30 * 60 * 1000);

    // Store state
    state.provider = provider;
    remoteSessions.setProvider(provider, encryptionKey);
    state.config = config;
    state.messageSyncHandler = messageSyncHandler;

    // Surface both update requirements and non-blocking unreadable-row counts.
    personalSyncGateUnsubscribe?.();
    personalSyncGateMessage = null;
    personalSyncGateUnsubscribe = provider.onPersonalSyncWriteGateChange?.((gate) => {
      updateSyncStatus({ skippedRowCount: gate.skippedRowCount ?? 0 });
      const message = syncModule.describePersonalSyncWriteGate(gate);
      if (message) {
        personalSyncGateMessage = message;
        logger.main.warn('[SyncManager] Personal-sync writes paused on this device:', gate);
        updateSyncStatus({ error: message });
      } else if (personalSyncGateMessage !== null) {
        const clearing = state.error === personalSyncGateMessage;
        personalSyncGateMessage = null;
        logger.main.info('[SyncManager] Personal-sync writes resumed after a complete index read');
        if (clearing) updateSyncStatus({ error: null });
      }
    }) ?? null;

    // Wrap store with sync capabilities
    const syncedStore = createSyncedSessionStore(baseStore, provider, {
      autoConnect: true,
    });
    // Config discovery owns its retry/logging and must not delay session startup.
    void projectConfigSync.refresh();

    // Sync existing sessions and projects to index using delta sync
    // logger.main.info('[SyncManager] Setting up incremental sync...');
    setTimeout(async () => {
      const syncStart = performance.now();
      // logger.main.info('[SyncManager] Starting initial incremental sync...');
      // Prevent triggered syncs from overlapping with the initial sync
      incrementalSyncInFlight = true;
      try {
        if (!provider.syncSessionsToIndex || !provider.fetchIndex) {
          logger.main.warn('[SyncManager] Provider missing required sync methods');
          return;
        }

        // Step 1: Fetch the server's current index
        const fetchStart = performance.now();
        // logger.main.info('[SyncManager] Fetching server index...');
        let serverIndex: Awaited<ReturnType<NonNullable<typeof provider.fetchIndex>>>;
        try {
          serverIndex = await timeStartupPhase(
            'SyncManager.fetchIndex',
            () => provider.fetchIndex!(),
          );
          const fetchTime = performance.now() - fetchStart;
          // logger.main.info(`[SyncManager] Server has ${serverIndex.sessions.length} sessions (fetch took ${fetchTime.toFixed(1)}ms)`);
        } catch (fetchError) {
          // Don't fall back to full sync - that would load ALL messages for ALL sessions into memory
          // and cause OOM crashes. Instead, skip sync and wait for connection to be restored.
          logger.main.warn('[SyncManager] Failed to fetch server index, skipping sync until connection restored:', fetchError);
          return;
        }

        // Absence from the index is what drives republishing, so it only means
        // anything when the provider proved complete coverage. A partial mirror
        // would look like "the server lost almost everything" and trigger a
        // mass upload. (The CollabV3 provider throws instead of returning a
        // partial result; this is the belt-and-braces check.)
        if (serverIndex.complete === false) {
          logger.main.warn('[SyncManager] Server index coverage is incomplete; skipping reconciliation this cycle');
          return;
        }
        const tombstonedSessionIds = new Set(serverIndex.deletedSessionIds ?? []);
        // Build a map of server sessions for quick lookup
        const serverSessionMap = new Map(
          serverIndex.sessions.map(s => [s.sessionId, s])
        );

        // Step 2: Get local sessions (without messages first for comparison)
        const localStart = performance.now();
        const { getAllSessionsForSync } = await import('./PGLiteSessionStore');
        const allLocalSessions = await timeStartupPhase(
          'SyncManager.getAllSessionsForSync',
          // No messages yet, and only the projects the user enabled -- the
          // filter is applied in SQL rather than over every row in the database.
          () => getAllSessionsForSync(false, { isProjectEnabled: createEnabledProjectFilter() }),
        );
        const localTime = performance.now() - localStart;
        // logger.main.info(`[SyncManager] Local has ${allLocalSessions.length} sessions (query took ${localTime.toFixed(1)}ms)`);

        const { sessionsNeedingIndexUpdate, sessionsNeedingMessageSync } = selectSessionsForIndexSync(allLocalSessions, serverIndex);

        const archiveMismatches = sessionsNeedingIndexUpdate.filter(s => {
          const server = serverSessionMap.get(s.id);
          return server && Boolean(s.isArchived) !== Boolean(server.isArchived);
        }).length;
        const missingFromServer = sessionsNeedingIndexUpdate.filter(s => !serverSessionMap.has(s.id)).length;
        logger.main.info(`[SyncManager] startup sync: ${sessionsNeedingIndexUpdate.length} need index update (${archiveMismatches} archive mismatches, ${missingFromServer} missing from server), ${sessionsNeedingMessageSync.length} need message sync, local=${allLocalSessions.length}, server=${serverIndex.sessions.length}, protocol=v${serverIndex.indexProtocolVersion ?? 1}, tombstones=${tombstonedSessionIds.size}`);

        // Sync sessions that need it
        if (sessionsNeedingIndexUpdate.length === 0 && sessionsNeedingMessageSync.length === 0) {
          // logger.main.info('[SyncManager] All sessions up to date, no sync needed');
        } else {
          // Build per-session sinceTimestamp requests for lazy message loading.
          // Messages are NOT loaded here -- the provider loads them in small batches
          // to avoid blocking PGLite's single-threaded worker for 30+ seconds.
          const messageSyncRequests = sessionsNeedingMessageSync.length > 0
            ? sessionsNeedingIndexUpdate
                .filter(s => sessionsNeedingMessageSync.includes(s.id))
                .map(session => {
                  const serverSession = serverSessionMap.get(session.id);
                  return { sessionId: session.id, sinceTimestamp: serverSession?.lastMessageAt || 0 };
                })
            : undefined;

          const { getSessionMessagesForSyncBatch } = await import('./PGLiteSessionStore');

          // Reconciliation runs in the background so index publication does not delay startup.
          void provider.syncSessionsToIndex(sessionsNeedingIndexUpdate, {
            syncMessages: sessionsNeedingMessageSync.length > 0,
            messageSyncRequests,
            getMessagesForSync: getSessionMessagesForSyncBatch,
          });
        }
        // Clear stale isExecuting flags: on startup, no sessions are running yet.
        // If the app crashed or the WebSocket disconnected before isExecuting:false
        // was pushed, the server retains the stale flag permanently.
        // Clear the local cache and re-sync affected sessions to push isExecuting:false.
        const staleExecutingSessions = serverIndex.sessions.filter(s => s.isExecuting);
        if (staleExecutingSessions.length > 0) {
          logger.main.info(`[SyncManager] Clearing stale isExecuting for ${staleExecutingSessions.length} sessions`);
          // Clear isExecuting in the provider's local cache so syncSessionsToIndex
          // builds entries with isExecuting:false
          if (provider.clearAllExecutingState) {
            provider.clearAllExecutingState();
          }
          // Re-sync these sessions to push the cleared flag to the server
          const staleLocalSessions = staleExecutingSessions
            .map(s => allLocalSessions.find(ls => ls.id === s.sessionId))
            .filter((s): s is NonNullable<typeof s> => s != null);
          if (staleLocalSessions.length > 0) {
            // Clearing stale flags is background reconciliation and must not delay startup.
            void provider.syncSessionsToIndex(staleLocalSessions, { syncMessages: false });
          }
        }

        // const totalSyncTime = performance.now() - syncStart;
        // logger.main.info(`[SyncManager] Incremental sync completed in ${totalSyncTime.toFixed(1)}ms`);
      } catch (error) {
        logger.main.warn('[SyncManager] Failed to sync sessions:', error);
      } finally {
        incrementalSyncInFlight = false;
        lastIncrementalSyncAt = Date.now();
      }
    }, 2000); // Wait for index connection

    // Sync current OpenAI API key to mobile (in case mobile connects after key was set)
    setTimeout(async () => {
      try {

        // Always sync so the mobile model picker gets the available-models list
        // even for agent-only users with no OpenAI key (e.g. Codex). Mobile
        // keeps its stored key when openaiKey is undefined (NIM-976).
        // logger.main.info('[SyncManager] Syncing existing settings to mobile devices');
        await syncSettingsToMobile();
      } catch (error) {
        logger.main.warn('[SyncManager] Failed to sync initial settings:', error);
      }
    }, 3000); // Wait a bit for index connection to be established

    // Sync settings whenever a mobile device connects (joins or reconnects)
    // Track which mobile devices are currently connected so we can detect when one joins
    let previousMobileDeviceIds = new Set<string>();
    let isFirstCallback = true;
    if (provider.onDeviceStatusChange) {
      provider.onDeviceStatusChange((devices) => {
        const mobileDevices = devices.filter(d => d.type === 'mobile');
        const currentMobileIds = new Set(mobileDevices.map(d => d.deviceId));

        // Check for mobile devices that just connected (weren't in the previous set)
        for (const device of mobileDevices) {
          if (!previousMobileDeviceIds.has(device.deviceId)) {
            logger.main.info(`[SyncManager] Mobile device connected: ${device.name}, syncing settings...`);
            // On first callback, add a small delay to ensure WebSocket is fully ready
            // This handles the case where mobile connected before desktop registered the listener
            const delay = isFirstCallback ? 1000 : 0;
            setTimeout(async () => {
              // Sync settings to the mobile device
              if (state.provider !== provider) return;
              try {
                const results = await Promise.allSettled([syncSettingsToMobile(), projectConfigSync.refresh()]);
                const operations = ['settings', 'project config'];
                results.forEach((result, index) => {
                  if (result.status === 'rejected') logger.main.warn(`[SyncManager] Failed to refresh mobile device ${operations[index]}:`, result.reason);
                });
              } catch (error) {
                logger.main.warn('[SyncManager] Failed to refresh mobile device settings or project config:', error);
              }
            }, delay);
          }
        }

        previousMobileDeviceIds = currentMobileIds;
        isFirstCallback = false;
      });
    }

    // Initialize ProjectFileSyncService for mobile .md sync (alpha channel only)
    if (getReleaseChannel() === 'alpha') {
      try {
        const projectFileSync = getProjectFileSyncService();
        await projectFileSync.initialize();
        logger.main.info('[SyncManager] ProjectFileSyncService initialized (alpha channel)');

        // Kick off project file sync for all already-open workspaces.
        // The workspace watcher's startProjectFileSync call at window-open time
        // likely ran before sync was ready (isSyncEnabled() was false), so we
        // need to retry now that sync is fully initialized.
        for (const ws of windowStates.values()) {
          if (ws.workspacePath) {
            startProjectFileSync(ws.workspacePath).catch(err => {
              logger.main.warn('[SyncManager] Failed to start project file sync for workspace:', err);
            });
          }
        }
      } catch (err) {
        logger.main.warn('[SyncManager] ProjectFileSyncService failed to initialize (non-fatal):', err);
      }
    }

    // Mark as connected
    updateSyncStatus({ connected: true, syncing: false, error: null });

    logger.main.info('[SyncManager] Session sync initialized successfully');
    return syncedStore;
  } catch (error) {
    logger.main.error('[SyncManager] Failed to initialize sync:', error);
    updateSyncStatus({ connected: false, syncing: false, error: String(error) });
    // Return base store on failure - sync is optional
    return baseStore;
  }
}

/**
 * Get the current sync provider (if sync is enabled).
 */
export function getSyncProvider(): import('@nimbalyst/runtime/sync').SyncProvider | null {
  return state.provider;
}

/**
 * Get the message sync handler (if sync is enabled).
 */
export function getMessageSyncHandler(): ReturnType<typeof import('@nimbalyst/runtime/sync').createMessageSyncHandler> | null {
  return state.messageSyncHandler;
}

/**
 * Resolve the effective sleep prevention mode from config,
 * handling migration from the old boolean field.
 */
export function resolvePreventSleepMode(config: { preventSleepMode?: PreventSleepMode; preventSleepWhenSyncing?: boolean } | null | undefined): PreventSleepMode {
  if (!config) return 'off';
  if (config.preventSleepMode) return config.preventSleepMode;
  // Migrate old boolean: true -> 'always', false/undefined -> 'off'
  if (config.preventSleepWhenSyncing === true) return 'always';
  return 'off';
}

/**
 * Update sleep prevention state based on current config.
 * Call this when the preventSleepMode setting changes at runtime.
 */
export function updateSleepPrevention(): void {
  const config = getSessionSyncConfig();
  const mode = resolvePreventSleepMode(config);
  setSleepPreventionMode(mode);
}

/**
 * Check if sync is currently active.
 */
export function isSyncEnabled(): boolean {
  return state.provider !== null && state.config?.enabled === true;
}

/**
 * Check if the sync provider is initialized and ready for incremental syncs.
 */
export function isSyncProviderReady(): boolean {
  return state.provider !== null;
}

/**
 * Get the personal document sync config for the renderer.
 * Used by TabEditor to connect .md files to PersonalDocumentRooms.
 *
 * Returns null if sync is not enabled or not ready.
 */
export function getPersonalDocSyncConfig(): {
  serverUrl: string;
  orgId: string;
  personalMemberId: PersonalMemberId;
  encryptionKeyRaw: CryptoKey;
} | null {
  if (!isSyncEnabled() || !state.encryptionKey || !state.config) return null;

  const personalOrgId = state.config.personalOrgId || getPersonalOrgId();
  const personalMemberId = state.config.personalUserId
    ? asPersonalMemberId(state.config.personalUserId)
    : getPersonalUserId();
  if (!personalOrgId || !personalMemberId) return null;

  const isDev = process.env.NODE_ENV !== 'production';
  const env = isDev ? state.config.environment : undefined;
  const serverUrl = env === 'development' ? 'ws://localhost:8790' : 'wss://sync.nimbalyst.com';

  return {
    serverUrl,
    orgId: personalOrgId,
    personalMemberId,
    encryptionKeyRaw: state.encryptionKey,
  };
}

/**
 * Shutdown sync and disconnect all sessions.
 */
export function shutdownSync(): void {
  projectConfigSync.stop();
  remoteSessions.setProvider(null);
  shutdownSleepPrevention();

  if (state.sessionKeepAliveInterval) {
    clearInterval(state.sessionKeepAliveInterval);
    state.sessionKeepAliveInterval = null;
  }
  // Shutdown ProjectFileSyncService. Clear the watcher subscriptions first so
  // a subsequent initializeSync re-subscribes and reconnects each project room
  // (a stale subscription entry would make startProjectFileSync early-return
  // and strand every later file save in a never-drained offline queue).
  try {
    stopAllProjectFileSync();
    getProjectFileSyncService().shutdown();
  } catch {
    // Non-fatal
  }

  if (state.provider) {
    logger.main.info('[SyncManager] Shutting down session sync...');
    personalSyncGateUnsubscribe?.();
    personalSyncGateUnsubscribe = null;
    personalSyncGateMessage = null;
    state.provider.disconnectAll();
    state.provider = null;
    state.config = null;
    state.messageSyncHandler = null;
    updateSyncStatus({ connected: false, syncing: false, error: null, skippedRowCount: 0 });
  }
}

/**
 * Reinitialize sync with new configuration.
 * Useful when settings change.
 */
export async function reinitializeSync(baseStore: SessionStore): Promise<SessionStore> {
  shutdownSync();
  return initializeSync(baseStore);
}

/**
 * Trigger an incremental sync to push local sessions to the server.
 * Useful when a new project is enabled for sync.
 */
export async function triggerIncrementalSync(): Promise<void> {
  const provider = state.provider;
  if (!provider) {
    logger.main.warn('[SyncManager] Cannot trigger sync - provider not initialized');
    return;
  }

  if (!provider.syncSessionsToIndex || !provider.fetchIndex) {
    logger.main.warn('[SyncManager] Provider missing required sync methods');
    return;
  }

  // Skip if a sync is already in flight
  if (incrementalSyncInFlight) {
    logger.main.debug('[SyncManager] Incremental sync already in flight, skipping');
    return;
  }

  // Enforce minimum interval between syncs
  const now = Date.now();
  if (now - lastIncrementalSyncAt < MIN_INCREMENTAL_SYNC_INTERVAL) {
    logger.main.debug('[SyncManager] Incremental sync too soon after last sync, skipping');
    return;
  }

  incrementalSyncInFlight = true;
  lastIncrementalSyncAt = now;

  const syncStart = performance.now();
  // logger.main.info('[SyncManager] Starting triggered incremental sync...');

  try {
    // Fetch the server's current index
    const fetchStart = performance.now();
    let serverIndex: Awaited<ReturnType<NonNullable<typeof provider.fetchIndex>>>;
    try {
      serverIndex = await provider.fetchIndex();
      const fetchTime = performance.now() - fetchStart;
      // logger.main.info(`[SyncManager] Triggered sync: server has ${serverIndex.sessions.length} sessions (fetch took ${fetchTime.toFixed(1)}ms)`);
    } catch (fetchError) {
      // Don't fall back to full sync - that would load ALL messages for ALL sessions into memory
      // and cause OOM crashes. Instead, attempt to reconnect and skip this sync cycle.
      logger.main.warn('[SyncManager] Failed to fetch server index, skipping incremental sync:', fetchError);
      // Attempt to reconnect in background so the next sync has a live connection
      if (provider.reconnectIndex) {
        provider.reconnectIndex().catch(err => {
          logger.main.debug('[SyncManager] Background reconnect attempt failed:', err);
        });
      }
      return;
    }

    // See the startup path: absence only means "republish" over proven coverage.
    if (serverIndex.complete === false) {
      logger.main.warn('[SyncManager] Server index coverage is incomplete; skipping incremental sync this cycle');
      return;
    }
    // Build a map of server sessions for quick lookup
    const serverSessionMap = new Map(
      serverIndex.sessions.map(s => [s.sessionId, s])
    );

    // Get local sessions
    const localStart = performance.now();
    const { getAllSessionsForSync } = await import('./PGLiteSessionStore');
    const allLocalSessions = await getAllSessionsForSync(false, {
      isProjectEnabled: createEnabledProjectFilter(),
    });
    const localTime = performance.now() - localStart;
    // logger.main.info(`[SyncManager] Triggered sync: local has ${allLocalSessions.length} sessions (query took ${localTime.toFixed(1)}ms)`);

    const { sessionsNeedingIndexUpdate, sessionsNeedingMessageSync } = selectSessionsForIndexSync(allLocalSessions, serverIndex);

    // logger.main.info(`[SyncManager] Triggered sync: ${sessionsNeedingIndexUpdate.length}/${allLocalSessions.length} sessions need update, ${sessionsNeedingMessageSync.length} need message sync (server has ${serverIndex.sessions.length})`);

    if (sessionsNeedingIndexUpdate.length === 0 && sessionsNeedingMessageSync.length === 0) {
      // logger.main.info('[SyncManager] Triggered sync: all sessions up to date');
    } else {
      const messageSyncRequests = sessionsNeedingMessageSync.length > 0
        ? sessionsNeedingIndexUpdate
            .filter(s => sessionsNeedingMessageSync.includes(s.id))
            .map(session => {
              const serverSession = serverSessionMap.get(session.id);
              return { sessionId: session.id, sinceTimestamp: serverSession?.lastMessageAt || 0 };
            })
        : undefined;

      const { getSessionMessagesForSyncBatch } = await import('./PGLiteSessionStore');

      // Reconciliation publishes in the background so reconnect work can continue independently.
      void provider.syncSessionsToIndex(sessionsNeedingIndexUpdate, {
        syncMessages: sessionsNeedingMessageSync.length > 0,
        messageSyncRequests,
        getMessagesForSync: getSessionMessagesForSyncBatch,
      });
    }

    // const totalSyncTime = performance.now() - syncStart;
    // logger.main.info(`[SyncManager] Triggered sync completed in ${totalSyncTime.toFixed(1)}ms`);
  } catch (error) {
    logger.main.error('[SyncManager] Triggered sync failed:', error);
  } finally {
    incrementalSyncInFlight = false;
  }
}

// ============================================================================
// Settings Sync (Desktop -> Mobile)
// ============================================================================

/**
 * Get voice mode settings from the settings store.
 */
async function getVoiceModeSettings(): Promise<{ voice?: string; submitDelayMs?: number; engine?: string; liveVoice?: string; liveControllerModel?: string } | undefined> {
  try {
    const settingsStore = new Store<Record<string, unknown>>({ name: 'nimbalyst-settings' });
    const voiceMode = settingsStore.get('voiceMode') as { voice?: string; submitDelayMs?: number; engine?: string; liveVoice?: string; liveControllerModel?: string } | undefined;
    return voiceMode;
  } catch {
    return undefined;
  }
}

/**
 * Get available AI models for syncing to mobile.
 * Uses the same filtering logic as the ai:getModels IPC handler.
 */
async function getAvailableModelsForMobile(): Promise<{ models: Array<{ id: string; name: string; provider: string }>; defaultModel?: string }> {
  try {
    const { ModelRegistry } = await import('@nimbalyst/runtime/ai/server/ModelRegistry');

    const aiStore = new Store<Record<string, unknown>>({ name: 'ai-settings' });
    const apiKeys = getProviderCredentials().availableKeys();
    const providerSettings = aiStore.get('providerSettings', {}) as Record<string, { enabled?: boolean; models?: string[]; baseUrl?: string }>;

    // Build enabled provider set to avoid fetching from disabled providers (e.g., LMStudio network call)
    const enabledSet = new Set<string>();
    if (providerSettings['claude']?.enabled === true && !!apiKeys['anthropic']) enabledSet.add('claude');
    if (providerSettings['claude-code']?.enabled !== false) enabledSet.add('claude-code');
    if (providerSettings['openai']?.enabled === true && !!apiKeys['openai']) enabledSet.add('openai');
    if (providerSettings['openai-codex']?.enabled === true) enabledSet.add('openai-codex');
    if (providerSettings['openai-codex-acp']?.enabled === true) enabledSet.add('openai-codex-acp');
    if (providerSettings['lmstudio']?.enabled === true) enabledSet.add('lmstudio');

    const modelsConfig = {
      ...apiKeys,
      lmstudio_url: providerSettings['lmstudio']?.baseUrl || 'http://127.0.0.1:8234'
    };
    // Mobile syncs one account-wide model list, not a per-project one, and
    // `enabledSet` above never includes opencode -- the only project-scoped lane.
    const allModels = await ModelRegistry.getAllModels(modelsConfig, undefined, enabledSet as Set<any>);
    // Filter to enabled models (model-level filtering for specific model selection)
    const enabledModels = allModels.filter(model => {
      const ps = providerSettings[model.provider] as { enabled?: boolean; models?: string[]; hiddenModels?: string[] } | undefined;
      // Denylist wins: a hidden model never syncs to mobile, even if allow-listed.
      if (ps?.hiddenModels?.includes(model.id)) return false;
      // If specific models are selected for this provider, filter
      if (ps?.models && ps.models.length > 0) {
        return ps.models.includes(model.id);
      }
      return true;
    });

    const models = enabledModels.map(m => ({ id: m.id, name: m.name, provider: m.provider }));
    const defaultModel = getDefaultAIModel() || 'claude-code:opus-1m';
    return { models, defaultModel };
  } catch (err) {
    logger.main.warn('[SyncManager] Failed to fetch models for mobile sync:', err);
    return { models: [] };
  }
}

/**
 * Sync sensitive settings to mobile devices.
 * Syncs the OpenAI API key, voice mode settings, and available AI models.
 *
 * Reads the current protected value at send time; omitted preserves, empty deletes.
 */
export async function syncSettingsToMobile(_legacyOpenaiApiKey?: string): Promise<void> {
  const provider = state.provider;
  if (!provider) {
    logger.main.debug('[SyncManager] Cannot sync settings - provider not initialized');
    return;
  }

  if (!provider.syncSettings) {
    logger.main.debug('[SyncManager] Provider does not support syncSettings');
    return;
  }

  const settingsVersion = nextMobileSettingsVersion();
  if (settingsVersion === undefined) return;
  // Get voice mode settings
  const voiceModeSettings = await getVoiceModeSettings();

  // Get available AI models for the mobile model picker
  const { models: availableModels, defaultModel } = await getAvailableModelsForMobile();

  // Whether the desktop "meta-agent" alpha feature is enabled (gates the mobile Meta Agent UI)
  const metaAgentEnabled = getAlphaFeatures()['meta-agent'] ?? false;

  // Desktop's preferred agent language. The mobile voice agent pins its spoken
  // language to this so it never starts up in a different language than the
  // desktop is configured for. Undefined (no preference) -> falls back to English.
  const preferredAgentLanguage = getPreferredAgentLanguage();

  // logger.main.info(`[SyncManager] Syncing settings to mobile devices (version ${settingsVersion}, ${availableModels.length} models)`);

  try {
    await provider.syncSettings({
      openaiApiKey: getProviderCredentials().mobileOpenAIKey(),
      voiceMode: voiceModeSettings ? {
        voice: voiceModeSettings.voice as 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar' | undefined,
        submitDelayMs: voiceModeSettings.submitDelayMs,
        engine: voiceModeSettings.engine,
        liveVoice: voiceModeSettings.liveVoice ?? voiceModeSettings.voice,
        liveControllerModel: voiceModeSettings.liveControllerModel,
      } : undefined,
      availableModels,
      defaultModel,
      metaAgentEnabled,
      preferredAgentLanguage,
      version: settingsVersion,
    });
    // logger.main.info('[SyncManager] Settings synced successfully');
  } catch (error) {
    logger.main.error('[SyncManager] Failed to sync settings:', error);
  }
}

// ============================================================================
// Project Config Sync (commands, etc.)
// ============================================================================

export const projectConfigSync = createProjectConfigSync({
  ...projectConfigSources,
  getProvider: () => state.provider,
  getEnabledProjects: () => store.get('sessionSync')?.enabledProjects ?? [],
  isProjectEnabled: path => createEnabledProjectFilter()(path),
  warn: (message, error) => logger.main.warn(message, error),
});

/**
 * Decrypt mobile image attachments and convert to ChatAttachment format.
 * Each EncryptedAttachment has independently encrypted image data (AES-GCM).
 * Decrypts the data, writes to temp files via AttachmentService, returns ChatAttachments.
 */
export async function decryptMobileAttachments(
  encryptedAttachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    encryptedData: string;
    iv: string;
    size: number;
    width?: number;
    height?: number;
  }>,
  workspacePath: string,
  sessionId: string,
): Promise<import('@nimbalyst/runtime').ChatAttachment[]> {
  const key = state.encryptionKey;
  if (!key) {
    logger.main.warn('[SyncManager] No encryption key available for attachment decryption');
    return [];
  }

  const { AttachmentService } = await import('./AttachmentService');
  const stagingConfig = getAttachmentStagingConfig();
  const stagingDirectory = resolveWorkspaceAttachmentStagingDirectory(workspacePath);
  const attachmentService = new AttachmentService(workspacePath, stagingDirectory, stagingConfig.mode);

  const results: import('@nimbalyst/runtime').ChatAttachment[] = [];

  for (const att of encryptedAttachments) {
    try {
      // Decode base64 ciphertext and IV
      const ciphertext = Buffer.from(att.encryptedData, 'base64');
      const iv = Buffer.from(att.iv, 'base64');

      // Decrypt using AES-GCM (same format as iOS CryptoManager: ciphertext + tag concatenated)
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext,
      );

      const imageBuffer = Buffer.from(decrypted);
      const result = await attachmentService.saveAttachment(
        imageBuffer,
        att.filename,
        att.mimeType,
        sessionId,
      );

      if (result.success && result.attachment) {
        results.push(result.attachment);
      } else {
        logger.main.warn('[SyncManager] Failed to save decrypted attachment:', result.error);
      }
    } catch (err) {
      logger.main.error('[SyncManager] Failed to decrypt attachment:', att.id, err);
    }
  }

  return results;
}

// ============================================================================
// Network Reconnection
// ============================================================================

/**
 * Attempt to reconnect the sync connection when network becomes available.
 * Called by the main process when powerMonitor detects resume or network change.
 */
/**
 * Coalesce rapid-fire network-available events so we don't kick off overlapping
 * cascade reconnects. The broker debounces at its own layer too, but this is
 * a second line of defence that also prevents races when the `waitForIndexReady`
 * promise from a prior call is still in flight.
 */
let attemptReconnectInFlight = false;

/**
 * Retry parameters for the cascade. When `waitForIndexReady` times out -- the
 * network-available event fired but the index can't actually open a stable WS
 * yet -- we retry the full probe rather than cede to CollabV3's internal
 * exponential backoff, which grows to a 30s cap and leaves long gaps.
 *
 * `MAX_CASCADE_ATTEMPTS = 3` with 5s between attempts bounds the cascade at
 * ~15s of extra wall-clock before we give up and let the broker's next event
 * (or CollabV3's own backoff) take over.
 */
const WAIT_INDEX_READY_TIMEOUT_MS = 5000;
const CASCADE_RETRY_DELAY_MS = 5000;
const MAX_CASCADE_ATTEMPTS = 3;

export async function attemptReconnect(): Promise<void> {
  const provider = state.provider;
  if (!provider) {
    logger.main.debug('[SyncManager] Cannot attempt reconnect - provider not initialized');
    return;
  }

  if (!provider.reconnectIndex) {
    logger.main.debug('[SyncManager] Provider does not support reconnectIndex');
    return;
  }

  if (attemptReconnectInFlight) {
    logger.main.debug('[SyncManager] Reconnect cascade already in flight, skipping');
    return;
  }
  attemptReconnectInFlight = true;

  logger.main.info('[SyncManager] Network change detected, attempting to reconnect sync...');
  try {
    // 1+2. Probe + gate, with retries. Each attempt:
    //   a. reconnectIndex() -- cheapest, most-hardened reconnect path; same
    //      origin/TLS/JWT as real traffic, so success implies network usable.
    //   b. waitForIndexReady() -- gates on `open + 500ms stable`. Without this
    //      we've seen the WS `open` then error within 7ms on a stale network
    //      interface, which would cause every provider to churn through a bad
    //      reconnect.
    //
    // We retry on `waitForIndexReady` timeout because the broker's edge-triggered
    // sources (resume / unlock / online / isOnline edge) all fire in a ~20s
    // burst after wake. If every attempt in that burst fails (network is still
    // negotiating DHCP / auth), there's no more broker event coming -- CollabV3's
    // own backoff takes over with increasing delays up to 30s. Retrying inside
    // the cascade closes that gap.
    let ready = false;
    for (let attempt = 1; attempt <= MAX_CASCADE_ATTEMPTS; attempt++) {
      try {
        await provider.reconnectIndex();
      } catch (err) {
        logger.main.warn(`[SyncManager] reconnectIndex threw on attempt ${attempt}/${MAX_CASCADE_ATTEMPTS}:`, err);
      }

      if (!provider.waitForIndexReady) {
        ready = true;
        break;
      }

      try {
        await provider.waitForIndexReady(WAIT_INDEX_READY_TIMEOUT_MS);
        ready = true;
        break;
      } catch (err) {
        if (attempt < MAX_CASCADE_ATTEMPTS) {
          logger.main.info(`[SyncManager] Index not ready on attempt ${attempt}/${MAX_CASCADE_ATTEMPTS}, retrying in ${CASCADE_RETRY_DELAY_MS}ms`);
          await new Promise(resolve => setTimeout(resolve, CASCADE_RETRY_DELAY_MS));
        } else {
          logger.main.warn('[SyncManager] Index did not reach ready state after all retries; ceding to CollabV3 internal backoff:', err);
        }
      }
    }

    if (!ready) {
      return;
    }

    // A live socket clears transport errors, never a key mismatch: the gate
    // message stays until the index decrypts in full (GitHub #1117).
    updateSyncStatus({ connected: true, error: personalSyncGateMessage });
    logger.main.info('[SyncManager] Successfully reconnected after network change');
    await projectConfigSync.refresh();

    // 3. Fan out: all other sync providers get an immediate reconnect now that
    //    we know the network is good. TrackerSync lives in main; TeamSync and
    //    DocumentSync live in the renderer and get notified via IPC.
    try {
      reconnectAllTrackerSyncs();
    } catch (err) {
      logger.main.warn('[SyncManager] Failed to fan out to tracker syncs:', err);
    }

    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('sync:network-available');
        }
      }
    } catch (err) {
      logger.main.warn('[SyncManager] Failed to broadcast sync:network-available:', err);
    }

    // 4. Trigger incremental sync to catch up on any missed changes
    setTimeout(() => {
      triggerIncrementalSync().catch(err => {
        logger.main.warn('[SyncManager] Failed to sync after reconnect:', err);
      });
    }, 1000);
  } catch (error) {
    logger.main.warn('[SyncManager] Failed to reconnect after network change:', error);
  } finally {
    attemptReconnectInFlight = false;
  }
}

// Reconnect also sends the durable vault tombstone if a clear occurred offline.
subscribeProviderCredentialChanges(() => { void syncSettingsToMobile(); /* Credential edits must not wait for network sync. */ });
