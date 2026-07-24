/**
 * CredentialService - Manages encryption key for E2E encrypted sync.
 *
 * This service handles:
 * - Auto-generating secure encryption key seed on first launch
 * - Storing the key seed securely using Electron's safeStorage API (OS keychain)
 * - Providing the encryption key seed for session sync and mobile device pairing
 *
 * Security notes:
 * - Encryption key seed is generated locally and NEVER sent to the server
 * - The key seed is only shared via QR code for mobile pairing
 * - Authentication is handled separately by StytchAuthService
 */

import { safeStorage } from 'electron';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { AnalyticsService } from './analytics/AnalyticsService';

/**
 * Encryption credentials for E2E encrypted sync.
 * Authentication is handled by StytchAuthService.
 */
export interface SyncCredentials {
  encryptionKeySeed: string; // Base64 encoded 32 bytes - never sent to server
  createdAt: number;
}

const CREDENTIALS_FILE = 'sync-credentials.enc';

let cachedCredentials: SyncCredentials | null = null;

/**
 * Get the path to the encrypted credentials file.
 */
function getCredentialsPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, CREDENTIALS_FILE);
}

/**
 * Generate a cryptographically secure random string (base64 encoded).
 */
function generateSecureToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('base64');
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
 * Create new credentials with auto-generated encryption key seed.
 */
function createCredentials(): SyncCredentials {
  return {
    encryptionKeySeed: generateSecureToken(32),
    createdAt: Date.now(),
  };
}

/**
 * Save credentials to disk using safeStorage encryption.
 */
function saveCredentials(credentials: SyncCredentials): void {
  const credentialsPath = getCredentialsPath();
  const jsonData = JSON.stringify(credentials);

  if (isSafeStorageAvailable()) {
    // Encrypt using OS keychain
    const encrypted = safeStorage.encryptString(jsonData);
    fs.writeFileSync(credentialsPath, encrypted);
    logger.main.info('[CredentialService] Credentials saved with safeStorage encryption');
  } else {
    // Fallback: save as plain JSON (with warning)
    logger.main.warn('[CredentialService] safeStorage not available - saving credentials without encryption');
    fs.writeFileSync(credentialsPath, jsonData, 'utf8');
  }
}

/**
 * Load credentials from disk using safeStorage decryption.
 */
function loadCredentials(): SyncCredentials | null {
  const credentialsPath = getCredentialsPath();

  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    const fileData = fs.readFileSync(credentialsPath);

    if (isSafeStorageAvailable()) {
      // Decrypt using OS keychain
      const decrypted = safeStorage.decryptString(fileData);
      return JSON.parse(decrypted);
    } else {
      // Fallback: try to read as plain JSON
      const jsonData = fileData.toString('utf8');
      return JSON.parse(jsonData);
    }
  } catch (error) {
    logger.main.error('[CredentialService] Failed to load credentials:', error);
    return null;
  }
}

/**
 * Get or create sync credentials.
 *
 * On first launch, generates new encryption key seed and saves it securely.
 * On subsequent launches, loads existing credentials from disk.
 */
export function getCredentials(): SyncCredentials {
  // Return cached credentials if available
  if (cachedCredentials) {
    return cachedCredentials;
  }

  // Try to load existing credentials
  let credentials = loadCredentials();

  if (!credentials) {
    // First launch - generate new credentials
    logger.main.info('[CredentialService] First launch - generating new encryption key seed');
    credentials = createCredentials();
    saveCredentials(credentials);
    logger.main.info('[CredentialService] New encryption key seed generated', {
      createdAt: new Date(credentials.createdAt).toISOString(),
    });
  } else {
    // Validate seed has sufficient entropy.
    // crypto.randomBytes(32).toString('base64') produces a 44-char string (32 bytes = 256 bits).
    // Reject anything shorter than 43 chars (minimum for 32 bytes of base64).
    const MIN_SEED_LENGTH = 43;
    if (!credentials.encryptionKeySeed || credentials.encryptionKeySeed.length < MIN_SEED_LENGTH) {
      logger.main.error(
        '[CredentialService] Encryption seed too short or missing, regenerating.',
        { length: credentials.encryptionKeySeed?.length ?? 0 }
      );
      credentials = createCredentials();
      saveCredentials(credentials);
    } else {
      logger.main.info('[CredentialService] Loaded existing credentials', {
        createdAt: new Date(credentials.createdAt).toISOString(),
      });
    }
  }

  // Cache for subsequent calls
  cachedCredentials = credentials;
  return credentials;
}

/**
 * Check if credentials exist (without loading them).
 */
export function hasCredentials(): boolean {
  return fs.existsSync(getCredentialsPath());
}

/**
 * Reset encryption key seed - generates a new one.
 *
 * WARNING: This will invalidate any paired mobile devices.
 * They will need to re-scan the QR code.
 */
export function resetCredentials(): SyncCredentials {
  logger.main.info('[CredentialService] Resetting encryption key seed...');

  const credentials = createCredentials();
  saveCredentials(credentials);
  cachedCredentials = credentials;

  logger.main.info('[CredentialService] New encryption key seed generated', {
    createdAt: new Date(credentials.createdAt).toISOString(),
  });

  return credentials;
}

/**
 * Get the encryption key seed (for deriving encryption key).
 */
export function getEncryptionKeySeed(): string {
  return getCredentials().encryptionKeySeed;
}

/**
 * Check if safeStorage encryption is being used.
 */
export function isUsingSecureStorage(): boolean {
  return isSafeStorageAvailable();
}

/**
 * Generate QR pairing payload for mobile device.
 *
 * The QR code contains the encryption key seed, server URL, analytics ID, and sync email.
 * Mobile devices authenticate independently via Stytch OAuth, but must use the same email.
 *
 * @param serverUrl - The sync server URL
 * @param syncEmail - The email address used for sync (mobile must login with same email)
 */
export function generateQRPairingPayload(
  serverUrl: string,
  syncEmail?: string,
  personalOrgId?: string,
  personalUserId?: string,
): {
  version: number;
  serverUrl: string;
  encryptionKeySeed: string;
  expiresAt: number;
  analyticsId: string;
  syncEmail?: string;
  personalOrgId?: string;
  personalUserId?: string;
} {
  const credentials = getCredentials();

  // QR code expires in 15 minutes for security
  const expiresAt = Date.now() + 15 * 60 * 1000;

  // Include analytics ID for identity linking (v3)
  const analyticsId = AnalyticsService.getInstance().getDistinctId();

  return {
    version: 5, // Version 5 = includes personalOrgId/personalUserId for room routing
    serverUrl,
    encryptionKeySeed: credentials.encryptionKeySeed,
    expiresAt,
    analyticsId,
    syncEmail,
    personalOrgId,
    personalUserId,
  };
}
