import * as path from 'path';
import {
  PROJECT_SYNC_MAX_FILE_STORED_BYTES,
  projectSyncEstimatedStoredBytes,
} from '@nimbalyst/collab-protocol';
import type { ProjectFilePushOutcome } from '@nimbalyst/runtime/sync';
import { logger } from '../utils/logger';

/** The title a synced file carries on the wire: its file name without the extension. */
export function projectSyncTitle(relativePath: string): string {
  return path.basename(relativePath, path.extname(relativePath));
}

/**
 * Whether a file would exceed the server's per-row storage cap once encrypted.
 * The server refuses such a file (NIM-7337), so the client never offers it.
 */
export function exceedsProjectSyncLimit(contentBytes: number, relativePath: string): boolean {
  return projectSyncEstimatedStoredBytes({
    contentBytes,
    pathBytes: Buffer.byteLength(relativePath),
    titleBytes: Buffer.byteLength(projectSyncTitle(relativePath)),
    syncIdLength: 64,
  }) > PROJECT_SYNC_MAX_FILE_STORED_BYTES;
}

/**
 * Warns once per file per process. The manifest is rebuilt on every reconnect,
 * so an unconditional warning would repeat for the life of the app.
 */
export class OversizedFileWarnings {
  private warned = new Set<string>();

  warn(filePath: string, contentBytes: number): void {
    if (this.warned.has(filePath)) return;
    this.warned.add(filePath);
    logger.main.warn(
      `[ProjectFileSync] Not syncing ${filePath} (${(contentBytes / 1024 / 1024).toFixed(1)}MB): too large for mobile sync once encrypted`,
    );
  }
}

/** Log what the server refused or never confirmed; returns the stored syncIds. */
export function storedSyncIds(outcome: ProjectFilePushOutcome): Set<string> {
  for (const rejection of outcome.rejected) {
    logger.main.warn(`[ProjectFileSync] Server rejected ${rejection.syncId}: ${rejection.code} ${rejection.message}`);
  }
  if (outcome.unconfirmed.length > 0) {
    logger.main.info(`[ProjectFileSync] ${outcome.unconfirmed.length} pushed file(s) unconfirmed; the next sync response settles them`);
  }
  return new Set(outcome.stored);
}
