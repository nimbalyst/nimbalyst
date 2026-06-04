/**
 * PullRequestPollScheduler - background polling for the PR review panel.
 *
 * Single process-wide singleton that owns one timer per
 * (workspacePath, remote) pair. Cadence is:
 *
 *   * 60s when the workspace is in the foreground set (PR review panel is
 *     mounted and the window has focus)
 *   * 5min otherwise
 *
 * The scheduler holds no PR rows in memory — it writes to PullRequestsStore
 * via GhApiService and then broadcasts `pr:list-updated` so the renderer
 * re-reads from cache. State is restart-safe by construction.
 *
 * Cadence transitions (foreground <-> background) re-plan the timer
 * immediately.
 *
 * The `GhApiService` is the only thing that knows how to talk to GitHub;
 * we never invoke `gh` directly here.
 */

import { BrowserWindow } from 'electron';
import log from 'electron-log/main';
import type { GhApiService } from './GhApiService';

const logger = log.scope('PullRequestPollScheduler');

const FOREGROUND_INTERVAL_MS = 60_000;
const BACKGROUND_INTERVAL_MS = 5 * 60_000;

interface WorkspaceEntry {
  workspaceId: string;
  remote: string;
  timer: NodeJS.Timeout;
  intervalMs: number;
  inFlight: boolean;
}

export class PullRequestPollScheduler {
  private readonly entries = new Map<string, WorkspaceEntry>();
  private readonly foregroundWorkspaces = new Set<string>();
  private stopped = false;

  constructor(private readonly service: GhApiService) {}

  /**
   * Start polling a workspace for a given remote. If the workspace is already
   * tracked, the remote is updated and the timer is left alone.
   */
  start(workspacePath: string, workspaceId: string, remote: string): void {
    if (this.stopped) {
      logger.warn('Ignoring start() on stopped scheduler', { workspacePath });
      return;
    }

    const existing = this.entries.get(workspacePath);
    if (existing) {
      if (existing.remote === remote) {
        return;
      }
      // Remote changed — re-arm with the new remote.
      existing.remote = remote;
      existing.workspaceId = workspaceId;
      return;
    }

    const intervalMs = this.intervalFor(workspacePath);
    const timer = setInterval(() => {
      void this.tick(workspacePath);
    }, intervalMs);

    this.entries.set(workspacePath, {
      workspaceId,
      remote,
      timer,
      intervalMs,
      inFlight: false,
    });

    logger.info('Started polling', { workspacePath, remote, intervalMs });
  }

  stop(workspacePath: string): void {
    const entry = this.entries.get(workspacePath);
    if (!entry) return;
    clearInterval(entry.timer);
    this.entries.delete(workspacePath);
    logger.info('Stopped polling', { workspacePath });
  }

  stopAll(): void {
    this.stopped = true;
    for (const [workspacePath, entry] of this.entries) {
      clearInterval(entry.timer);
      logger.info('Stopped polling (shutdown)', { workspacePath });
    }
    this.entries.clear();
    this.foregroundWorkspaces.clear();
  }

  /**
   * Mark a workspace as foreground or background. Re-plans the timer if the
   * cadence changes.
   */
  setFocus(workspacePath: string, focused: boolean): void {
    if (focused) {
      this.foregroundWorkspaces.add(workspacePath);
    } else {
      this.foregroundWorkspaces.delete(workspacePath);
    }

    const entry = this.entries.get(workspacePath);
    if (!entry) return;

    const desired = this.intervalFor(workspacePath);
    if (desired === entry.intervalMs) return;

    clearInterval(entry.timer);
    entry.intervalMs = desired;
    entry.timer = setInterval(() => {
      void this.tick(workspacePath);
    }, desired);
    logger.info('Re-planned poll cadence', { workspacePath, intervalMs: desired });
  }

  /**
   * Trigger an immediate one-shot poll for a workspace, in addition to its
   * scheduled cadence. Used when the PR mode first opens so the user doesn't
   * stare at a blank list while waiting for the next tick.
   */
  async pollNow(workspacePath: string): Promise<void> {
    const entry = this.entries.get(workspacePath);
    if (!entry) return;
    await this.runOnce(workspacePath, entry);
  }

  private intervalFor(workspacePath: string): number {
    return this.foregroundWorkspaces.has(workspacePath)
      ? FOREGROUND_INTERVAL_MS
      : BACKGROUND_INTERVAL_MS;
  }

  private async tick(workspacePath: string): Promise<void> {
    const entry = this.entries.get(workspacePath);
    if (!entry || this.stopped) return;
    await this.runOnce(workspacePath, entry);
  }

  private async runOnce(workspacePath: string, entry: WorkspaceEntry): Promise<void> {
    if (entry.inFlight) {
      // A previous tick is still running — skip rather than queue.
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      // No windows means no consumer; skip the poll.
      return;
    }

    entry.inFlight = true;
    try {
      await this.service.listPullRequests(entry.workspaceId, entry.remote, { state: 'open' });
      this.broadcastListUpdated(workspacePath, entry.remote);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown';
      logger.warn('Poll tick failed', { workspacePath, remote: entry.remote, message });
    } finally {
      entry.inFlight = false;
    }
  }

  private broadcastListUpdated(workspacePath: string, remote: string): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('pr:list-updated', { workspacePath, remote });
      }
    }
  }
}

let instance: PullRequestPollScheduler | null = null;

export function initPullRequestPollScheduler(service: GhApiService): PullRequestPollScheduler {
  if (instance) return instance;
  instance = new PullRequestPollScheduler(service);
  return instance;
}

export function getPullRequestPollScheduler(): PullRequestPollScheduler | null {
  return instance;
}
