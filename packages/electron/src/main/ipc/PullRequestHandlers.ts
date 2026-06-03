/**
 * PullRequestHandlers - IPC handlers for the integrated PR review panel.
 *
 * Phase A (this file): only the `gh` CLI status probes used by the onboarding
 * banner. Subsequent phases extend this module with `pr:list`, `pr:get`,
 * `pr:files`, `pr:commits`, `pr:checks`, `pr:open-worktree`, etc.
 *
 * All GitHub authentication is delegated to the `gh` CLI; Nimbalyst never
 * holds a GitHub token.
 */

import log from 'electron-log/main';
import { safeHandle } from '../utils/ipcRegistry';
import { ghCliDetector, type GhCliStatus } from '../services/GhCliDetector';

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

export function registerPullRequestHandlers(): void {
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
}
