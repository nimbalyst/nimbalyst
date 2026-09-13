import { app } from 'electron';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { SessionFilesRepository } from '@nimbalyst/runtime';
import { OpenAICodexProvider } from '@nimbalyst/runtime/ai/server';
import { subscribe, unsubscribe, getSubscriberIds } from '../../file/WorkspaceEventBus';
import { contentFingerprint, isKnownFileWrite } from '../../file/knownFileWrites';
import { getPackageRoot } from '../../utils/appPaths';
import { shouldExcludePath } from '../../utils/fileFilters';
import { workspaceFileAttributionPolicy } from '../WorkspaceFileAttributionPolicy';
import { sessionEditQuota } from '../SessionEditQuota';
import { workspaceAttributionThrottle } from '../WorkspaceAttributionThrottle';
import { notifySessionFilesUpdated } from '../sessionFilesNotify';
import { logger } from '../../utils/logger';
import { ShellFileAttribution } from './ShellFileAttribution';

export const shellFileAttribution = new ShellFileAttribution({
  subscribe: async (workspace, changed) => {
    const id = 'shell-hooks:' + workspace;
    await subscribe(workspace, id, { onAdd: changed, onChange: changed, onUnlink: changed });
    if (!getSubscriberIds(workspace).includes(id)) throw new Error('Workspace watcher unavailable');
    return () => unsubscribe(workspace, id);
  },
  read: async (file) => {
    if (shouldExcludePath(file)) throw new Error('Excluded path');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 1_000_000) throw new Error('Unsupported candidate');
      const content = await fs.readFile(file);
      return { fingerprint: contentFingerprint(content), modifiedAt: stat.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  knownWrite: (file, state) => isKnownFileWrite(file, state?.fingerprint),
  otherSessions: (workspace, filePath) => workspaceFileAttributionPolicy.getSessionIds(workspace, filePath),
  persist: async (evidence) => {
    if (
      !workspaceAttributionThrottle.tryAcquire(evidence.workspacePath) ||
      !(await sessionEditQuota.tryReserve(evidence.sessionId, evidence.filePath))
    )
      return;
    await SessionFilesRepository.addFileLink({
      sessionId: evidence.sessionId,
      workspaceId: evidence.workspacePath,
      filePath: evidence.filePath,
      linkType: 'edited',
      timestamp: evidence.timestamp,
      metadata: {
        toolName: 'Bash',
        operation: 'bash',
        toolUseId: evidence.toolUseId,
        source: evidence.source,
        attribution: { kind: 'inferred', method: 'shell-hook-window', fileTimestamp: evidence.timestamp },
      },
    });
    notifySessionFilesUpdated(evidence.sessionId);
  },
});

/** One loopback endpoint per owned Codex process; no port-wide cleanup. */
export async function prepareShellTracking(sessionId: string, workspace: string) {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'codex-shell-hook.cjs')
    : path.join(getPackageRoot(), 'resources', 'codex-shell-hook.cjs');
  if (!existsSync(script)) return undefined;
  const generation = await shellFileAttribution.register(sessionId, workspace),
    token = randomBytes(24).toString('hex');
  let disposed = false;
  let lastReported = shellFileAttribution.getStats();
  const server = http.createServer(async (req, res) => {
    if (disposed || req.method !== 'POST' || req.url !== '/' + token) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4096) {
          res.writeHead(413).end();
          return;
        }
      }
      const p = JSON.parse(raw);
      if (typeof p.id !== 'string' || p.id.length > 256 || typeof p.tool !== 'string' || p.tool.length > 256)
        throw new Error('Invalid hook identity');
      if (p.event === 'PreToolUse') await shellFileAttribution.pre(generation, p.id, p.tool);
      else if (p.event === 'PostToolUse') await shellFileAttribution.post(generation, p.id);
      else throw new Error('Unsupported event');
      res.end('{}');
    } catch {
      res.writeHead(400).end();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (error) {
    await shellFileAttribution.release(generation);
    throw error;
  }
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  return {
    // Scope Electron-as-Node to the hook; normal agent commands inherit their
    // original environment (including commands that launch Electron apps).
    command:
      (process.platform === 'win32' ? 'set "ELECTRON_RUN_AS_NODE=1" && ' : 'env ELECTRON_RUN_AS_NODE=1 ') +
      [process.execPath, script]
        .map((value) => (process.platform === 'win32' ? `"${value}"` : `'${value.replace(/'/g, `'"'"'`)}'`))
        .join(' '),
    env: { NIMBALYST_SHELL_HOOK_URL: `http://127.0.0.1:${address.port}/${token}` },
    endTurn: () => {
      shellFileAttribution.endTurn(generation);
      const stats = shellFileAttribution.getStats();
      if (stats.ambiguous !== lastReported.ambiguous || stats.overflow !== lastReported.overflow) {
        logger.main.warn('[CodexShellTracking] Inference coverage incomplete (host-wide counters):', stats);
        lastReported = stats;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      server.close();
      void shellFileAttribution
        .release(generation)
        .catch((error) => logger.main.warn('[CodexShellTracking] Cleanup failed:', error));
    },
  };
}
export function configureCodexShellTracking(): void {
  OpenAICodexProvider.setShellTrackingHost(async (session, workspace) => {
    try {
      return await prepareShellTracking(session, workspace);
    } catch (error) {
      logger.main.warn('[CodexShellTracking] Observation unavailable:', error);
      return undefined;
    }
  });
}
