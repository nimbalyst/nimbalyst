import { promises as fs } from 'fs';
import { join } from 'path';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { getAttachmentStagingConfig } from '../../utils/store';
import { logger } from '../../utils/logger';
import { resolveWorkspaceAttachmentStagingDirectory } from './attachmentStagingRoot';

export const ATTACHMENT_STAGING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function removeExpiredFiles(directory: string, cutoff: number): Promise<number> {
  let removed = 0;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      removed += await removeExpiredFiles(entryPath, cutoff);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(entryPath);
    if (stat.mtimeMs < cutoff) {
      await fs.rm(entryPath, { force: true });
      removed++;
    }
  }
  return removed;
}

async function removeOrphanOwnerDirectories(
  directory: string,
  validSessionIds: Set<string>,
): Promise<number> {
  let removed = 0;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || validSessionIds.has(entry.name)) continue;
    await fs.rm(join(directory, entry.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

export async function reapAttachmentStagingDirectory(options: {
  directory: string;
  mode: 'temp' | 'workspace' | 'custom';
  validSessionIds: Iterable<string>;
  now?: number;
}): Promise<{ removedFiles: number; removedOwnerDirectories: number }> {
  if (options.mode === 'temp') {
    return { removedFiles: 0, removedOwnerDirectories: 0 };
  }

  const validSessionIds = new Set(options.validSessionIds);
  const removedOwnerDirectories =
    await removeOrphanOwnerDirectories(join(options.directory, 'saved'), validSessionIds)
    + await removeOrphanOwnerDirectories(join(options.directory, 'large'), validSessionIds);
  const removedFiles = await removeExpiredFiles(
    options.directory,
    (options.now ?? Date.now()) - ATTACHMENT_STAGING_MAX_AGE_MS,
  );
  return { removedFiles, removedOwnerDirectories };
}

const scheduledWorkspaces = new Set<string>();

/** Run once per workspace open, after first-usable work has had a chance to settle. */
export function scheduleAttachmentStagingCleanup(workspacePath: string): void {
  if (scheduledWorkspaces.has(workspacePath)) return;
  scheduledWorkspaces.add(workspacePath);
  setTimeout(() => {
    void (async () => {
      const config = getAttachmentStagingConfig();
      if (config.mode === 'temp') return;
      const sessions = await AISessionsRepository.list(workspacePath, { includeArchived: true });
      const result = await reapAttachmentStagingDirectory({
        directory: resolveWorkspaceAttachmentStagingDirectory(workspacePath),
        mode: config.mode,
        validSessionIds: sessions.map((session) => session.id),
      });
      if (result.removedFiles || result.removedOwnerDirectories) {
        logger.main.info('[AttachmentStaging] Cleanup completed:', { workspacePath, ...result });
      }
    })().catch((error) => {
      logger.main.warn('[AttachmentStaging] Deferred cleanup failed:', error);
    });
  }, 0);
}

export function resetAttachmentStagingCleanupForTests(): void {
  scheduledWorkspaces.clear();
}
