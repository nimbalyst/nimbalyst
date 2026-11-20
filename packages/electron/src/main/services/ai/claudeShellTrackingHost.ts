import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setClaudeShellTrackingSink } from '@nimbalyst/runtime/ai/server/claudeShellTracking';
import { logger } from '../../utils/logger';
import { shellFileAttribution, shellTrackingCoverage } from './codexShellTrackingHost';
import { shellBeforeContentLedger } from './shellBeforeContentLedger';

/**
 * Drives the shared `ShellFileAttribution` tracker from Claude Code's
 * in-process Bash hooks. Same tracker, coverage store and persistence as
 * Codex shell commands; only the hook transport differs.
 *
 * Registration follows the session's watcher lifecycle
 * (`HooklessAgentFileWatcher` in `'shell-window'` mode), not the provider's,
 * because the provider instance does not know when the host stops watching.
 */
interface Registration {
  generation: Promise<string | undefined>;
  /** Set once registration resolves, so turn end can act synchronously. */
  resolvedGeneration?: string;
  workspace: string;
  turnId?: string;
}

const registrations = new Map<string, Registration>();

function resolved(sessionId: string): Promise<{ registration: Registration; generation: string } | undefined> {
  const registration = registrations.get(sessionId);
  if (!registration) return Promise.resolve(undefined);
  return registration.generation.then((generation) =>
    generation && registrations.get(sessionId) === registration ? { registration, generation } : undefined
  );
}

export async function registerClaudeShellSession(sessionId: string, workspacePath: string): Promise<void> {
  const workspace = path.resolve(workspacePath);
  const existing = registrations.get(sessionId);
  if (existing?.workspace === workspace) {
    await existing.generation;
    return;
  }
  if (existing) await releaseClaudeShellSession(sessionId);
  const registration: Registration = { workspace, generation: Promise.resolve(undefined) };
  registration.generation = (async () => {
    try {
      const generation = await shellFileAttribution.register(sessionId, workspace);
      await shellTrackingCoverage.open(sessionId, generation);
      registration.resolvedGeneration = generation;
      return generation;
    } catch (error) {
      logger.main.warn('[ClaudeShellTracking] Observation unavailable:', error);
      await shellTrackingCoverage.unavailable(sessionId);
      return undefined;
    }
  })();
  registrations.set(sessionId, registration);
  if (!(await registration.generation) && registrations.get(sessionId) === registration) registrations.delete(sessionId);
}

export async function releaseClaudeShellSession(sessionId: string): Promise<void> {
  const registration = registrations.get(sessionId);
  if (!registration) return;
  registrations.delete(sessionId);
  shellBeforeContentLedger.clear(sessionId);
  const generation = await registration.generation;
  if (!generation) return;
  try {
    await shellFileAttribution.release(generation);
    await shellTrackingCoverage.close(generation);
  } catch (error) {
    logger.main.warn('[ClaudeShellTracking] Cleanup failed:', error);
  }
}

export function isClaudeShellSessionRegistered(sessionId: string): boolean {
  return registrations.has(sessionId);
}

/**
 * Ends the turn synchronously: windows close and the coverage turn clears
 * before this returns, so a pre hook still capturing its baseline fails the
 * tracker's turn check instead of installing a window into an ended turn.
 * The returned promise settles once closing windows have persisted.
 */
function endTurn(sessionId: string): Promise<void> {
  const registration = registrations.get(sessionId);
  const generation = registration?.resolvedGeneration;
  if (!registration || !generation) return Promise.resolve();
  const turnId = registration.turnId;
  registration.turnId = undefined;
  shellFileAttribution.endTurn(generation);
  if (turnId) shellTrackingCoverage.endTurn(generation, turnId);
  return shellFileAttribution.drain([sessionId])
    .then(() => shellTrackingCoverage.flush([sessionId]))
    .then(() => {}, (error) => logger.main.warn('[ClaudeShellTracking] Turn end failed:', error));
}

export function configureClaudeShellTracking(): void {
  setClaudeShellTrackingSink({
    isTracking: (sessionId) => registrations.has(sessionId),
    async pre(sessionId, toolUseId) {
      const entry = await resolved(sessionId);
      if (!entry) return;
      // Claude reports no turn ids to its hooks; a turn begins at its first command.
      if (!entry.registration.turnId) {
        entry.registration.turnId = randomUUID();
        shellTrackingCoverage.turn(entry.generation, entry.registration.turnId);
      }
      // The turn id lets the tracker drop this window if the turn ends while
      // the baseline is still being captured. No agentType: subagent Bash runs
      // through the parent's hooks and is the parent's edit.
      await shellFileAttribution.pre(entry.generation, toolUseId, 'Bash', { turnId: entry.registration.turnId });
    },
    async post(sessionId, toolUseId) {
      const entry = await resolved(sessionId);
      if (entry) await shellFileAttribution.post(entry.generation, toolUseId);
    },
    endTurn,
    async drain(sessionId) {
      if (registrations.has(sessionId)) await shellFileAttribution.drain([sessionId], 1500, false);
    },
  });
}
