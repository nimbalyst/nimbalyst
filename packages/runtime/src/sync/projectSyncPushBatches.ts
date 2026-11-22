import { projectSyncEstimatedStoredBytes } from '@nimbalyst/collab-protocol';

/**
 * Upload frame budget for project file pushes, matching the 1 MB target the
 * server uses for its own response batches. One frame carrying a whole backlog
 * (982 files, ~20 MB) never reached the room: the socket dropped first, nothing
 * was stored, and the next sync asked for the same files again.
 */
export const PROJECT_SYNC_PUSH_TARGET_BYTES = 1024 * 1024;
export const PROJECT_SYNC_PUSH_MAX_FILES = 200;

/** JSON keys and punctuation around one encrypted entry in a batch frame. */
const ENTRY_JSON_OVERHEAD_BYTES = 256;

export interface ProjectSyncPushFile {
  syncId: string;
  content: string;
  relativePath: string;
  title: string;
  lastModifiedAt: number;
}

/** Size of a file's entry once encrypted and base64'd, from plaintext lengths. */
export function projectSyncPushEntryBytes(file: ProjectSyncPushFile): number {
  return ENTRY_JSON_OVERHEAD_BYTES + projectSyncEstimatedStoredBytes({
    contentBytes: Buffer.byteLength(file.content, 'utf8'),
    pathBytes: Buffer.byteLength(file.relativePath, 'utf8'),
    titleBytes: Buffer.byteLength(file.title, 'utf8'),
    syncIdLength: file.syncId.length,
  });
}

/**
 * Split files, in order, into frames of at most `targetBytes` and `maxFiles`.
 * A single file over the byte target goes out alone; the per-file storage cap
 * keeps it far below the frame limit.
 */
export function planProjectSyncPushBatches<T>(
  files: readonly T[],
  bytesOf: (file: T) => number,
  limits: { targetBytes: number; maxFiles: number } = { targetBytes: PROJECT_SYNC_PUSH_TARGET_BYTES, maxFiles: PROJECT_SYNC_PUSH_MAX_FILES },
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const file of files) {
    const bytes = bytesOf(file);
    if (current.length > 0 && (currentBytes + bytes > limits.targetBytes || current.length >= limits.maxFiles)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
