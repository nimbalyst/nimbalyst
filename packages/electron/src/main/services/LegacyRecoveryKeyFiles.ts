/**
 * Retired client keys can be the only surviving way to recover a legacy org.
 * Detect their presence without opening, modifying or deleting them. Recovery
 * reads them only after an org-admin action; normal team sync never uses them.
 */

import fs from 'fs';
import path from 'path';
import { app, safeStorage } from 'electron';
import { createDecipheriv } from 'node:crypto';
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
 * Return present source names, never their contents. Missing files are normal.
 */
export function findLegacyRecoveryKeyFiles(userDataPath: string = app.getPath('userData')): string[] {
  const present: string[] = [];
  for (const filename of LEGACY_KEY_FILES) {
    const filePath = path.join(userDataPath, filename);
    try {
      if (!fs.existsSync(filePath)) continue;
      present.push(filename);
    } catch (error) {
      logger.main.warn('[LegacyRecoveryKeyFiles] Could not inspect recovery source presence');
    }
  }
  if (present.length > 0) {
    logger.main.info('[LegacyRecoveryKeyFiles] Retained legacy recovery sources');
  }
  return present;
}

/**
 * Explicit offline recovery only: no key creation, exchange, writes, or normal-sync fallback.
 *
 * One unreadable file (a changed keychain, a corrupt write, a malformed epoch)
 * must not block recovery that local replicas or other keys can still cover.
 * Such files are skipped and passed to `action` by file name only; content that
 * genuinely needed their keys then surfaces through the normal coverage blockers.
 */
export async function withLegacyRecoveryKeys<T>(
  orgId: string,
  action: (decrypt: (ciphertext: string, iv: string, additionalData?: string) => Buffer, unreadableFiles: string[]) => Promise<T>,
  userDataPath: string = app.getPath('userData'),
): Promise<T> {
  if (!orgId || orgId.length > 256) throw new Error('Recovery organization required');
  const keys: Buffer[] = [];
  const unreadableFiles: string[] = [];
  let closed = false;
  try {
    for (const name of ['org-encryption-keys.enc', 'org-key-history.enc']) {
      const filename = path.join(userDataPath, name);
      let entries: unknown;
      try {
        if (!fs.existsSync(filename)) continue;
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid retained recovery key file');
        const bytes = fs.readFileSync(filename);
        let decoded: string;
        try { decoded = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(bytes) : bytes.toString('utf8'); }
        catch { decoded = bytes.toString('utf8'); } // Historical safeStorage-unavailable installations wrote JSON.
        finally { bytes.fill(0); }
        entries = JSON.parse(decoded);
        if (!Array.isArray(entries)) throw new Error('Invalid retained recovery key format');
      } catch {
        unreadableFiles.push(name);
        continue;
      }
      let malformed = false;
      for (const entry of entries as unknown[]) {
        if (!Array.isArray(entry) || entry[0] !== orgId) continue;
        const candidates = name === 'org-key-history.enc' ? entry[1] : [entry[1]];
        if (!Array.isArray(candidates) || candidates.length > 128) { malformed = true; continue; }
        for (const candidate of candidates) {
          const raw = typeof candidate === 'string' ? candidate : candidate?.rawKeyBase64;
          if (typeof raw !== 'string') { malformed = true; continue; }
          const key = Buffer.from(raw, 'base64');
          if (key.length !== 32 || key.toString('base64') !== raw) { key.fill(0); malformed = true; continue; }
          keys.push(key);
        }
      }
      if (malformed) unreadableFiles.push(name);
    }
    if (unreadableFiles.length) logger.main.warn('[LegacyRecoveryKeyFiles] Some retained recovery key files could not be read:', unreadableFiles.join(', '));
    return await action((ciphertext, iv, additionalData) => {
      if (closed) throw new Error('Recovery key reader is closed');
      const bytes = Buffer.from(ciphertext, 'base64'), nonce = Buffer.from(iv, 'base64');
      if (bytes.length < 16 || bytes.length > 32 * 1024 * 1024 || bytes.toString('base64') !== ciphertext
        || nonce.length !== 12 || nonce.toString('base64') !== iv) throw new Error('Invalid encrypted recovery source');
      for (const key of keys) {
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, nonce);
          if (additionalData !== undefined) decipher.setAAD(Buffer.from(additionalData));
          decipher.setAuthTag(bytes.subarray(-16));
          return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
        } catch { /* Try another retained epoch for this exact organization. */ }
      }
      throw new Error('No retained key can decrypt this recovery source');
    }, unreadableFiles);
  } finally { closed = true; keys.forEach(key => key.fill(0)); }
}
