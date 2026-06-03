/**
 * PullRequestHandlers - IPC handlers for the integrated PR review panel.
 *
 * Phases A-C of issue #307. Covers:
 *   * `gh` CLI status probes (`pr:gh-status`, `pr:gh-refresh-status`)
 *   * Git remote detection (`pr:detect-remote`)
 *   * PR cache reads + GitHub fetches via `gh api`:
 *     `pr:list`, `pr:get`, `pr:files`, `pr:file-contents`,
 *     `pr:commits`, `pr:checks`, `pr:conversation`, `pr:refresh`
 *
 * All GitHub authentication is delegated to the `gh` CLI; Nimbalyst never
 * holds a GitHub token.
 *
 * Phase H (worktree linkage) and Phase D (polling scheduler) layer on top
 * of these channels in later commits.
 */

import log from 'electron-log/main';
import { safeHandle } from '../utils/ipcRegistry';
import { ghCliDetector, type GhCliStatus } from '../services/GhCliDetector';
import {
  GhApiService,
  GhApiError,
  type ListFilters,
  type TimelineEntry,
} from '../services/GhApiService';
import { createPullRequestsStore, type PullRequestsStore } from '../services/PullRequestsStore';
import { GitStatusService } from '../services/GitStatusService';
import { getDatabase } from '../database/initialize';
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
    return {
      success: false,
      error: `${error.message}: ${error.stderr.trim() || `exit ${error.exitCode}`}`,
    };
  }
  return errorResponse(error);
}

let cachedStore: PullRequestsStore | null = null;
let cachedService: GhApiService | null = null;
const gitStatusService = new GitStatusService();

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
  cachedService = new GhApiService(getStore());
  return cachedService;
}

export function registerPullRequestHandlers(): void {
  // ----- gh CLI status (Phase A) -----------------------------------------

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

  // ----- Remote detection (Phase C) --------------------------------------

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

  // ----- PR fetch via `gh api` (Phase C) ---------------------------------

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
      _workspaceId: string,
      remote: string,
      ref: string,
      path: string,
    ): Promise<IPCResponse<{ content: string }>> => {
      if (!remote || !ref || !path) {
        return { success: false, error: 'remote, ref, path required' };
      }
      try {
        const content = await getService().getFileContents(remote, ref, path);
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
    ): Promise<IPCResponse<TimelineEntry[]>> => {
      if (!workspaceId || !remote || !number) {
        return { success: false, error: 'workspaceId, remote, number required' };
      }
      try {
        const timeline = await getService().getConversation(workspaceId, remote, number);
        return { success: true, data: timeline };
      } catch (error: unknown) {
        logger.error('pr:conversation failed', { remote, number, error });
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
}
