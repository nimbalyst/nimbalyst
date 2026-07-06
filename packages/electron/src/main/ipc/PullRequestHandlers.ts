/**
 * PullRequestHandlers - IPC handlers for the integrated PR review panel.
 *
 * Covers:
 *   * `gh` CLI status probes (`pr:gh-status`, `pr:gh-refresh-status`)
 *   * Git remote detection (`pr:detect-remote`)
 *   * PR cache reads + GitHub fetches via `gh api`:
 *     `pr:list`, `pr:get`, `pr:files`, `pr:file-contents`,
 *     `pr:commits`, `pr:checks`, `pr:conversation`, `pr:refresh`
 *
 * All GitHub authentication is delegated to the `gh` CLI; Nimbalyst never
 * holds a GitHub token.
 */

import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import simpleGit from 'simple-git';
import log from 'electron-log/main';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { ghCliDetector, type GhCliStatus } from '../services/GhCliDetector';
import {
  GhApiService,
  GhApiError,
  type ListFilters,
  type TimelineEntry,
  type MergeMethod,
  type ReviewThreadsResult,
} from '../services/GhApiService';
import { createPullRequestsStore, type PullRequestsStore } from '../services/PullRequestsStore';
import { computePrPermissions, type PrPermissions } from '../services/prPermissions';
import { GitStatusService } from '../services/GitStatusService';
import { GitWorktreeService } from '../services/GitWorktreeService';
import { createWorktreeStore, type Worktree } from '../services/WorktreeStore';
import { gitOperationLock } from '../services/GitOperationLock';
import { gitRefWatcher } from '../file/GitRefWatcher';
import { getDatabase } from '../database/initialize';
import {
  getEffectiveGhAccount,
  getPrReviewDefaultGhAccount,
  setPrReviewDefaultGhAccount,
  getPrReviewGhAccountOverride,
  savePrReviewGhAccountOverride,
} from '../utils/store';
import {
  initPullRequestPollScheduler,
  type PullRequestPollScheduler,
} from '../services/PullRequestPollScheduler';
import { applyPrMergeToTrackers } from '../services/PrTrackerLifecycle';
import type {
  PullRequestRow,
  PullRequestFileRow,
  PullRequestCommitRow,
  PullRequestCheckRow,
} from '../services/PullRequestsStore';

const logger = log.scope('PullRequestHandlers');

interface IPCResponse<T> {
  success: boolean;
  error?: string;
  data?: T;
}

function errorResponse(error: unknown): IPCResponse<never> {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return { success: false, error: message };
}

function ghErrorResponse(error: unknown): IPCResponse<never> {
  if (error instanceof GhApiError) {
    const stderr = error.stderr.trim();
    // A 404 on a repo endpoint almost always means the *active* gh account
    // can't see the repo (private repo + wrong account, e.g. an EMU), not
    // that the repo is missing. Point the user at the likely fix.
    if (/Not Found|HTTP 404/i.test(stderr)) {
      return {
        success: false,
        error:
          'Repository not found, or the active GitHub CLI account cannot access it. ' +
          'Check `gh auth status` and switch accounts with `gh auth switch` if needed.',
      };
    }
    return {
      success: false,
      error: `${error.message}: ${stderr || `exit ${error.exitCode}`}`,
    };
  }
  return errorResponse(error);
}

let cachedStore: PullRequestsStore | null = null;
let cachedService: GhApiService | null = null;
let cachedScheduler: PullRequestPollScheduler | null = null;
const gitStatusService = new GitStatusService();
const gitWorktreeService = new GitWorktreeService();

/** Broadcast that a workspace's worktree list changed (e.g. a PR worktree was created). */
function emitWorktreeListChanged(workspacePath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('git:status-changed', { workspacePath });
    }
  }
}

/** Broadcast that a workspace's PR list changed (e.g. a PR was merged). */
function emitPrListUpdated(workspacePath: string, remote: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('pr:list-updated', { workspacePath, remote });
    }
  }
}


/** Resolve the PR's web URL from cache, falling back to a constructed github.com URL. */
function resolvePrUrl(cached: PullRequestRow | null, remote: string, number: number): string {
  const raw = cached?.raw as { html_url?: unknown } | undefined;
  if (raw && typeof raw.html_url === 'string') return raw.html_url;
  return `https://github.com/${remote}/pull/${number}`;
}

function getStore(): PullRequestsStore {
  if (cachedStore) return cachedStore;
  const db = getDatabase();
  if (!db) {
    throw new Error('Database not initialized');
  }
  cachedStore = createPullRequestsStore(db);
  return cachedStore;
}

function getService(): GhApiService {
  if (cachedService) return cachedService;
  // The resolver maps a workspace to its effective gh account (per-project
  // override ?? global default). GhApiService turns that login into a token
  // from gh's keyring per request; Nimbalyst stores only the login.
  cachedService = new GhApiService(getStore(), (workspaceId) =>
    getEffectiveGhAccount(workspaceId),
  );
  return cachedService;
}

function getScheduler(): PullRequestPollScheduler {
  if (cachedScheduler) return cachedScheduler;
  cachedScheduler = initPullRequestPollScheduler(getService());
  return cachedScheduler;
}

export function registerPullRequestHandlers(): void {
  // ----- gh CLI status -----------------------------------------

  safeHandle('pr:gh-status', async (): Promise<IPCResponse<GhCliStatus>> => {
    try {
      const status = await ghCliDetector.getStatus();
      return { success: true, data: status };
    } catch (error: unknown) {
      logger.error('pr:gh-status failed', error);
      return errorResponse(error);
    }
  });

  safeHandle('pr:gh-refresh-status', async (): Promise<IPCResponse<GhCliStatus>> => {
    try {
      ghCliDetector.clearCache();
      const status = await ghCliDetector.getStatus();
      return { success: true, data: status };
    } catch (error: unknown) {
      logger.error('pr:gh-refresh-status failed', error);
      return errorResponse(error);
    }
  });

  // ----- gh account selection (per-project) ------------------

  safeHandle(
    'pr:gh-accounts',
    async (): Promise<IPCResponse<Array<{ login: string; host: string; active: boolean }>>> => {
      try {
        const accounts = await ghCliDetector.listAccounts();
        return { success: true, data: accounts };
      } catch (error: unknown) {
        logger.error('pr:gh-accounts failed', error);
        return errorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:get-account-config',
    async (
      _event,
      workspacePath?: string,
    ): Promise<
      IPCResponse<{ defaultAccount: string | null; override: string | null; effective: string | null }>
    > => {
      try {
        return {
          success: true,
          data: {
            defaultAccount: getPrReviewDefaultGhAccount() ?? null,
            override: workspacePath ? getPrReviewGhAccountOverride(workspacePath) ?? null : null,
            effective: getEffectiveGhAccount(workspacePath) ?? null,
          },
        };
      } catch (error: unknown) {
        logger.error('pr:get-account-config failed', error);
        return errorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:set-default-account',
    async (_event, login: string | null): Promise<IPCResponse<{ ok: boolean }>> => {
      try {
        setPrReviewDefaultGhAccount(login ?? undefined);
        return { success: true, data: { ok: true } };
      } catch (error: unknown) {
        logger.error('pr:set-default-account failed', error);
        return errorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:set-account-override',
    async (
      _event,
      workspacePath: string,
      login: string | null,
    ): Promise<IPCResponse<{ ok: boolean }>> => {
      if (!workspacePath) {
        return { success: false, error: 'workspacePath required' };
      }
      try {
        savePrReviewGhAccountOverride(workspacePath, login ?? undefined);
        return { success: true, data: { ok: true } };
      } catch (error: unknown) {
        logger.error('pr:set-account-override failed', error);
        return errorResponse(error);
      }
    },
  );

  // ----- Remote detection --------------------------------------

  safeHandle(
    'pr:detect-remote',
    async (
      _event,
      workspacePath: string,
    ): Promise<IPCResponse<{ remote: string; host: string } | null>> => {
      if (!workspacePath) {
        return { success: false, error: 'workspacePath required' };
      }
      try {
        const result = await gitStatusService.parseGitHubRemote(workspacePath);
        return { success: true, data: result };
      } catch (error: unknown) {
        logger.error('pr:detect-remote failed', error);
        return errorResponse(error);
      }
    },
  );

  // ----- PR fetch via `gh api` ---------------------------------

  safeHandle(
    'pr:list',
    async (
      _event,
      workspaceId: string,
      remote: string,
      filters: ListFilters = {},
    ): Promise<IPCResponse<PullRequestRow[]>> => {
      if (!workspaceId || !remote) {
        return { success: false, error: 'workspaceId and remote required' };
      }
      try {
        const rows = await getService().listPullRequests(workspaceId, remote, filters);
        return { success: true, data: rows };
      } catch (error: unknown) {
        logger.error('pr:list failed', { remote, error });
        return ghErrorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:get',
    async (
      _event,
      workspaceId: string,
      remote: string,
      number: number,
    ): Promise<IPCResponse<PullRequestRow>> => {
      if (!workspaceId || !remote || !number) {
        return { success: false, error: 'workspaceId, remote, number required' };
      }
      try {
        const row = await getService().getPullRequest(workspaceId, remote, number);
        return { success: true, data: row };
      } catch (error: unknown) {
        logger.error('pr:get failed', { remote, number, error });
        return ghErrorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:files',
    async (
      _event,
      workspaceId: string,
      remote: string,
      number: number,
    ): Promise<IPCResponse<PullRequestFileRow[]>> => {
      if (!workspaceId || !remote || !number) {
        return { success: false, error: 'workspaceId, remote, number required' };
      }
      try {
        const files = await getService().getPullRequestFiles(workspaceId, remote, number);
        return { success: true, data: files };
      } catch (error: unknown) {
        logger.error('pr:files failed', { remote, number, error });
        return ghErrorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:file-contents',
    async (
      _event,
      workspaceId: string,
      remote: string,
      ref: string,
      path: string,
    ): Promise<IPCResponse<{ content: string }>> => {
      if (!workspaceId || !remote || !ref || !path) {
        return { success: false, error: 'workspaceId, remote, ref, path required' };
      }
      try {
        const content = await getService().getFileContents(workspaceId, remote, ref, path);
        return { success: true, data: { content } };
      } catch (error: unknown) {
        logger.error('pr:file-contents failed', { remote, ref, path, error });
        return ghErrorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:commits',
    async (
      _event,
      workspaceId: string,
      remote: string,
      number: number,
    ): Promise<IPCResponse<PullRequestCommitRow[]>> => {
      if (!workspaceId || !remote || !number) {
        return { success: false, error: 'workspaceId, remote, number required' };
      }
      try {
        const commits = await getService().getPullRequestCommits(workspaceId, remote, number);
        return { success: true, data: commits };
      } catch (error: unknown) {
        logger.error('pr:commits failed', { remote, number, error });
        return ghErrorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:checks',
    async (
      _event,
      workspaceId: string,
      remote: string,
      number: number,
    ): Promise<IPCResponse<PullRequestCheckRow[]>> => {
      if (!workspaceId || !remote || !number) {
        return { success: false, error: 'workspaceId, remote, number required' };
      }
      try {
        const checks = await getService().getPullRequestChecks(workspaceId, remote, number);
        return { success: true, data: checks };
      } catch (error: unknown) {
        logger.error('pr:checks failed', { remote, number, error });
        return ghErrorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:conversation',
    async (
      _event,
      workspaceId: string,
      remote: string,
      number: number,
      noCache = false,
    ): Promise<IPCResponse<TimelineEntry[]>> => {
      if (!workspaceId || !remote || !number) {
        return { success: false, error: 'workspaceId, remote, number required' };
      }
      try {
        const timeline = await getService().getConversation(workspaceId, remote, number, { noCache });
        return { success: true, data: timeline };
      } catch (error: unknown) {
        logger.error('pr:conversation failed', { remote, number, error });
        return ghErrorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:review-threads',
    async (
      _event,
      workspaceId: string,
      remote: string,
      number: number,
    ): Promise<IPCResponse<ReviewThreadsResult>> => {
      if (!workspaceId || !remote || !number) {
        return { success: false, error: 'workspaceId, remote, number required' };
      }
      try {
        const data = await getService().getReviewThreads(workspaceId, remote, number);
        return { success: true, data };
      } catch (error: unknown) {
        logger.error('pr:review-threads failed', { remote, number, error });
        return ghErrorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:refresh',
    async (
      _event,
      workspaceId: string,
      remote: string,
      number?: number,
    ): Promise<IPCResponse<{ fetchedAt: number }>> => {
      if (!workspaceId || !remote) {
        return { success: false, error: 'workspaceId and remote required' };
      }
      try {
        const service = getService();
        if (number) {
          await service.getPullRequest(workspaceId, remote, number);
        } else {
          await service.listPullRequests(workspaceId, remote, { state: 'open' });
        }
        return { success: true, data: { fetchedAt: Date.now() } };
      } catch (error: unknown) {
        logger.error('pr:refresh failed', { remote, number, error });
        return ghErrorResponse(error);
      }
    },
  );

  // ----- Review / merge actions + access control ------------

  safeHandle(
    'pr:permissions',
    async (
      _event,
      workspaceId: string,
      remote: string,
      number: number,
    ): Promise<IPCResponse<PrPermissions>> => {
      if (!workspaceId || !remote || !number) {
        return { success: false, error: 'workspaceId, remote, number required' };
      }
      try {
        const service = getService();
        const caps = await service.getRepoCapabilities(workspaceId, remote);

        // Read PR state from cache; fall back to a fetch if not cached yet.
        let pr = await getStore().getByNumber(workspaceId, remote, number);
        if (!pr) {
          pr = await service.getPullRequest(workspaceId, remote, number);
        }
        const raw = pr.raw as { mergeable_state?: unknown } | undefined;
        const mergeableState =
          raw && typeof raw.mergeable_state === 'string' ? raw.mergeable_state : null;
        const mergeable =
          pr.mergeable === 'mergeable' ? true : pr.mergeable === 'conflicting' ? false : null;

        const data = computePrPermissions(caps, {
          state: pr.state,
          isDraft: pr.isDraft,
          authorLogin: pr.authorLogin,
          mergeable,
          mergeableState,
        });
        return { success: true, data };
      } catch (error: unknown) {
        logger.error('pr:permissions failed', { remote, number, error });
        return ghErrorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:approve',
    async (
      _event,
      workspaceId: string,
      remote: string,
      number: number,
      body?: string,
    ): Promise<IPCResponse<{ ok: boolean }>> => {
      if (!workspaceId || !remote || !number) {
        return { success: false, error: 'workspaceId, remote, number required' };
      }
      try {
        const service = getService();
        await service.approvePullRequest(workspaceId, remote, number, body);
        // Refresh detail (cache-bypass) so the new review shows up; surface to
        // other windows.
        await service.getPullRequest(workspaceId, remote, number, { noCache: true });
        emitPrListUpdated(workspaceId, remote);
        return { success: true, data: { ok: true } };
      } catch (error: unknown) {
        logger.error('pr:approve failed', { remote, number, error });
        return ghErrorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:comment',
    async (
      _event,
      workspaceId: string,
      remote: string,
      number: number,
      body: string,
    ): Promise<IPCResponse<{ ok: boolean }>> => {
      if (!workspaceId || !remote || !number || !body?.trim()) {
        return { success: false, error: 'workspaceId, remote, number, body required' };
      }
      try {
        const service = getService();
        await service.commentOnPullRequest(workspaceId, remote, number, body.trim());
        emitPrListUpdated(workspaceId, remote);
        return { success: true, data: { ok: true } };
      } catch (error: unknown) {
        logger.error('pr:comment failed', { remote, number, error });
        return ghErrorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:merge',
    async (
      _event,
      workspaceId: string,
      remote: string,
      number: number,
      method: MergeMethod,
      commitTitle?: string,
      commitMessage?: string,
    ): Promise<IPCResponse<{ merged: boolean; sha: string | null }>> => {
      if (!workspaceId || !remote || !number || !method) {
        return { success: false, error: 'workspaceId, remote, number, method required' };
      }
      try {
        const service = getService();
        const result = await service.mergePullRequest(workspaceId, remote, number, method, {
          commitTitle,
          commitMessage,
        });
        // Re-fetch (cache-bypass) so the PR flips to merged in the cache + UI.
        await service.getPullRequest(workspaceId, remote, number, { noCache: true });
        emitPrListUpdated(workspaceId, remote);
        if (result.merged) {
          // Tracker lifecycle: prMergedStatus-role transition / merge comment
          // on referencing items. Best-effort — a tracker failure must not
          // turn a successful merge into an error.
          applyPrMergeToTrackers(workspaceId, remote, number).catch((err) => {
            logger.error('pr:merge tracker lifecycle failed', { remote, number, error: err });
          });
        }
        return { success: true, data: { merged: result.merged, sha: result.sha } };
      } catch (error: unknown) {
        logger.error('pr:merge failed', { remote, number, method, error });
        return ghErrorResponse(error);
      }
    },
  );

  // ----- Worktree from PR --------------------------------------

  safeHandle(
    'pr:open-worktree',
    async (
      _event,
      workspacePath: string,
      remote: string,
      number: number,
    ): Promise<IPCResponse<Worktree>> => {
      if (!workspacePath || !remote || !number) {
        return { success: false, error: 'workspacePath, remote, number required' };
      }
      try {
        const db = getDatabase();
        if (!db) {
          throw new Error('Database not initialized');
        }
        const worktreeStore = createWorktreeStore(db);

        // Idempotent: reuse an existing worktree bound to this PR if its dir
        // still exists on disk.
        const existing = await worktreeStore.findByPullRequest(workspacePath, remote, number);
        if (existing && fs.existsSync(existing.path)) {
          logger.info('Reusing existing PR worktree', { id: existing.id, number });
          return { success: true, data: existing };
        }

        // Fetch the PR head into a unique local branch. Done in its own lock,
        // released before createWorktree acquires its own (avoids re-entrancy).
        const branchName = await gitOperationLock.withLock(
          workspacePath,
          'pr-fetch',
          async () => {
            const git = simpleGit(workspacePath);
            const local = await git.branchLocal();
            let candidate = `pr-${number}`;
            let suffix = 2;
            while (local.all.includes(candidate)) {
              candidate = `pr-${number}-${suffix}`;
              suffix += 1;
            }
            await git.fetch('origin', `pull/${number}/head:${candidate}`);
            return candidate;
          },
        );

        // Create the worktree on a branch based off the fetched PR head, then
        // persist + start the ref watcher (mirrors worktree:create).
        const worktree = await gitWorktreeService.createWorktree(workspacePath, {
          name: `pr-${number}`,
          baseBranch: branchName,
        });
        await worktreeStore.create(worktree);
        gitRefWatcher.start(worktree.path).catch((err) => {
          logger.error('Failed to start GitRefWatcher for PR worktree:', err);
        });

        // Link the worktree to the PR for idempotency + future badge display.
        const cached = await getStore().getByNumber(workspacePath, remote, number);
        const prUrl = resolvePrUrl(cached, remote, number);
        await worktreeStore.linkPullRequest(worktree.id, {
          prNumber: number,
          prRemote: remote,
          prUrl,
        });

        emitWorktreeListChanged(workspacePath);

        const linked = await worktreeStore.get(worktree.id);
        return { success: true, data: linked ?? worktree };
      } catch (error: unknown) {
        logger.error('pr:open-worktree failed', { remote, number, error });
        return errorResponse(error);
      }
    },
  );

  // ----- Poll scheduler ----------------------------------------

  safeHandle(
    'pr:start-polling',
    async (
      _event,
      workspacePath: string,
      workspaceId: string,
      remote: string,
    ): Promise<IPCResponse<{ started: boolean }>> => {
      if (!workspacePath || !workspaceId || !remote) {
        return { success: false, error: 'workspacePath, workspaceId, remote required' };
      }
      try {
        getScheduler().start(workspacePath, workspaceId, remote);
        return { success: true, data: { started: true } };
      } catch (error: unknown) {
        logger.error('pr:start-polling failed', { workspacePath, remote, error });
        return errorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:stop-polling',
    async (_event, workspacePath: string): Promise<IPCResponse<{ stopped: boolean }>> => {
      if (!workspacePath) {
        return { success: false, error: 'workspacePath required' };
      }
      try {
        getScheduler().stop(workspacePath);
        return { success: true, data: { stopped: true } };
      } catch (error: unknown) {
        logger.error('pr:stop-polling failed', { workspacePath, error });
        return errorResponse(error);
      }
    },
  );

  safeHandle(
    'pr:poll-now',
    async (_event, workspacePath: string): Promise<IPCResponse<{ ok: boolean }>> => {
      if (!workspacePath) {
        return { success: false, error: 'workspacePath required' };
      }
      try {
        await getScheduler().pollNow(workspacePath);
        return { success: true, data: { ok: true } };
      } catch (error: unknown) {
        logger.error('pr:poll-now failed', { workspacePath, error });
        return errorResponse(error);
      }
    },
  );

  safeOn('pr:focus', (_event, payload: { workspacePath: string; focused: boolean } | undefined) => {
    if (!payload || typeof payload.workspacePath !== 'string') {
      logger.warn('pr:focus received invalid payload', { payload });
      return;
    }
    try {
      getScheduler().setFocus(payload.workspacePath, Boolean(payload.focused));
    } catch (error: unknown) {
      logger.warn('pr:focus failed', error);
    }
  });
}

/**
 * Tear down the poll scheduler. Called from main `app.on('will-quit', ...)`
 * to clear all timers before the process exits.
 */
export function stopPullRequestPollScheduler(): void {
  if (cachedScheduler) {
    cachedScheduler.stopAll();
    cachedScheduler = null;
  }
}
