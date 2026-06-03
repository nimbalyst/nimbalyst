/**
 * RendererPullRequestService - Renderer-side facade for the PR review panel
 * IPC channels registered in `PullRequestHandlers`. Issue #307 Phase C.
 *
 * Thin wrappers over `window.electronAPI.pr*` that unwrap the `IPCResponse`
 * envelope and throw on failure, so React components can `await` and
 * `try/catch` without inspecting the boolean `success` flag everywhere.
 */

import type {
  PullRequestRow as MainPullRequestRow,
  PullRequestFileRow as MainPullRequestFileRow,
  PullRequestCommitRow as MainPullRequestCommitRow,
  PullRequestCheckRow as MainPullRequestCheckRow,
  Reviewer as MainPullRequestReviewer,
} from '../../main/services/PullRequestsStore';
import type {
  TimelineEntry as MainPullRequestTimelineEntry,
  ListFilters as MainPullRequestListFilters,
} from '../../main/services/GhApiService';

export type PullRequestRow = MainPullRequestRow;
export type PullRequestFileRow = MainPullRequestFileRow;
export type PullRequestCommitRow = MainPullRequestCommitRow;
export type PullRequestCheckRow = MainPullRequestCheckRow;
export type PullRequestReviewer = MainPullRequestReviewer;
export type PullRequestTimelineEntry = MainPullRequestTimelineEntry;
export type PullRequestListFilters = MainPullRequestListFilters;

type PrRemote = { remote: string; host: string };

function requireApi(): NonNullable<typeof window.electronAPI> {
  if (!window.electronAPI) {
    throw new Error('electronAPI not available');
  }
  return window.electronAPI;
}

function unwrap<T>(res: { success: boolean; error?: string; data?: T }, label: string): T {
  if (!res.success || res.data === undefined) {
    throw new Error(res.error || `${label} failed`);
  }
  return res.data;
}

export class RendererPullRequestService {
  async detectRemote(workspacePath: string): Promise<PrRemote | null> {
    const res = await requireApi().prDetectRemote(workspacePath);
    if (!res.success) {
      throw new Error(res.error || 'detectRemote failed');
    }
    return res.data ?? null;
  }

  async list(
    workspaceId: string,
    remote: string,
    filters?: PullRequestListFilters,
  ): Promise<PullRequestRow[]> {
    const res = await requireApi().prList(workspaceId, remote, filters);
    return unwrap(res, 'pr:list');
  }

  async get(workspaceId: string, remote: string, number: number): Promise<PullRequestRow> {
    const res = await requireApi().prGet(workspaceId, remote, number);
    return unwrap(res, 'pr:get');
  }

  async files(workspaceId: string, remote: string, number: number): Promise<PullRequestFileRow[]> {
    const res = await requireApi().prFiles(workspaceId, remote, number);
    return unwrap(res, 'pr:files');
  }

  async fileContents(
    workspaceId: string,
    remote: string,
    ref: string,
    path: string,
  ): Promise<string> {
    const res = await requireApi().prFileContents(workspaceId, remote, ref, path);
    const data = unwrap(res, 'pr:file-contents');
    return data.content;
  }

  async commits(
    workspaceId: string,
    remote: string,
    number: number,
  ): Promise<PullRequestCommitRow[]> {
    const res = await requireApi().prCommits(workspaceId, remote, number);
    return unwrap(res, 'pr:commits');
  }

  async checks(
    workspaceId: string,
    remote: string,
    number: number,
  ): Promise<PullRequestCheckRow[]> {
    const res = await requireApi().prChecks(workspaceId, remote, number);
    return unwrap(res, 'pr:checks');
  }

  async conversation(
    workspaceId: string,
    remote: string,
    number: number,
  ): Promise<PullRequestTimelineEntry[]> {
    const res = await requireApi().prConversation(workspaceId, remote, number);
    return unwrap(res, 'pr:conversation');
  }

  async refresh(workspaceId: string, remote: string, number?: number): Promise<number> {
    const res = await requireApi().prRefresh(workspaceId, remote, number);
    const data = unwrap(res, 'pr:refresh');
    return data.fetchedAt;
  }

  // ----- Polling scheduler (Phase D of issue #307) -----------------------

  async startPolling(workspacePath: string, workspaceId: string, remote: string): Promise<void> {
    const res = await requireApi().prStartPolling(workspacePath, workspaceId, remote);
    unwrap(res, 'pr:start-polling');
  }

  async stopPolling(workspacePath: string): Promise<void> {
    const res = await requireApi().prStopPolling(workspacePath);
    unwrap(res, 'pr:stop-polling');
  }

  async pollNow(workspacePath: string): Promise<void> {
    const res = await requireApi().prPollNow(workspacePath);
    unwrap(res, 'pr:poll-now');
  }

  /**
   * Fire-and-forget. The scheduler updates its foreground set when this is
   * sent and re-plans the cadence (60s foreground / 300s background).
   */
  setFocus(workspacePath: string, focused: boolean): void {
    requireApi().prFocus(workspacePath, focused);
  }

  onListUpdated(
    callback: (payload: { workspacePath: string; remote: string }) => void,
  ): () => void {
    return requireApi().onPrListUpdated(callback);
  }

  /**
   * Create (or reuse) a worktree bound to a PR and return it. Phase H.
   */
  async openWorktree(
    workspaceId: string,
    remote: string,
    number: number,
  ): Promise<{ id: string; name: string; path: string; branch: string }> {
    const res = await requireApi().prOpenWorktree(workspaceId, remote, number);
    return unwrap(res, 'pr:open-worktree');
  }

  // ----- Per-project gh account selection (issue #307) -------------------

  async listAccounts(): Promise<Array<{ login: string; host: string; active: boolean }>> {
    const res = await requireApi().prGhAccounts();
    return unwrap(res, 'pr:gh-accounts');
  }

  async getAccountConfig(
    workspacePath?: string,
  ): Promise<{ defaultAccount: string | null; override: string | null; effective: string | null }> {
    const res = await requireApi().prGetAccountConfig(workspacePath);
    return unwrap(res, 'pr:get-account-config');
  }

  async setDefaultAccount(login: string | null): Promise<void> {
    const res = await requireApi().prSetDefaultAccount(login);
    unwrap(res, 'pr:set-default-account');
  }

  async setAccountOverride(workspacePath: string, login: string | null): Promise<void> {
    const res = await requireApi().prSetAccountOverride(workspacePath, login);
    unwrap(res, 'pr:set-account-override');
  }
}

let instance: RendererPullRequestService | null = null;

export function getPullRequestService(): RendererPullRequestService {
  if (!instance) {
    instance = new RendererPullRequestService();
  }
  return instance;
}
