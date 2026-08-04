/**
 * LegacyKeyFilePurge - delete the client-side key material left behind by the
 * retired client-managed team encryption lane.
 *
 * OrgKeyService used to persist a per-device ECDH identity key pair, the raw
 * org AES keys, their rotation history, and per-member trust decisions in
 * userData. Team custody is server-managed now, so none of it is ever read
 * again — and when safeStorage was unavailable those files were written as
 * plaintext, so leaving them on disk is strictly worse than deleting them.
 *
 * One-shot at startup, idempotent (missing files are a no-op).
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { logger } from '../utils/logger';

/** Files written by the deleted OrgKeyService, all directly under userData. */
export const LEGACY_KEY_FILES = [
  'ecdh-identity-keypair.enc',
  'org-encryption-keys.enc',
  'org-key-history.enc',
  'trust-verifications.enc',
  'team-key-status.enc',
] as const;

/**
 * Delete every legacy key file present under `userDataPath`.
 * Returns the names actually removed (empty on a already-clean install).
 */
export function purgeLegacyKeyFiles(userDataPath: string = app.getPath('userData')): string[] {
  const removed: string[] = [];
  for (const filename of LEGACY_KEY_FILES) {
    const filePath = path.join(userDataPath, filename);
    try {
      if (!fs.existsSync(filePath)) continue;
      fs.unlinkSync(filePath);
      removed.push(filename);
    } catch (error) {
      // A locked or permission-denied file must not block startup; the next
      // launch retries.
      logger.main.warn(`[LegacyKeyFilePurge] Failed to delete ${filename}:`, error);
    }
  }
  if (removed.length > 0) {
    logger.main.info('[LegacyKeyFilePurge] Removed legacy client key files:', removed.join(', '));
  }
  return removed;
}
