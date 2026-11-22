import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { scanProjectSyncCandidatesInline, type ProjectSyncScanRequest } from '../services/sync/projectSyncScan';

/**
 * Reads and hashes markdown files for ProjectFileSync's manifest, off the main
 * thread.
 *
 * `buildManifest` used to do `readFile` -> `stat` -> a SYNCHRONOUS sha256 inline
 * on the main-process event loop, once per file, with no cap on file count. On a
 * 1531-file project that measured ~22s of blocked event loop on every startup
 * and every sync reconnect, which is the single largest contributor to the
 * post-restart sluggish window.
 *
 * The whole path list arrives in one message and only the digests travel back:
 * shipping file *contents* across the thread boundary would trade the hashing
 * cost for an equally large structured-clone cost and gain nothing.
 */

interface WorkerRequest {
  id: string;
  files: string[];
}

interface WorkerScanRequest {
  id: string;
  scan: ProjectSyncScanRequest;
}

export interface HashedFileResult {
  filePath: string;
  contentHash?: string;
  lastModifiedAt?: number;
  error?: string;
}

if (!parentPort) {
  throw new Error('projectManifestWorker must run in a worker thread');
}

async function hashFile(filePath: string): Promise<HashedFileResult> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const stats = await stat(filePath);
    return {
      filePath,
      contentHash: createHash('sha256').update(content).digest('hex'),
      lastModifiedAt: Math.floor(stats.mtimeMs),
    };
  } catch (error) {
    // Per-file failure must not sink the batch — the caller skips these,
    // matching the previous inline try/catch-per-file behaviour.
    return { filePath, error: error instanceof Error ? error.message : String(error) };
  }
}

parentPort.on('message', (request: WorkerRequest | WorkerScanRequest) => {
  void (async () => {
    if ('scan' in request) {
      // The walk stats every candidate in the workspace (16k files on a large
      // repo, seconds of main-process work per reconnect); only metadata returns.
      parentPort?.postMessage({ id: request.id, results: await scanProjectSyncCandidatesInline(request.scan) });
      return;
    }
    const results: HashedFileResult[] = [];
    for (const filePath of request.files) {
      results.push(await hashFile(filePath));
    }
    parentPort?.postMessage({ id: request.id, results });
  })();
});
