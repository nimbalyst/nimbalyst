import { app } from 'electron';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { SessionFilesRepository } from '@nimbalyst/runtime/storage/repositories/SessionFilesRepository';
import { OpenAICodexProvider } from '@nimbalyst/runtime/ai/server';
import { agentToolActivity } from '@nimbalyst/runtime/ai/server/agentToolActivity';
import { subscribe, unsubscribe, getSubscriberIds, drainWorkspaceEvents } from '../../file/WorkspaceEventBus';
import { contentFingerprint, isKnownFileWrite } from '../../file/knownFileWrites';
import { getPackageRoot } from '../../utils/appPaths';
import { shouldExcludePath } from '../../utils/fileFilters';
import { workspaceFileAttributionPolicy } from '../WorkspaceFileAttributionPolicy';
import { sessionEditQuota } from '../SessionEditQuota';
import { workspaceAttributionThrottle } from '../WorkspaceAttributionThrottle';
import { notifySessionFilesUpdated } from '../sessionFilesNotify';
import { logger } from '../../utils/logger';
import { ExcludedShellCandidate, ShellFileAttribution, type ShellFileEvidence, type ShellPersistContext } from './ShellFileAttribution';
import { historyManager } from '../../HistoryManager';
import { recordClaudeShellAttributedFile } from '@nimbalyst/runtime/ai/server/claudeShellTracking';
import { shellBeforeContentLedger } from './shellBeforeContentLedger';
import { prepareShellCheckoutBaseline } from './ShellCheckoutBaseline';
import { ShellTrackingCoverage } from './ShellTrackingCoverage';
import { createShellCoverageStore } from './shellCoverageStore';
import { database } from '../../database/PGLiteDatabaseWorker';

export const shellTrackingCoverage = new ShellTrackingCoverage({
  ...createShellCoverageStore(database),
  notify: notifySessionFilesUpdated,
});
export async function getShellTrackingCoverage(sessionIds: string[], drain = false) {
  if (
    !Array.isArray(sessionIds) ||
    sessionIds.length > 256 ||
    sessionIds.some((id) => typeof id !== 'string' || id.length > 256)
  )
    throw new Error('Invalid coverage scope');
  if (drain) {
    await shellFileAttribution.drain(sessionIds);
    if (!(await shellTrackingCoverage.flush(sessionIds))) {
      await Promise.all(
        sessionIds.map((id) => shellTrackingCoverage.reportSession(id, 'coveragePersistence'))
      );
    }
  }
  return shellTrackingCoverage.readMany(sessionIds);
}

export const shellFileAttribution = new ShellFileAttribution({
  subscribe: async (workspace, changed) => {
    const id = 'shell-hooks:' + workspace;
    // A watcher still running its first scan (`starting` once subscribe
    // returns) already delivers events; it becomes `watching` when ready.
    let available = false;
    await subscribe(workspace, id, {
      onAdd: () => {},
      onChange: () => {},
      onUnlink: () => {},
      onObserved: (_event, file, at) => changed(file, at),
      onHealthChanged: (health) => {
        available = health.state === 'watching' || health.state === 'starting';
        if (health.state === 'recovering') shellFileAttribution.watcherLost(workspace);
        if (health.state === 'watching') shellFileAttribution.watcherRecovered(workspace);
      },
    });
    if (!available || !getSubscriberIds(workspace).includes(id)) {
      unsubscribe(workspace, id);
      throw new Error('Workspace watcher unavailable');
    }
    return () => unsubscribe(workspace, id);
  },
  prepareCheckout: prepareShellCheckoutBaseline,
  activity: (generation, id, active) => shellTrackingCoverage.tool(generation, id, active),
  drainEvents: drainWorkspaceEvents,
  observation: (generation, healthy) => shellTrackingCoverage.observation(generation, healthy),
  read: async (file) => {
    if (shouldExcludePath(file)) throw new ExcludedShellCandidate('Excluded path');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 1_000_000) throw new ExcludedShellCandidate('Unsupported candidate');
      const content = await fs.readFile(file);
      return {
        fingerprint: contentFingerprint(content),
        modifiedAt: stat.mtimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  knownWrite: (file, state) => isKnownFileWrite(file, state?.fingerprint),
  // Sessions with a running turn, plus any whose reported tools are still live
  // (a backgrounded command can outlive the watcher that marks the turn).
  otherSessions: (workspace, filePath, observedAt) => [
    ...workspaceFileAttributionPolicy.getSessionIds(workspace, filePath),
    ...agentToolActivity.activeSessions(filePath, observedAt),
  ],
  otherWriter: (sessionId, filePath, observedAt) => agentToolActivity.writerEvidence(sessionId, filePath, observedAt),
  report: (generation, reason, turnId, toolUseId, hook) => shellTrackingCoverage.record(generation, reason, turnId, toolUseId, hook),
  currentTurn: (generation) => shellTrackingCoverage.currentTurn(generation),
  persist: async (evidence, context) => {
    // Per session: one session's build output must not spend another's budget.
    // Excluded paths never reach here (`read` rejects them first).
    if (!workspaceAttributionThrottle.tryAcquire('session:' + evidence.sessionId)) return 'throttled';
    if (!(await sessionEditQuota.tryReserve(evidence.sessionId, evidence.filePath))) return 'quota';
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
        attribution: {
          kind: 'inferred',
          method: 'shell-hook-window',
          fileTimestamp: evidence.timestamp,
        },
      },
    });
    await tagShellBaseline(evidence, context);
    recordClaudeShellAttributedFile(evidence.sessionId, evidence.filePath);
    notifySessionFilesUpdated(evidence.sessionId);
    return 'persisted';
  },
});

/**
 * Pending-review baseline for a shell-attributed file, so its diff has a
 * "before". Exact for files that were tracked and clean when the window
 * opened (the pinned revision's blob); for files already dirty, the content
 * the session's own watcher held just before the window's first change. No
 * baseline means no tag, the same as a new file. Never fails the link.
 */
async function tagShellBaseline(evidence: ShellFileEvidence, context: ShellPersistContext | undefined): Promise<void> {
  if (!context) return;
  try {
    const pending = await historyManager.getPendingTags(evidence.filePath);
    // An earlier Edit/Write or command in this session already holds the baseline.
    if (pending?.some((tag) => tag.sessionId === evidence.sessionId)) return;
    // In a Git checkout the window-start fingerprint decides; a ledger entry
    // that does not match it (committed-blob fallback, an evicted or earlier
    // change) gives no tag rather than a wrong one.
    const before = context.checkout
      ? await context.checkout.baselineContent?.(evidence.filePath, shellBeforeContentLedger.observed(evidence.sessionId, evidence.filePath))
      : shellBeforeContentLedger.beforeWindow(evidence.sessionId, evidence.filePath, context.windowStart);
    if (before === undefined) return;
    await historyManager.createTag(
      evidence.workspacePath,
      evidence.filePath,
      `ai-edit-pending-${evidence.sessionId}-${evidence.toolUseId}`,
      before,
      evidence.sessionId,
      evidence.toolUseId,
      // Inferred from a hook window, not observed at the write; an
      // authoritative writer may replace it.
      { speculative: true },
    );
  } catch (error) {
    logger.main.warn('[ShellTracking] Baseline tag failed:', error);
  }
}

/** One loopback endpoint per owned Codex process; no port-wide cleanup. */
export async function prepareShellTracking(sessionId: string, workspace: string) {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'codex-shell-hook.cjs')
    : path.join(getPackageRoot(), 'resources', 'codex-shell-hook.cjs');
  if (!existsSync(script)) {
    await shellTrackingCoverage.unavailable(sessionId);
    return undefined;
  }
  const generation = await shellFileAttribution.register(sessionId, workspace),
    token = randomBytes(24).toString('hex');
  await shellTrackingCoverage.open(sessionId, generation);
  let disposed = false;
  const server = http.createServer(async (req, res) => {
    if (disposed || req.method !== 'POST' || req.url !== '/' + token) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    let bytes = 0;
    try {
      for await (const chunk of req) {
        raw += chunk;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8192) {
          res.writeHead(413).end();
          return;
        }
      }
      const p = JSON.parse(raw);
      if (typeof p.id !== 'string' || p.id.length > 256 || typeof p.tool !== 'string' || p.tool.length > 256)
        throw new Error('Invalid hook identity');
      for (const field of ['session_id', 'turn_id', 'agent_type'])
        if (p[field] !== undefined && (typeof p[field] !== 'string' || p[field].length > 256))
          throw new Error('Invalid hook context');
      const identity = { sessionId: p.session_id, turnId: p.turn_id, agentType: p.agent_type };
      // Off by default; the real-Codex E2E and manual hook tracing set this.
      if (process.env.NIMBALYST_SHELL_HOOK_TRACE)
        logger.main.debug('[CodexShellTracking] Hook', JSON.stringify({
          sessionId, event: p.event, tool: p.tool, toolUseId: p.id, hookSessionId: p.session_id,
          hookTurnId: p.turn_id, currentTurnId: shellTrackingCoverage.currentTurn(generation), agentType: p.agent_type,
        }));
      if (p.event === 'PreToolUse') await shellFileAttribution.pre(generation, p.id, p.tool, identity);
      else if (p.event === 'PostToolUse') await shellFileAttribution.post(generation, p.id, { ...identity, tool: p.tool });
      else throw new Error('Unsupported event');
      res.end('{}');
    } catch {
      shellTrackingCoverage.record(generation, 'hookFailure');
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
    await shellTrackingCoverage.close(generation);
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
    env: {
      NIMBALYST_SHELL_HOOK_URL: `http://127.0.0.1:${address.port}/${token}`,
    },
    toolStarted: (id: string, kind: 'shell' | 'patch' | 'mcp') => shellFileAttribution.started(generation, id, kind),
    turnStarted: (id: string) => shellTrackingCoverage.turn(generation, id),
    unavailable: () => {
      void shellTrackingCoverage.unavailable(sessionId);
    },
    toolCompleted: (id: string) => {
      void shellFileAttribution.completed(generation, id);
    },
    endTurn: () => {
      const turnId = shellTrackingCoverage.currentTurn(generation);
      shellFileAttribution.endTurn(generation);
      // Keep queued event diagnostics associated with their original turn.
      void shellFileAttribution.drain([sessionId]).then(() => {
        if (turnId) shellTrackingCoverage.endTurn(generation, turnId);
        return shellTrackingCoverage.flush([sessionId]);
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      server.close();
      void shellFileAttribution
        .release(generation)
        .then(() => shellTrackingCoverage.close(generation))
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
      await shellTrackingCoverage.unavailable(session);
      return undefined;
    }
  });
}
