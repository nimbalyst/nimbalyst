import { app } from 'electron';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { getPackageRoot } from '../utils/appPaths';
import { logger } from '../utils/logger';
import type { HashedFileResult } from '../workers/projectManifestWorker';
import { scanProjectSyncCandidatesInline, type ProjectSyncScanCandidate, type ProjectSyncScanRequest } from './sync/projectSyncScan';

export type { HashedFileResult };

/**
 * Hard ceiling for one manifest batch. A hung worker must not stall project
 * sync indefinitely — on timeout we terminate it and hash inline instead.
 * Generous because the whole point is that this batch is genuinely large.
 */
const MANIFEST_HASH_TIMEOUT_MS = 120_000;

function resolveProjectManifestWorkerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'project-manifest-worker.bundle.js');
  }
  return path.join(getPackageRoot(), 'out', 'project-manifest-worker.bundle.js');
}

/** The pre-worker behaviour, kept as the fallback path. */
async function hashInline(files: string[]): Promise<HashedFileResult[]> {
  const results: HashedFileResult[] = [];
  for (const filePath of files) {
    try {
      const content = await readFile(filePath, 'utf-8');
      const stats = await stat(filePath);
      results.push({
        filePath,
        contentHash: createHash('sha256').update(content).digest('hex'),
        lastModifiedAt: Math.floor(stats.mtimeMs),
      });
    } catch (error) {
      results.push({ filePath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * Read + hash every path off the main thread.
 *
 * One worker per call, terminated on completion: buildManifest runs at startup
 * and on sync reconnects, not in a hot loop, so ~30ms of spawn against a
 * multi-second batch is a good trade for having no worker lifecycle to leak.
 *
 * Any worker failure falls back to inline hashing. Project sync is correctness-
 * critical; degrading to the old (slow) behaviour is always better than
 * returning a short manifest, which the server would read as "these files were
 * deleted".
 */
export async function hashProjectFiles(files: string[]): Promise<HashedFileResult[]> {
  if (files.length === 0) return [];
  return runInManifestWorker({ files }, () => hashInline(files));
}

/**
 * Walk the workspace for sync candidates off the main thread. A failed worker
 * falls back to the same walk inline, never to a short list.
 */
export function scanProjectSyncCandidates(request: ProjectSyncScanRequest): Promise<ProjectSyncScanCandidate[]> {
  return runInManifestWorker({ scan: request }, () => scanProjectSyncCandidatesInline(request));
}

async function runInManifestWorker<T>(payload: object, inline: () => Promise<T[]>): Promise<T[]> {
  let worker: Worker | null = null;
  try {
    // Constructed here rather than inside the executor so its lifetime is
    // visible to the `finally` below (and to the type checker).
    const active = new Worker(resolveProjectManifestWorkerPath());
    worker = active;

    return await new Promise<T[]>((resolve, reject) => {
      const id = randomUUID();
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error(`manifest worker timed out after ${MANIFEST_HASH_TIMEOUT_MS}ms`)));
      }, MANIFEST_HASH_TIMEOUT_MS);

      active.on('message', (response: { id: string; results: T[] }) => {
        if (response?.id !== id) return;
        finish(() => resolve(response.results));
      });
      active.on('error', (error) => finish(() => reject(error)));
      active.on('exit', (code) => {
        if (code !== 0) finish(() => reject(new Error(`manifest worker exited with code ${code}`)));
      });

      active.postMessage({ id, ...payload });
    });
  } catch (error) {
    logger.main.warn(
      '[ProjectManifestHasher] worker unavailable, running inline on the main thread',
      error,
    );
    return inline();
  } finally {
    void worker?.terminate();
  }
}

/** Exported for tests that need to exercise the fallback path directly. */
export const __hashInlineForTests = hashInline;
