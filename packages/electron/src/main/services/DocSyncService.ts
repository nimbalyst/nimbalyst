/**
 * DocSyncService
 *
 * Manages sync identity for markdown files using path-based deterministic IDs.
 * Each .md file's sync identity is SHA-256(relativePath) -- no file modification needed.
 *
 * The syncId is used as the documentId in the ProjectSyncRoom:
 *   org:{personalOrgId}:project:{projectId}:doc:{syncId}
 *
 * This service handles:
 * - Computing deterministic syncId from a file's relative path
 * - Pushing file metadata to the IndexRoom file index
 * - Removing files from the index on deletion
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';
import { getSyncProvider } from './SyncManager';

// ============================================================================
// SyncId Management
// ============================================================================

/**
 * Compute a deterministic syncId from a file's relative path.
 * Returns SHA-256(relativePath) as a hex string.
 *
 * @param filePath - Absolute path to the file
 * @param workspacePath - Absolute path to the workspace/project root
 */
export function getSyncId(filePath: string, workspacePath: string): string {
  const relativePath = path.relative(workspacePath, filePath);
  return createHash('sha256').update(relativePath).digest('hex');
}

// ============================================================================
// File Index Push
// ============================================================================

/**
 * Push a file's metadata to the IndexRoom file index.
 * Called when a .md file is saved or modified in a sync-enabled project.
 *
 * @param filePath - Absolute path to the .md file
 * @param workspacePath - Absolute path to the workspace/project root
 */
export async function pushFileToIndex(filePath: string, workspacePath: string): Promise<void> {
  const provider = getSyncProvider();
  if (!provider?.syncFileToIndex) return;

  try {
    const syncId = getSyncId(filePath, workspacePath);
    const relativePath = path.relative(workspacePath, filePath);
    const title = path.basename(filePath, path.extname(filePath));
    const stat = await fs.stat(filePath);

    provider.syncFileToIndex({
      docId: syncId,
      projectId: workspacePath,
      relativePath,
      title,
      lastModifiedAt: stat.mtimeMs,
    });
  } catch (err) {
    logger.main.error('[DocSyncService] Failed to push file to index:', err);
  }
}

/**
 * Remove a file from the IndexRoom file index.
 * Called when a .md file is deleted.
 *
 * @param docId - The syncId of the deleted file
 */
export function removeFileFromIndex(docId: string): void {
  const provider = getSyncProvider();
  if (!provider?.deleteFileFromIndex) return;
  provider.deleteFileFromIndex(docId);
}
