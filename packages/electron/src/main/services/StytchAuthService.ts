/**
 * StytchAuthService - Manages user authentication via Stytch B2B platform.
 *
 * This service handles:
 * - Google OAuth sign-in/sign-up (via browser redirect to collabv3 server)
 * - Email magic link authentication (via collabv3 server)
 * - Session token/JWT management
 * - Organization context (B2B org_id)
 *
 * Security architecture:
 * - All authentication flows go through the collabv3 Cloudflare Worker
 * - The desktop app NEVER has access to the Stytch secret key
 * - OAuth flow: opens browser -> collabv3/auth/login/google -> Stytch -> collabv3/auth/callback -> nimbalyst:// deep link
 * - Magic links: collabv3 sends email (has secret key), callback to collabv3, then deep link to app
 * - Session tokens received via deep link are stored securely using Electron's safeStorage
 * - JWT is used for sync server authentication, includes org context for B2B
 *
 * Deep link format: nimbalyst://auth/callback?session_token=...&session_jwt=...&user_id=...&email=...&org_id=...
 */

import { safeStorage, shell, net } from 'electron';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { STYTCH_CONFIG, asPersonalJwt, asPersonalMemberId, type PersonalJwt, type PersonalMemberId } from '@nimbalyst/runtime';
import { getSessionSyncConfig, setSessionSyncConfig } from '../utils/store';
import { AnalyticsService } from './analytics/AnalyticsService';
import { reconcilePersonalUserId } from './auth/personalUserIdReconcile';
import { resetSilentMigrationScanState } from './SilentTeamEncryptionMigration';

// Stytch types
interface StytchUser {
  user_id: string;
  emails: Array<{
    email_id: string;
    email: string;
    verified: boolean;
  }>;
  name?: {
    first_name?: string;
    last_name?: string;
  };
  created_at: string;
  status: 'active' | 'pending';
}

interface StytchSession {
  session_id: string;
  user_id: string;
  started_at: string;
  last_accessed_at: string;
  expires_at: string;
  authentication_factors: Array<{
    type: string;
    delivery_method: string;
    last_authenticated_at: string;
  }>;
}

interface StytchAuthState {
  isAuthenticated: boolean;
  user: StytchUser | null;
  session: StytchSession | null;
  sessionToken: string | null;
  sessionJwt: string | null;
  /** Organization ID from B2B auth (may change on session exchange). */
  orgId: string | null;
  /** Personal org ID -- set once on initial auth, never overwritten by session exchanges.
   *  Used for session sync room IDs so they stay stable across org switches. */
  personalOrgId: string | null;
  /** Personal org member ID -- set once on initial auth, never overwritten by session exchanges.
   *  In Stytch B2B, each org has its own member record. After a team session exchange,
   *  the JWT sub claim changes to the team org member ID. This field preserves the
   *  personal org member ID so sync room IDs and encryption keys stay stable. */
  personalUserId: string | null;
  /** Personal-org-scoped JWT -- separate from sessionJwt which may be team-scoped.
   *  Used exclusively for session sync (IndexRoom, session rooms) where the server
   *  validates JWT sub === room userId. */
  personalSessionJwt: string | null;
}

interface StoredStytchCredentials {
  sessionToken: string;
  sessionJwt: string;
  userId: string;
  email?: string;
  expiresAt: number;
  /** Organization ID from B2B auth (may change on session exchange) */
  orgId?: string;
  /** Personal org ID -- set once on initial auth, stable across session exchanges */
  personalOrgId?: string;
  /** Personal org member ID -- set once on initial auth, stable across session exchanges */
  personalUserId?: string;
}

/**
 * Multi-account storage format (v3).
 * Each account is keyed by personalOrgId.
 */
interface StoredAccountsData {
  version: 3;
  syncAccountId: string;
  accounts: StoredStytchCredentials[];
}

interface LegacyStoredAccountsData {
  version: 2;
  primaryAccountId?: string;
  accounts?: StoredStytchCredentials[];
}

/**
 * Public account info exposed to the renderer (no JWTs or tokens).
 */
export interface AccountInfo {
  personalOrgId: string;
  personalUserId: string | null;
  email: string | null;
  userName?: string;
  isSyncAccount: boolean;
  sessionStatus: 'active' | 'expired';
}

export function getAccountSessionStatus(
  expiresAt: number,
  now: number = Date.now(),
): AccountInfo['sessionStatus'] {
  return expiresAt > now ? 'active' : 'expired';
}


// Stytch configuration - PUBLIC TOKEN ONLY, no secret key!
interface StytchConfig {
  projectId: string;
  publicToken: string;
  apiBase: string; // 'https://test.stytch.com/v1' for test, 'https://api.stytch.com/v1' for live
}

// File names for persistent storage
const STYTCH_CREDENTIALS_FILE = 'stytch-credentials.enc'; // v1 (single account)
const STYTCH_ACCOUNTS_FILE = 'stytch-accounts.enc'; // v2 (multi-account)

// Singleton state -- represents the account selected for personal/mobile sync.
// All existing getters (getAuthState, getSessionJwt, etc.) read from this.
let authState: StytchAuthState = {
  isAuthenticated: false,
  user: null,
  session: null,
  sessionToken: null,
  sessionJwt: null,
  orgId: null,
  personalOrgId: null,
  personalUserId: null,
  personalSessionJwt: null,
};

// Multi-account state -- all accounts keyed by personalOrgId.
const accounts = new Map<string, StoredStytchCredentials>();
let syncAccountId: string | null = null;

let stytchConfig: StytchConfig | null = null;

// Event listeners for auth state changes
type AuthStateListener = (state: StytchAuthState) => void;
const authStateListeners = new Set<AuthStateListener>();

/**
 * Get the path to the encrypted credentials file (v1 single-account).
 */
function getCredentialsPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, STYTCH_CREDENTIALS_FILE);
}

/**
 * Get the path to the multi-account credentials file (v2).
 */
function getAccountsPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, STYTCH_ACCOUNTS_FILE);
}


/**
 * Check if safeStorage is available for encryption.
 */
function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Save Stytch credentials securely.
 */
function saveStytchCredentials(credentials: StoredStytchCredentials): void {
  const credentialsPath = getCredentialsPath();
  const jsonData = JSON.stringify(credentials);

  if (isSafeStorageAvailable()) {
    const encrypted = safeStorage.encryptString(jsonData);
    fs.writeFileSync(credentialsPath, encrypted);
    // logger.main.info('[StytchAuthService] Credentials saved with safeStorage encryption');
  } else {
    logger.main.warn('[StytchAuthService] safeStorage not available - saving credentials without encryption');
    fs.writeFileSync(credentialsPath, jsonData, 'utf8');
  }
}

/**
 * Load Stytch credentials from secure storage.
 */
function loadStytchCredentials(): StoredStytchCredentials | null {
  const credentialsPath = getCredentialsPath();

  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    const fileData = fs.readFileSync(credentialsPath);

    if (isSafeStorageAvailable()) {
      const decrypted = safeStorage.decryptString(fileData);
      return JSON.parse(decrypted);
    } else {
      const jsonData = fileData.toString('utf8');
      return JSON.parse(jsonData);
    }
  } catch (error) {
    logger.main.error('[StytchAuthService] Failed to load credentials:', error);
    return null;
  }
}

/**
 * Clear stored Stytch credentials.
 */
function clearStytchCredentials(): void {
  const credentialsPath = getCredentialsPath();
  if (fs.existsSync(credentialsPath)) {
    fs.unlinkSync(credentialsPath);
    logger.main.info('[StytchAuthService] Credentials cleared');
  }
}

// ============================================================================
// Multi-Account Storage (v3)
// ============================================================================

/**
 * Save all accounts to the multi-account file.
 */
function saveAllAccounts(): void {
  if (accounts.size === 0) {
    // No accounts -- remove the file
    const accountsPath = getAccountsPath();
    if (fs.existsSync(accountsPath)) {
      fs.unlinkSync(accountsPath);
    }
    return;
  }

  const data: StoredAccountsData = {
    version: 3,
    syncAccountId: syncAccountId || '',
    accounts: Array.from(accounts.values()),
  };

  const accountsPath = getAccountsPath();
  const jsonData = JSON.stringify(data);

  if (isSafeStorageAvailable()) {
    const encrypted = safeStorage.encryptString(jsonData);
    fs.writeFileSync(accountsPath, encrypted);
  } else {
    logger.main.warn('[StytchAuthService] safeStorage not available - saving accounts without encryption');
    fs.writeFileSync(accountsPath, jsonData, 'utf8');
  }
}

/**
 * Load accounts from storage.
 * Handles migration from v1 (single account) and the v2 primary-account key.
 * Returns true if any accounts were loaded.
 */
function loadAllAccounts(): boolean {
  // Try the multi-account formats first.
  const accountsPath = getAccountsPath();
  if (fs.existsSync(accountsPath)) {
    try {
      const fileData = fs.readFileSync(accountsPath);
      let jsonData: string;
      if (isSafeStorageAvailable()) {
        jsonData = safeStorage.decryptString(fileData);
      } else {
        jsonData = fileData.toString('utf8');
      }
      const data = JSON.parse(jsonData) as StoredAccountsData | LegacyStoredAccountsData;
      if ((data.version === 2 || data.version === 3) && Array.isArray(data.accounts)) {
        accounts.clear();
        for (const acct of data.accounts) {
          if (acct.personalOrgId) {
            accounts.set(acct.personalOrgId, acct);
          }
        }
        const persistedSyncAccountId = data.version === 3
          ? data.syncAccountId
          : data.primaryAccountId;
        syncAccountId = persistedSyncAccountId && accounts.has(persistedSyncAccountId)
          ? persistedSyncAccountId
          : accounts.keys().next().value ?? null;
        if (data.version === 2) {
          saveAllAccounts();
        }
        logger.main.info(`[StytchAuthService] Loaded ${accounts.size} accounts (v${data.version} format)`);
        return accounts.size > 0;
      }
    } catch (error) {
      logger.main.error('[StytchAuthService] Failed to load v2 accounts:', error);
    }
  }

  // Migrate from v1 single-account format
  const v1Creds = loadStytchCredentials();
  if (v1Creds && v1Creds.personalOrgId) {
    accounts.clear();
    accounts.set(v1Creds.personalOrgId, v1Creds);
    syncAccountId = v1Creds.personalOrgId;

    // Save in the current multi-account format.
    saveAllAccounts();

    logger.main.info('[StytchAuthService] Migrated v1 credentials to multi-account format');
    return true;
  }

  return false;
}

/**
 * Update a specific account's credentials in the map and persist.
 */
function updateAccountCredentials(personalOrgId: string, update: Partial<StoredStytchCredentials>): void {
  const existing = accounts.get(personalOrgId);
  if (existing) {
    accounts.set(personalOrgId, { ...existing, ...update });
    saveAllAccounts();
  }
}

/**
 * Notify all listeners of auth state change.
 */
function notifyAuthStateChange(): void {
  const state = { ...authState };
  authStateListeners.forEach(listener => {
    try {
      listener(state);
    } catch (error) {
      logger.main.error('[StytchAuthService] Auth state listener error:', error);
    }
  });
}

/**
 * Update auth state and notify listeners.
 */
function updateAuthState(update: Partial<StytchAuthState>): void {
  authState = { ...authState, ...update };
  notifyAuthStateChange();
}


// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the Stytch auth service.
 * Call this during app startup.
 *
 * IMPORTANT: Only pass the public token, never the secret key!
 */
export function initializeStytchAuth(config: StytchConfig): void {
  stytchConfig = config;

  logger.main.info('[StytchAuthService] Initialized with project:', config.projectId);

  // Load multi-account data, migrating older persisted formats if needed.
  loadAllAccounts();

  // Restore the sync account into the singleton authState.
  const savedCredentials = syncAccountId ? accounts.get(syncAccountId) ?? null : loadStytchCredentials();
  if (savedCredentials && savedCredentials.expiresAt > Date.now() && savedCredentials.orgId) {
    // Validate JWT format (must be 3 parts separated by dots)
    const hasValidJwt = savedCredentials.sessionJwt && savedCredentials.sessionJwt.split('.').length === 3;

    // On restore, personalSessionJwt is only valid if we're still in the personal org.
    // If a team exchange happened, personalSessionJwt will be set when SyncManager calls
    // resolvePersonalUserId() or refreshPersonalSession().
    const isInPersonalOrg = !savedCredentials.orgId || !savedCredentials.personalOrgId
      || savedCredentials.orgId === savedCredentials.personalOrgId;
    const restoredJwt = hasValidJwt ? savedCredentials.sessionJwt : null;

    // Use updateAuthState to notify listeners (like RepositoryManager) of the restored session
    updateAuthState({
      isAuthenticated: true,
      user: savedCredentials.userId ? {
        user_id: savedCredentials.userId,
        emails: savedCredentials.email ? [{ email_id: '', email: savedCredentials.email, verified: true }] : [],
        created_at: new Date().toISOString(),
        status: 'active',
      } : null,
      session: null,
      sessionToken: savedCredentials.sessionToken,
      sessionJwt: restoredJwt,
      orgId: savedCredentials.orgId,
      personalOrgId: savedCredentials.personalOrgId || null,
      personalUserId: savedCredentials.personalUserId || null,
      personalSessionJwt: isInPersonalOrg ? restoredJwt : null,
    });
    // One-time migration: if personalOrgId is missing (pre-existing creds from before
    // this field was added), persist the current orgId as personalOrgId.
    // At the time those creds were saved, the orgId WAS the personal org.
    let needsSave = false;
    if (!savedCredentials.personalOrgId && savedCredentials.orgId) {
      savedCredentials.personalOrgId = savedCredentials.orgId;
      authState.personalOrgId = savedCredentials.orgId;
      needsSave = true;
      logger.main.info('[StytchAuthService] Migrated orgId to personalOrgId:', savedCredentials.orgId);
    }
    // One-time migration: if personalUserId is missing, try to persist the current userId.
    // BUT: if orgId !== personalOrgId, a team session exchange already happened and the
    // stored userId is the TEAM member ID (not personal). In that case, SyncManager will
    // call resolvePersonalUserId() during async init to exchange to the personal org
    // and extract the correct member ID.
    // Workstream A1's explicit account -> team-member binding makes this ambient-userId
    // repair redundant for team access. Keep it for legacy credential recovery in this pass.
    if (!savedCredentials.personalUserId && savedCredentials.userId) {
      if (!savedCredentials.orgId || !savedCredentials.personalOrgId || savedCredentials.orgId === savedCredentials.personalOrgId) {
        // No team exchange happened yet -- userId IS the personal member ID
        savedCredentials.personalUserId = savedCredentials.userId;
        authState.personalUserId = savedCredentials.userId;
        needsSave = true;
        logger.main.info('[StytchAuthService] Migrated userId to personalUserId:', savedCredentials.userId);
      } else {
        logger.main.warn('[StytchAuthService] personalUserId missing and orgId differs from personalOrgId.',
          'Will resolve via session exchange to personal org during sync init.');
      }
    }
    if (needsSave) {
      saveStytchCredentials(savedCredentials);
    }
    logger.main.info('[StytchAuthService] Restored session for user:', savedCredentials.userId, savedCredentials.email, {
      hasValidJwt,
      orgId: savedCredentials.orgId,
      personalOrgId: authState.personalOrgId,
    });

    // If JWT is missing or invalid, try to refresh the session
    if (!hasValidJwt) {
      logger.main.info('[StytchAuthService] Stored session has no valid JWT - will attempt refresh');
      // Schedule refresh after initialization completes (don't block startup)
      setImmediate(async () => {
        try {
          const refreshed = await refreshSession();
          if (refreshed) {
            logger.main.info('[StytchAuthService] Session refreshed on startup - JWT now available');
          } else {
            logger.main.warn('[StytchAuthService] Session refresh failed on startup - preserving account for re-auth');
            markAccountSessionExpired(savedCredentials.personalOrgId ?? syncAccountId);
          }
        } catch (error) {
          if ((error as any)?.isNetworkError) {
            logger.main.warn('[StytchAuthService] Network error during startup refresh - keeping credentials');
          } else {
            logger.main.error('[StytchAuthService] Unexpected error during startup refresh:', error);
          }
        }
      });
    } else {
      // JWT looks valid locally, but verify it's still alive server-side
      setImmediate(async () => {
        try {
          const refreshed = await refreshSession();
          if (!refreshed) {
            logger.main.warn('[StytchAuthService] Session dead server-side on startup - preserving account for re-auth');
            markAccountSessionExpired(savedCredentials.personalOrgId ?? syncAccountId);
          }
        } catch (error) {
          if ((error as any)?.isNetworkError) {
            logger.main.warn('[StytchAuthService] Network error during startup verification - keeping credentials');
          } else {
            logger.main.error('[StytchAuthService] Unexpected error during startup verification:', error);
          }
        }
      });
    }
  } else if (savedCredentials) {
    const reason = !savedCredentials.orgId ? 'missing orgId (pre-B2B credential)' : 'expired';
    if (savedCredentials.orgId) {
      logger.main.info('[StytchAuthService] Saved session expired; preserving account for re-auth');
      markAccountSessionExpired(savedCredentials.personalOrgId ?? syncAccountId);
    } else {
      logger.main.info(`[StytchAuthService] Saved session invalid: ${reason}, clearing legacy credentials`);
      clearStytchCredentials();
    }
  }
}

/**
 * Handle auth callback from deep link (nimbalyst://auth/callback?...)
 * Called when user completes auth flow and is redirected back to the app.
 */
export async function handleAuthCallback(params: {
  sessionToken: string;
  sessionJwt?: string;
  userId?: string;
  email?: string;
  expiresAt?: string;
  orgId?: string;
}): Promise<void> {
  const { sessionToken, sessionJwt, userId, email, expiresAt, orgId } = params;

  // Calculate expiry time
  let expiresAtMs = Date.now() + (7 * 24 * 60 * 60 * 1000); // Default: 1 week
  if (expiresAt) {
    try {
      expiresAtMs = new Date(expiresAt).getTime();
    } catch {
      // Use default
    }
  }

  // Validate JWT format (must be 3 parts separated by dots)
  const validatedJwt = sessionJwt && sessionJwt.split('.').length === 3 ? sessionJwt : null;
  if (sessionJwt && !validatedJwt) {
    logger.main.warn('[StytchAuthService] Auth callback received invalid JWT format');
  }

  // Determine the personalOrgId for this callback.
  // On initial auth, orgId IS the personal org. On re-auth, preserve existing value.
  const incomingPersonalOrgId = orgId || null;

  // Only treat this as an additional account if the sync account is still valid.
  // Otherwise the new login replaces the expired sync account.
  const syncAccountIsActive = syncAccountId !== null && authState.isAuthenticated
    && accounts.has(syncAccountId)
    && (accounts.get(syncAccountId)!.expiresAt > Date.now());
  const isAdditionalAccount = syncAccountIsActive && incomingPersonalOrgId !== null
    && incomingPersonalOrgId !== syncAccountId;

  // Build credentials to persist
  const credsToSave: StoredStytchCredentials = {
    sessionToken,
    sessionJwt: validatedJwt || '',
    userId: userId || '',
    email: email || '',
    expiresAt: expiresAtMs,
    orgId,
    personalOrgId: incomingPersonalOrgId || undefined,
    personalUserId: userId || undefined,
  };

  if (isAdditionalAccount) {
    // Additional accounts do not change the singleton personal-sync lane.
    accounts.set(incomingPersonalOrgId!, credsToSave);
    saveAllAccounts();
    logger.main.info('[StytchAuthService] Added account:', email, incomingPersonalOrgId);
  } else {
    // Sync account: first sign-in, re-auth, or replacement of an expired account.
    // When the incoming org differs from the stored sync account,
    // use the incoming values instead of preserving stale state.
    const isReplacingSyncAccount = syncAccountId !== null && incomingPersonalOrgId !== syncAccountId;
    if (isReplacingSyncAccount) {
      logger.main.info('[StytchAuthService] Replacing expired sync account:', syncAccountId, '->', incomingPersonalOrgId);
    }
    const personalOrgId = isReplacingSyncAccount ? incomingPersonalOrgId : (authState.personalOrgId || incomingPersonalOrgId);
    const personalUserId = isReplacingSyncAccount ? (userId || null) : (authState.personalUserId || userId || null);

    // Update singleton auth state
    updateAuthState({
      isAuthenticated: true,
      user: userId ? {
        user_id: userId,
        emails: email ? [{ email_id: '', email, verified: true }] : [],
        created_at: new Date().toISOString(),
        status: 'active',
      } : null,
      session: null,
      sessionToken,
      sessionJwt: validatedJwt,
      orgId: orgId || null,
      personalOrgId,
      personalUserId,
      personalSessionJwt: validatedJwt,
    });

    // Update credentials with resolved personalOrgId/userId
    credsToSave.personalOrgId = personalOrgId || undefined;
    credsToSave.personalUserId = personalUserId || undefined;

    // Save legacy file
    saveStytchCredentials(credsToSave);

    // Update multi-account store
    if (personalOrgId) {
      accounts.set(personalOrgId, credsToSave);
      if (!syncAccountId || isReplacingSyncAccount) {
        syncAccountId = personalOrgId;
      }
      saveAllAccounts();
    }
  }

  // Bootstrap sync config if it doesn't exist yet.
  // Teams and sync operations need this config to exist, even if sync isn't enabled.
  const existingConfig = getSessionSyncConfig();
  if (!existingConfig) {
    setSessionSyncConfig({
      enabled: false,
      serverUrl: '',
      enabledProjects: [],
    });
    logger.main.info('[StytchAuthService] Created default sync config after auth');
  }

  // Track auth callback completion (authoritative sign-in event from deep link)
  AnalyticsService.getInstance().sendEvent('sync_auth_callback_completed');

  logger.main.info('[StytchAuthService] Auth callback processed:', {
    userId,
    email,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
}

/**
 * Subscribe to auth state changes.
 * Returns an unsubscribe function.
 */
export function onAuthStateChange(listener: AuthStateListener): () => void {
  authStateListeners.add(listener);
  // Immediately notify with current state
  listener({ ...authState });
  return () => authStateListeners.delete(listener);
}

/**
 * Get the current authentication state.
 */
export function getAuthState(): StytchAuthState {
  return { ...authState };
}

/**
 * Check if the user is authenticated.
 */
export function isAuthenticated(): boolean {
  return authState.isAuthenticated;
}

/**
 * Get the current user's Stytch user ID.
 */
export function getStytchUserId(): string | null {
  return authState.user?.user_id || null;
}

/**
 * Get the current user's email address.
 */
export function getUserEmail(): string | null {
  return authState.user?.emails?.[0]?.email || null;
}

/**
 * Get the current organization ID (may change on session exchange to team orgs).
 */
export function getOrgId(): string | null {
  return authState.orgId;
}

/**
 * Get the personal organization ID (stable across session exchanges).
 * Set once during initial auth, never overwritten by team session exchanges.
 * Used for session sync room IDs so they stay stable regardless of which org
 * the JWT is currently scoped to.
 */
export function getPersonalOrgId(): string | null {
  return authState.personalOrgId;
}

/**
 * Get the personal org member ID (stable across session exchanges).
 * In Stytch B2B, each org has its own member record with a unique member ID.
 * After a team session exchange, the JWT sub claim and authState.user.user_id
 * change to the team org's member ID. This function returns the original
 * personal org member ID so sync room IDs and encryption keys stay consistent.
 */
export function getPersonalUserId(): PersonalMemberId | null {
  return authState.personalUserId ? asPersonalMemberId(authState.personalUserId) : null;
}

/**
 * Resolve the personal org member ID by exchanging the session to the personal org.
 * This is needed when personalUserId is missing because a team session exchange
 * corrupted the stored userId. Does a session exchange to the personal org,
 * extracts the member ID from the resulting JWT, and persists it.
 *
 * Returns the personal member ID, or null if resolution fails.
 */
export async function resolvePersonalUserId(serverUrl: string): Promise<PersonalMemberId | null> {
  // The personal-org exchange below is authoritative. We intentionally do NOT
  // early-return on a cached personalUserId: a stale cached value (e.g. seeded
  // from a non-personal sub by the creds migration) would otherwise never be
  // corrected, permanently refusing the personal index room. See NIM-859. When
  // the exchange can't run (offline / missing token) we fall back to the cached
  // value so offline behavior is unchanged.
  const cached: PersonalMemberId | null = authState.personalUserId
    ? asPersonalMemberId(authState.personalUserId)
    : null;

  const personalOrgId = authState.personalOrgId;
  if (!personalOrgId) {
    logger.main.warn('[StytchAuthService] Cannot resolve personalUserId: no personalOrgId');
    return cached;
  }

  const sessionToken = authState.sessionToken;
  if (!sessionToken) {
    logger.main.warn('[StytchAuthService] Cannot resolve personalUserId: no session token');
    return cached;
  }

  const jwt = authState.sessionJwt;
  if (!jwt) {
    logger.main.warn('[StytchAuthService] Cannot resolve personalUserId: no JWT');
    return cached;
  }

  try {
    // Convert ws(s):// to http(s):// for fetch
    const httpUrl = serverUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    logger.main.info('[StytchAuthService] Resolving personalUserId via session exchange to personal org:', personalOrgId);

    const response = await net.fetch(`${httpUrl}/api/teams/${personalOrgId}/switch`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionToken }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
      logger.main.error('[StytchAuthService] Failed to resolve personalUserId:', errData.error || response.status);
      return cached;
    }

    const data = await response.json() as {
      sessionJwt: string;
      sessionToken: string;
    };

    if (!data.sessionJwt) {
      logger.main.error('[StytchAuthService] Session exchange returned no JWT');
      return cached;
    }

    // Extract member ID from the personal-org-scoped JWT
    const parts = data.sessionJwt.split('.');
    if (parts.length !== 3) {
      logger.main.error('[StytchAuthService] Invalid JWT format from session exchange');
      return cached;
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { sub?: string };
    // The exchange sub is authoritative -- reconcile against (and correct) any
    // stale cached value. See NIM-859.
    const { personalUserId: resolvedUserId, changed } = reconcilePersonalUserId(cached, payload.sub ?? null);
    if (!resolvedUserId) {
      logger.main.error('[StytchAuthService] JWT sub claim missing from session exchange response');
      return cached;
    }
    if (changed) {
      logger.main.info('[StytchAuthService] Corrected personalUserId via personal-org exchange:', cached, '->', resolvedUserId);
    }

    // Persist the resolved personal member ID and personal JWT
    authState = { ...authState, personalUserId: resolvedUserId, personalSessionJwt: data.sessionJwt };
    const creds = loadStytchCredentials();
    if (creds) {
      saveStytchCredentials({ ...creds, personalUserId: resolvedUserId });
    }
    // Update accounts map
    if (personalOrgId) {
      updateAccountCredentials(personalOrgId, { personalUserId: resolvedUserId });
    }

    // The session exchange also updated the session token -- persist that too
    // so future refreshes work. But do NOT update personalOrgId from the
    // exchange response.
    if (data.sessionToken) {
      updateSessionToken(data.sessionToken);
    }

    logger.main.info('[StytchAuthService] Resolved personalUserId:', resolvedUserId, 'and stored personal JWT');
    return asPersonalMemberId(resolvedUserId);
  } catch (error) {
    logger.main.error('[StytchAuthService] Error resolving personalUserId:', error);
    return cached;
  }
}

/**
 * Get the current session JWT for server authentication.
 * After a team session exchange, this may be a team-org-scoped JWT.
 */
export function getSessionJwt(): string | null {
  return authState.sessionJwt;
}

/**
 * Get the session JWT for a specific account by personalOrgId.
 * Falls back to the default getSessionJwt() if the account is the primary
 * or not found.
 */
export function getSessionJwtForAccount(personalOrgId: string): string | null {
  // The singleton JWT belongs to the sync account.
  if (personalOrgId === syncAccountId) {
    return authState.sessionJwt;
  }
  const creds = accounts.get(personalOrgId);
  return creds?.sessionJwt ?? null;
}

/**
 * Get the session token for a specific account by personalOrgId.
 * Used for org-scoped JWT exchanges under a non-sync account.
 */
export function getSessionTokenForAccount(personalOrgId: string): string | null {
  if (personalOrgId === syncAccountId) {
    return authState.sessionToken;
  }
  const creds = accounts.get(personalOrgId);
  return creds?.sessionToken ?? null;
}

/**
 * Get all signed-in accounts (public info only, no JWTs or tokens).
 * Used by the renderer to display account list.
 */
export function getAccounts(): AccountInfo[] {
  const result: AccountInfo[] = [];
  for (const [orgId, creds] of accounts) {
    result.push({
      personalOrgId: orgId,
      personalUserId: creds.personalUserId || null,
      email: creds.email || null,
      isSyncAccount: orgId === syncAccountId,
      sessionStatus: getAccountSessionStatus(creds.expiresAt),
    });
  }
  return result;
}

function markAccountSessionExpired(personalOrgId: string | null | undefined): void {
  if (!personalOrgId) return;
  const credentials = accounts.get(personalOrgId);
  if (!credentials) return;
  const expiredCredentials = { ...credentials, expiresAt: 0 };
  accounts.set(personalOrgId, expiredCredentials);
  saveAllAccounts();
  if (personalOrgId === syncAccountId) {
    saveStytchCredentials(expiredCredentials);
    updateAuthState({
      isAuthenticated: false,
      user: credentials.userId ? {
        user_id: credentials.userId,
        emails: credentials.email
          ? [{ email_id: '', email: credentials.email, verified: true }]
          : [],
        created_at: new Date().toISOString(),
        status: 'active',
      } : authState.user,
    });
  } else {
    notifyAuthStateChange();
  }
}

/** The signed-in account selected for personal sync and mobile pairing. */
export function getSyncAccount(): AccountInfo | null {
  if (!syncAccountId) return null;
  return getAccounts().find((account) => account.personalOrgId === syncAccountId) ?? null;
}

/**
 * Select the account used by the personal/mobile sync lane.
 * Team collaboration does not consult this selection; it resolves through the
 * workspace org's explicit account binding in TeamService.
 */
export function setSyncAccount(personalOrgId: string): boolean {
  const credentials = accounts.get(personalOrgId);
  if (!credentials) return false;
  if (syncAccountId === personalOrgId) return true;

  syncAccountId = personalOrgId;
  const isInPersonalOrg = !credentials.orgId || !credentials.personalOrgId
    || credentials.orgId === credentials.personalOrgId;
  updateAuthState({
    isAuthenticated: credentials.expiresAt > Date.now(),
    user: credentials.userId ? {
      user_id: credentials.userId,
      emails: credentials.email
        ? [{ email_id: '', email: credentials.email, verified: true }]
        : [],
      created_at: new Date().toISOString(),
      status: 'active',
    } : null,
    session: null,
    sessionToken: credentials.sessionToken,
    sessionJwt: credentials.sessionJwt || null,
    orgId: credentials.orgId || null,
    personalOrgId: credentials.personalOrgId || null,
    personalUserId: credentials.personalUserId || null,
    personalSessionJwt: isInPersonalOrg ? (credentials.sessionJwt || null) : null,
  });
  saveStytchCredentials(credentials);
  saveAllAccounts();
  logger.main.info('[StytchAuthService] Sync account selected:', personalOrgId);
  return true;
}

/**
 * Get the personal-org-scoped JWT for session sync.
 * This JWT's sub claim matches personalUserId, which the server uses
 * for session/index room routing. Falls back to sessionJwt if we
 * haven't done a team session exchange (personal org is the default).
 */
export function getPersonalSessionJwt(): PersonalJwt | null {
  const jwt = authState.personalSessionJwt || authState.sessionJwt;
  return jwt ? asPersonalJwt(jwt) : null;
}

/** Personal/mobile-sync JWT for an explicit signed-in account. */
export function getPersonalSessionJwtForAccount(personalOrgId: string): PersonalJwt | null {
  if (personalOrgId === syncAccountId) return getPersonalSessionJwt();
  const jwt = accounts.get(personalOrgId)?.sessionJwt;
  return jwt ? asPersonalJwt(jwt) : null;
}

/**
 * Refresh the personal-org-scoped JWT via session exchange.
 * Called by SyncManager to keep the personal JWT fresh for session sync.
 */
let inflightPersonalSessionRefresh: Promise<boolean> | null = null;

export function refreshPersonalSession(serverUrl: string): Promise<boolean> {
  if (inflightPersonalSessionRefresh) {
    return inflightPersonalSessionRefresh;
  }
  inflightPersonalSessionRefresh = doRefreshPersonalSession(serverUrl).finally(() => {
    inflightPersonalSessionRefresh = null;
  });
  return inflightPersonalSessionRefresh;
}

async function doRefreshPersonalSession(serverUrl: string): Promise<boolean> {
  const personalOrgId = authState.personalOrgId;
  if (!personalOrgId) {
    logger.main.warn('[StytchAuthService] Cannot refresh personal session: no personalOrgId');
    return false;
  }

  if (!authState.sessionToken) {
    logger.main.warn('[StytchAuthService] Cannot refresh personal session: no session token');
    return false;
  }

  // If we're already in the personal org (no team exchange happened),
  // just do a normal refresh -- but verify the JWT sub matches personalUserId.
  // The session token may have been silently exchanged to a team org, in which
  // case Stytch returns a team-scoped JWT even though authState.orgId appears
  // to be the personal org. If the sub doesn't match, fall through to the
  // session exchange path to get a genuine personal-org JWT.
  if (!authState.orgId || authState.orgId === personalOrgId) {
    let result: boolean;
    try {
      result = await refreshSession(serverUrl);
    } catch (error) {
      if ((error as any)?.isNetworkError) {
        logger.main.warn('[StytchAuthService] Network error refreshing personal session - will retry later');
      }
      return false;
    }
    if (result && authState.sessionJwt) {
      // Verify the JWT sub matches personalUserId
      try {
        const parts = authState.sessionJwt.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { sub?: string };
          if (payload.sub && authState.personalUserId && payload.sub !== authState.personalUserId) {
            // JWT sub is a team member ID, not personal -- the session was exchanged
            // to a team org at some point. Fall through to the exchange path.
            logger.main.warn('[StytchAuthService] Refreshed JWT sub mismatch:',
              payload.sub, '!==', authState.personalUserId,
              '-- session was team-exchanged, falling through to personal org exchange');
          } else {
            authState = { ...authState, personalSessionJwt: authState.sessionJwt };
            return true;
          }
        }
      } catch {
        // Parse failed -- use the JWT as-is
        authState = { ...authState, personalSessionJwt: authState.sessionJwt };
        return result;
      }
    } else if (result) {
      authState = { ...authState, personalSessionJwt: authState.sessionJwt };
      return result;
    } else {
      return false;
    }
  }

  // We're in a team org (or the refresh above detected a team-scoped JWT)
  // -- do a session exchange to personal org for a fresh JWT.
  // The team JWT (authState.sessionJwt) has a short lifetime (5 min from Stytch),
  // so refresh it first to ensure the Authorization header is valid.
  try {
    await refreshSession(serverUrl);
    const httpUrl = serverUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const jwt = authState.sessionJwt;
    // /auth/refresh rotates the session token. The personal-org exchange must
    // use the token returned by that refresh, not the token captured before it.
    const sessionToken = authState.sessionToken;
    if (!jwt || !sessionToken) return false;

    const response = await net.fetch(`${httpUrl}/api/teams/${personalOrgId}/switch`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionToken }),
    });

    if (!response.ok) {
      logger.main.warn('[StytchAuthService] Personal session refresh failed:', response.status);
      return false;
    }

    const data = await response.json() as {
      sessionJwt: string;
      sessionToken: string;
    };

    if (!data.sessionJwt || data.sessionJwt.split('.').length !== 3) {
      logger.main.error('[StytchAuthService] Personal session refresh returned invalid JWT');
      return false;
    }

    // The personal-org exchange sub is authoritative. Correct a stale
    // personalUserId here too -- refresh historically rewrote only the JWT and
    // never the id, leaving the personal index room permanently refused. See
    // NIM-859.
    try {
      const jwtParts = data.sessionJwt.split('.');
      const payload = jwtParts.length === 3
        ? (JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString()) as { sub?: string })
        : {};
      const { personalUserId: resolvedUserId, changed } = reconcilePersonalUserId(
        authState.personalUserId ?? null,
        payload.sub ?? null,
      );
      if (changed && resolvedUserId) {
        logger.main.info('[StytchAuthService] Corrected personalUserId during personal session refresh:',
          authState.personalUserId ?? null, '->', resolvedUserId);
        authState = { ...authState, personalUserId: resolvedUserId, personalSessionJwt: data.sessionJwt };
        const creds = loadStytchCredentials();
        if (creds) {
          saveStytchCredentials({ ...creds, personalUserId: resolvedUserId });
        }
        if (personalOrgId) {
          updateAccountCredentials(personalOrgId, { personalUserId: resolvedUserId });
        }
      } else {
        authState = { ...authState, personalSessionJwt: data.sessionJwt };
      }
    } catch {
      authState = { ...authState, personalSessionJwt: data.sessionJwt };
    }

    // Update the session token (shared across orgs)
    if (data.sessionToken) {
      updateSessionToken(data.sessionToken);
    }

    return true;
  } catch (error) {
    logger.main.error('[StytchAuthService] Error refreshing personal session:', error);
    return false;
  }
}

/** Refresh and return a personal-org JWT for an explicit signed-in account. */
export async function refreshPersonalSessionForAccount(
  personalOrgId: string,
): Promise<PersonalJwt | null> {
  if (personalOrgId === syncAccountId) {
    const refreshed = await refreshPersonalSession(getSyncServerUrl());
    return refreshed ? getPersonalSessionJwt() : null;
  }

  const refreshedJwt = await refreshSessionForAccount(personalOrgId);
  return refreshedJwt ? asPersonalJwt(refreshedJwt) : null;
}

/**
 * Get the current session token.
 */
export function getSessionToken(): string | null {
  return authState.sessionToken;
}

/**
 * Update the persisted session token after a Stytch session exchange.
 * Session exchanges (e.g., org switch) replace the session token -- the old
 * one becomes invalid. This function saves the new token so that future
 * refreshSession() calls use the valid token.
 */
export function updateSessionToken(newSessionToken: string): void {
  authState = { ...authState, sessionToken: newSessionToken };
  // Persist to disk so the token survives app restarts
  const creds = loadStytchCredentials();
  if (creds) {
    saveStytchCredentials({ ...creds, sessionToken: newSessionToken });
  }
  // Update accounts map
  if (authState.personalOrgId) {
    updateAccountCredentials(authState.personalOrgId, { sessionToken: newSessionToken });
  }
  // logger.main.info('[StytchAuthService] Session token updated after exchange');
}

/**
 * Start Google OAuth sign-in flow.
 * Opens the collabv3 server's Google OAuth URL in the browser.
 * The server handles the callback and redirects to nimbalyst://auth/callback
 */
export async function signInWithGoogle(serverUrl?: string): Promise<{ success: boolean; error?: string }> {
  if (!stytchConfig) {
    return { success: false, error: 'Stytch not initialized' };
  }

  try {
    // Use the collabv3 server to handle OAuth
    const syncServerUrl = serverUrl || 'https://collabv3.nimbalyst.workers.dev';
    const oauthUrl = `${syncServerUrl}/auth/login/google`;

    // Open in default browser
    await shell.openExternal(oauthUrl);

    logger.main.info('[StytchAuthService] Opened Google OAuth flow via server:', oauthUrl);

    // The flow is:
    // 1. Browser opens collabv3/auth/login/google
    // 2. Server redirects to Stytch OAuth
    // 3. User authenticates with Google
    // 4. Stytch redirects to collabv3/auth/callback
    // 5. Server validates token and redirects to nimbalyst://auth/callback?session_token=...
    // 6. App receives deep link and calls handleAuthCallback()
    return { success: true };
  } catch (error) {
    logger.main.error('[StytchAuthService] Google OAuth error:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Send a magic link to the user's email for passwordless authentication.
 * This calls our collabv3 server which has the secret key to send emails.
 * The magic link redirects to collabv3/auth/callback which then redirects to nimbalyst://auth/callback
 */
export async function sendMagicLink(
  email: string,
  serverUrl?: string
): Promise<{ success: boolean; error?: string }> {
  if (!stytchConfig) {
    return { success: false, error: 'Stytch not initialized' };
  }

  try {
    // Get the sync server URL from settings or use default
    const syncServerUrl = serverUrl || 'https://collabv3.nimbalyst.workers.dev';

    // The magic link callback URL is the server's auth callback (not local)
    const callbackUrl = `${syncServerUrl}/auth/callback`;

    // Call our backend server which has the Stytch secret key
    const response = await new Promise<{ success?: boolean; error?: string }>((resolve, reject) => {
      const request = net.request({
        method: 'POST',
        url: `${syncServerUrl}/api/auth/magic-link`,
      });

      request.setHeader('Content-Type', 'application/json');

      let responseData = '';

      request.on('response', (res) => {
        res.on('data', (chunk) => {
          responseData += chunk.toString();
        });

        res.on('end', () => {
          try {
            const data = JSON.parse(responseData);
            resolve(data);
          } catch (e) {
            reject(new Error(`Failed to parse response: ${responseData}`));
          }
        });
      });

      request.on('error', (error) => {
        reject(error);
      });

      request.write(JSON.stringify({
        email,
        redirect_url: callbackUrl,
      }));
      request.end();
    });

    if (response.error) {
      return { success: false, error: response.error };
    }

    logger.main.info('[StytchAuthService] Magic link sent to:', email);
    return { success: true };
  } catch (error) {
    logger.main.error('[StytchAuthService] Magic link error:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Sign out the current user.
 */
export async function signOut(): Promise<void> {
  // Clear local state
  resetSilentMigrationScanState();
  clearStytchCredentials();
  accounts.clear();
  syncAccountId = null;
  saveAllAccounts();
  updateAuthState({
    isAuthenticated: false,
    user: null,
    session: null,
    sessionToken: null,
    sessionJwt: null,
    orgId: null,
    personalOrgId: null,
    personalUserId: null,
    personalSessionJwt: null,
  });

  logger.main.info('[StytchAuthService] User signed out');
}

/**
 * Sign out a specific account by its personalOrgId.
 * If the sync account is removed and other accounts exist, the next account
 * becomes the sync account.
 */
export async function removeAccount(targetOrgId: string): Promise<void> {
  accounts.delete(targetOrgId);

  if (syncAccountId === targetOrgId) {
    // Sync account was removed -- pick another or go unauthenticated.
    const remaining = Array.from(accounts.keys());
    if (remaining.length > 0) {
      syncAccountId = remaining[0];
      const newSyncAccount = accounts.get(syncAccountId)!;
      // Update singleton to the new sync account.
      updateAuthState({
        isAuthenticated: true,
        user: newSyncAccount.userId ? {
          user_id: newSyncAccount.userId,
          emails: newSyncAccount.email ? [{ email_id: '', email: newSyncAccount.email, verified: true }] : [],
          created_at: new Date().toISOString(),
          status: 'active',
        } : null,
        session: null,
        sessionToken: newSyncAccount.sessionToken,
        sessionJwt: newSyncAccount.sessionJwt || null,
        orgId: newSyncAccount.orgId || null,
        personalOrgId: newSyncAccount.personalOrgId || null,
        personalUserId: newSyncAccount.personalUserId || null,
        personalSessionJwt: newSyncAccount.sessionJwt || null,
      });
      saveStytchCredentials(newSyncAccount);
      logger.main.info('[StytchAuthService] Sync account changed to:', newSyncAccount.email);
    } else {
      syncAccountId = null;
      updateAuthState({
        isAuthenticated: false,
        user: null,
        session: null,
        sessionToken: null,
        sessionJwt: null,
        orgId: null,
        personalOrgId: null,
        personalUserId: null,
        personalSessionJwt: null,
      });
      clearStytchCredentials();
      logger.main.info('[StytchAuthService] All accounts removed, user signed out');
    }
  }

  saveAllAccounts();
  logger.main.info('[StytchAuthService] Removed account:', targetOrgId);
}

/**
 * Initiate an "Add Account" OAuth flow.
 * Uses the same Google OAuth mechanism as sign-in, but the callback
 * will detect a new personalOrgId and store it as an additional account.
 */
export async function addAccount(serverUrl?: string): Promise<{ success: boolean; error?: string }> {
  // Same as signInWithGoogle -- the differentiation happens in handleAuthCallback
  return signInWithGoogle(serverUrl);
}

/**
 * Delete the user's account and all associated data.
 * Calls the server's /api/account/delete endpoint which cascades
 * deletes across all storage layers and deletes the Stytch member.
 * On success, clears local credentials and signs out.
 */
export async function deleteAccount(personalOrgId?: string, serverUrl?: string): Promise<{ success: boolean; error?: string }> {
  const targetPersonalOrgId = personalOrgId ?? authState.personalOrgId ?? undefined;
  const personalJwt = targetPersonalOrgId
    ? getPersonalSessionJwtForAccount(targetPersonalOrgId)
    : getPersonalSessionJwt();
  if (!authState.isAuthenticated || !personalJwt) {
    return { success: false, error: 'Not authenticated' };
  }

  const syncServerUrl = serverUrl || getSyncServerUrl();
  if (!syncServerUrl) {
    return { success: false, error: 'No server URL configured' };
  }

  // Convert ws:// to http:// for API calls
  const httpUrl = syncServerUrl
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')
    .replace(/\/$/, '');

  try {
    logger.main.info('[StytchAuthService] Deleting account...');

    const response = await net.fetch(`${httpUrl}/api/account/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${personalJwt}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: string };
      logger.main.error('[StytchAuthService] Account deletion failed:', response.status, errorData.error);
      return { success: false, error: errorData.error || `Server error: ${response.status}` };
    }

    const data = await response.json() as { deleted: boolean };
    logger.main.info('[StytchAuthService] Account deletion response:', data);

    if (targetPersonalOrgId) await removeAccount(targetPersonalOrgId);
    else await signOut();

    logger.main.info('[StytchAuthService] Account deleted successfully');
    return { success: true };
  } catch (error) {
    logger.main.error('[StytchAuthService] Account deletion error:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * In-flight refresh promise for the sync account.
 *
 * Why: Stytch's /auth/refresh consumes the session_token and returns a new one.
 * Concurrent callers using the same token would each fire a refresh; the first
 * succeeds and invalidates the token, the rest get 401s and trigger MORE refreshes
 * (TeamService 401-retry path), producing a stampede that has been observed to
 * stall workspace cold-start for minutes. Single-flight makes concurrent callers
 * share the result of one in-flight call.
 */
let inflightRefreshSession: Promise<boolean> | null = null;

/**
 * Refresh the current session to get a fresh JWT.
 * Calls the collabv3 server's /auth/refresh endpoint.
 *
 * Concurrent callers share a single in-flight /auth/refresh request.
 *
 * @param serverUrl - The sync server URL (e.g., 'https://sync.nimbalyst.com')
 * @returns true if refresh succeeded, false if session expired or failed
 */
export function refreshSession(serverUrl?: string): Promise<boolean> {
  if (inflightRefreshSession) {
    return inflightRefreshSession;
  }
  inflightRefreshSession = doRefreshSession(serverUrl).finally(() => {
    inflightRefreshSession = null;
  });
  return inflightRefreshSession;
}

async function doRefreshSession(serverUrl?: string): Promise<boolean> {
  const creds = loadStytchCredentials();
  if (!creds?.sessionToken) {
    logger.main.warn('[StytchAuthService] Cannot refresh - no session token');
    return false;
  }

  // Determine server URL - always resolves to a valid URL
  const syncServerUrl = serverUrl || getSyncServerUrl();

  // Convert ws:// to http:// for API calls
  const httpUrl = syncServerUrl
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')
    .replace(/\/$/, '');

  try {
    // logger.main.info('[StytchAuthService] Refreshing session...');

    let response: Response;
    try {
      response = await net.fetch(`${httpUrl}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_token: creds.sessionToken,
        }),
      });
    } catch (fetchError) {
      // Network-level errors (ERR_INTERNET_DISCONNECTED, ERR_NAME_NOT_RESOLVED, etc.)
      // are NOT auth failures -- the session may still be valid once connectivity returns.
      // Tag the error so callers (like validateAndRefreshSession) can distinguish this
      // from a server-confirmed auth rejection.
      logger.main.error('[StytchAuthService] Session refresh error:', fetchError);
      const networkError = new Error('Network error during session refresh');
      (networkError as any).isNetworkError = true;
      (networkError as any).cause = fetchError;
      throw networkError;
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { expired?: boolean; error?: string };
      logger.main.warn('[StytchAuthService] Session refresh failed:', errorData.error || response.status);

      // Don't auto-signOut here - let callers decide how to handle expired sessions.
      // Auto-signOut was nuking credentials, which broke fallback logic in share handlers
      // and could sign users out unexpectedly when background operations triggered refresh.
      return false;
    }

    const data = await response.json() as {
      session_token: string;
      session_jwt: string;
      user_id: string;
      email?: string;
      expires_at: string;
      org_id?: string;
    };

    // Validate the new JWT
    if (!data.session_jwt || data.session_jwt.split('.').length !== 3) {
      logger.main.error('[StytchAuthService] Refresh returned invalid JWT');
      return false;
    }

    // Calculate expiry time
    let expiresAtMs = Date.now() + (7 * 24 * 60 * 60 * 1000); // Default: 1 week
    if (data.expires_at) {
      try {
        expiresAtMs = new Date(data.expires_at).getTime();
      } catch {
        // Use default
      }
    }

    const refreshedOrgId = data.org_id || null;
    // personalOrgId and personalUserId are NEVER overwritten by refresh -- they're
    // the stable personal org values set during initial auth or migrated on restore.
    // After a team session exchange, refresh returns the team org's member ID and org ID,
    // but we preserve the personal values for sync room IDs and encryption keys.
    const personalOrgId = authState.personalOrgId;
    const personalUserId = authState.personalUserId;
    let personalSessionJwt = authState.personalSessionJwt;
    try {
      const jwtParts = data.session_jwt.split('.');
      const payload = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString()) as { sub?: string };
      if (payload.sub && personalUserId && payload.sub === personalUserId) {
        personalSessionJwt = data.session_jwt;
      }
    } catch {
      // Keep the existing personal JWT unless the refreshed token's scope is proven.
    }
    updateAuthState({
      isAuthenticated: true,
      user: data.user_id ? {
        user_id: data.user_id,
        emails: data.email ? [{ email_id: '', email: data.email, verified: true }] : [],
        created_at: new Date().toISOString(),
        status: 'active',
      } : authState.user,
      sessionToken: data.session_token,
      sessionJwt: data.session_jwt,
      orgId: refreshedOrgId,
      personalOrgId,
      personalUserId,
      personalSessionJwt,
    });

    // Save updated credentials
    const refreshedCreds: StoredStytchCredentials = {
      sessionToken: data.session_token,
      sessionJwt: data.session_jwt,
      userId: data.user_id || creds.userId,
      email: data.email || creds.email,
      expiresAt: expiresAtMs,
      orgId: refreshedOrgId || undefined,
      personalOrgId: personalOrgId || undefined,
      personalUserId: personalUserId || undefined,
    };
    saveStytchCredentials(refreshedCreds);

    // Update accounts map
    if (personalOrgId) {
      accounts.set(personalOrgId, refreshedCreds);
      saveAllAccounts();
    }

    // logger.main.info('[StytchAuthService] Session refreshed successfully');
    return true;
  } catch (error) {
    // Re-throw network errors so callers can distinguish them from auth failures
    if ((error as any)?.isNetworkError) {
      throw error;
    }
    logger.main.error('[StytchAuthService] Session refresh error:', error);
    return false;
  }
}

/**
 * In-flight refresh promises for non-sync accounts, keyed by personalOrgId.
 *
 * Why: Same single-flight rationale as inflightRefreshSession, but per-account.
 * Each Stytch session_token is single-use; concurrent callers for the same
 * account would stampede the token and cascade into 401-retry storms.
 */
const inflightRefreshForAccount = new Map<string, Promise<string | null>>();

/**
 * Refresh a specific account's session by personalOrgId.
 * Works for both sync and non-sync accounts.
 * Returns the fresh JWT on success, null on failure.
 *
 * Concurrent callers for the same personalOrgId share a single in-flight refresh.
 */
export function refreshSessionForAccount(personalOrgId: string): Promise<string | null> {
  const inflight = inflightRefreshForAccount.get(personalOrgId);
  if (inflight) {
    return inflight;
  }
  const promise = doRefreshSessionForAccount(personalOrgId).finally(() => {
    inflightRefreshForAccount.delete(personalOrgId);
  });
  inflightRefreshForAccount.set(personalOrgId, promise);
  return promise;
}

async function doRefreshSessionForAccount(personalOrgId: string): Promise<string | null> {
  // For the sync account, delegate to refreshSession, which updates authState.
  if (personalOrgId === syncAccountId) {
    try {
      const ok = await refreshSession();
      return ok ? (authState.sessionJwt ?? null) : null;
    } catch {
      return null; // Network error -- return null, don't propagate
    }
  }

  // Non-sync account: use its own session token to hit /auth/refresh.
  const creds = accounts.get(personalOrgId);
  if (!creds?.sessionToken) {
    logger.main.warn(`[StytchAuthService] Cannot refresh account ${personalOrgId} - no session token`);
    return null;
  }

  const syncServerUrl = getSyncServerUrl();
  const httpUrl = syncServerUrl
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')
    .replace(/\/$/, '');

  try {
    logger.main.info(`[StytchAuthService] Refreshing account session for ${personalOrgId}...`);

    const response = await net.fetch(`${httpUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_token: creds.sessionToken }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: string };
      logger.main.warn(`[StytchAuthService] Account refresh failed for ${personalOrgId}:`, errorData.error || response.status);
      return null;
    }

    const data = await response.json() as {
      session_token: string;
      session_jwt: string;
      user_id: string;
      email?: string;
      expires_at: string;
      org_id?: string;
    };

    if (!data.session_jwt || data.session_jwt.split('.').length !== 3) {
      logger.main.error(`[StytchAuthService] Account refresh returned invalid JWT for ${personalOrgId}`);
      return null;
    }

    let expiresAtMs = Date.now() + (7 * 24 * 60 * 60 * 1000);
    if (data.expires_at) {
      try { expiresAtMs = new Date(data.expires_at).getTime(); } catch { /* use default */ }
    }

    // Update the account in the accounts map
    updateAccountCredentials(personalOrgId, {
      sessionToken: data.session_token,
      sessionJwt: data.session_jwt,
      userId: data.user_id || creds.userId,
      email: data.email || creds.email,
      expiresAt: expiresAtMs,
    });

    logger.main.info(`[StytchAuthService] Account session refreshed for ${personalOrgId}`);
    return data.session_jwt;
  } catch (error) {
    logger.main.error(`[StytchAuthService] Account refresh error for ${personalOrgId}:`, error);
    return null;
  }
}

const PRODUCTION_SYNC_URL = 'https://sync.nimbalyst.com';
const DEVELOPMENT_SYNC_URL = 'http://localhost:8790';

/**
 * Get the sync server URL. Always returns a valid URL - defaults to production.
 */
function getSyncServerUrl(): string {
  const config = getSessionSyncConfig();
  if (config?.serverUrl) return config.serverUrl;
  const isDev = process.env.NODE_ENV !== 'production';
  const env = isDev ? config?.environment : undefined;
  return env === 'development' ? DEVELOPMENT_SYNC_URL : PRODUCTION_SYNC_URL;
}

/**
 * Validate the current session against the server and sign out if dead.
 * Always calls refreshSession() to verify the session is alive server-side,
 * not just locally valid. Signs out on confirmed auth failure (expired creds,
 * server rejection) but NOT on network errors -- the session may still be
 * valid once connectivity is restored.
 */
export async function validateAndRefreshSession(): Promise<boolean> {
  const creds = loadStytchCredentials();
  if (!creds || creds.expiresAt <= Date.now()) {
    markAccountSessionExpired(creds?.personalOrgId ?? syncAccountId);
    return false;
  }

  try {
    const refreshed = await refreshSession();
    if (!refreshed) {
      // Server responded but rejected the session (401/403/expired). Keep the
      // account visible so the renderer can offer account-scoped re-auth.
      logger.main.warn('[StytchAuthService] Session validation failed - preserving account for re-auth');
      markAccountSessionExpired(creds.personalOrgId ?? syncAccountId);
      return false;
    }
    return true;
  } catch (error) {
    if ((error as any)?.isNetworkError) {
      // Network error (ERR_INTERNET_DISCONNECTED, DNS failure, etc.) -- the session
      // may still be valid, we just can't reach the server. Don't nuke credentials;
      // they'll be refreshed automatically once connectivity returns.
      logger.main.warn('[StytchAuthService] Session refresh failed due to network error - keeping credentials');
      return false;
    }
    // Unexpected error -- don't sign out, could be transient
    logger.main.error('[StytchAuthService] Unexpected error during session validation:', error);
    return false;
  }
}

/**
 * Shutdown the auth service.
 * Call this when the app is closing.
 */
export function shutdownStytchAuth(): void {
  // Nothing to clean up - device tokens removed, auth state managed by Stytch
}

/**
 * Switch Stytch environment. Signs out and reinitializes.
 */
export async function switchStytchEnvironment(_environment: 'development' | 'production'): Promise<void> {
  await signOut();

  const config = STYTCH_CONFIG.live;
  initializeStytchAuth({
    projectId: config.projectId,
    publicToken: config.publicToken,
    apiBase: config.apiBase,
  });

  logger.main.info('[StytchAuthService] Reinitialized with projectId:', config.projectId);
}
