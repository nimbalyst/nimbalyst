/**
 * usePullRequestPanel — everything the GitHub panel needs to show the pull
 * request list: the PR poll lifecycle (start/stop + foreground focus +
 * immediate poll on enter), navigate-to-PR resolution, filter toggles, the
 * per-PR tracker/session context, and the review-session and worktree actions.
 *
 * Returns the panel slots; layout geometry and the chat rail belong to
 * GithubPanelShell, and the mode component only chooses which list's slots to
 * hand it.
 */

import type { JSX, RefObject } from 'react';
import { useCallback, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  prModeLayoutAtom,
  setPrModeLayoutAtom,
  prListAtom,
  prNavigateRequestAtom,
  prRemoteAtom,
  type PrFilterChip,
} from '../../store/atoms/pullRequests';
import { getPullRequestService } from '../../services/RendererPullRequestService';
import {
  dispatchCreateNewSession,
  dispatchOpenWorktreeSession,
} from '../../store/actions/sessionHistoryActions';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import type { GithubPanelChatHandle } from './GithubPanelShell';
import type { GithubPanelSlots } from './githubPanelSlots';
import { PullRequestSidebar } from './PullRequestSidebar';
import { PullRequestListView } from './PullRequestListView';
import { PullRequestDetail } from './PullRequestDetail';
import { buildReviewContributionDraft } from './prFormat';
import { usePrAiContext } from './usePrAiContext';
import { usePrTrackerContext, usePrTrackerReferences } from './usePrTrackerContext';

interface PullRequestPanelOptions {
  workspacePath: string;
  /** The workspace's GitHub remote, or null when it has none. */
  remote: string | null;
  /** Whether the GitHub panel itself is the active content mode. */
  isActive: boolean;
  /** Whether the PR list is the one currently showing in the panel. */
  isVisible: boolean;
  chatRef: RefObject<GithubPanelChatHandle | null>;
}

export function usePullRequestPanel({
  workspacePath,
  remote,
  isActive,
  isVisible,
  chatRef,
}: PullRequestPanelOptions): GithubPanelSlots {
  const layout = useAtomValue(prModeLayoutAtom);
  const setLayout = useSetAtom(setPrModeLayoutAtom);
  const prList = useAtomValue(prListAtom);
  const setWindowMode = useSetAtom(setWindowModeAtom);
  const remoteInfo = useAtomValue(prRemoteAtom);
  const navigateRequest = useAtomValue(prNavigateRequestAtom);
  const setNavigateRequest = useSetAtom(prNavigateRequestAtom);
  const trackerReferences = usePrTrackerReferences(remote);

  // Start/stop the background poller for this workspace's remote. It is the
  // panel's poller rather than this list's — the same scheduler also refreshes
  // the issue cache — so it follows the panel, not the visible list.
  useEffect(() => {
    if (!remote) return;
    const service = getPullRequestService();
    void service.startPolling(workspacePath, workspacePath, remote);
    return () => {
      void service.stopPolling(workspacePath);
    };
  }, [workspacePath, remote]);

  // Resolve pending navigate-to-PR requests (nimbalyst:navigate-pr) to a list
  // selection. When the PR isn't in the cached list yet, trigger a poll and
  // resolve on the next list update; the request stays pending until resolved
  // or superseded. Arriving from elsewhere in the app also switches the panel
  // back to the PR list, which may not be the one showing.
  useEffect(() => {
    if (!navigateRequest || !remote) return;
    if (navigateRequest.remote.toLowerCase() !== remote.toLowerCase()) return;
    const match = prList.find((pr) => pr.number === navigateRequest.prNumber);
    if (match) {
      setLayout({ selectedItemId: match.id, activeGithubList: 'prs' });
      setNavigateRequest(null);
    } else {
      void getPullRequestService().pollNow(workspacePath);
    }
  }, [navigateRequest, prList, remote, workspacePath, setLayout, setNavigateRequest]);

  // Drive the scheduler's foreground set + trigger an immediate poll on enter.
  useEffect(() => {
    if (!remote) return;
    const service = getPullRequestService();
    service.setFocus(workspacePath, isActive);
    if (isActive) {
      void service.pollNow(workspacePath);
    }
    return () => {
      service.setFocus(workspacePath, false);
    };
  }, [workspacePath, isActive, remote]);

  // `open` / `closed` are mutually exclusive; the rest toggle independently.
  const handleToggleFilter = useCallback(
    (filter: PrFilterChip) => {
      let current = layout.activeFilters;
      if (filter === 'open') current = current.filter((f) => f !== 'closed');
      if (filter === 'closed') current = current.filter((f) => f !== 'open');
      const next = current.includes(filter)
        ? current.filter((f) => f !== filter)
        : [...current, filter];
      setLayout({ activeFilters: next });
    },
    [layout.activeFilters, setLayout],
  );

  const handleToggleTrackerStatusFilter = useCallback(
    (status: string) => {
      const current = layout.trackerStatusFilters;
      const next = current.includes(status)
        ? current.filter((s) => s !== status)
        : [...current, status];
      setLayout({ trackerStatusFilters: next });
    },
    [layout.trackerStatusFilters, setLayout],
  );

  const selectedPr =
    layout.selectedItemId != null
      ? prList.find((pr) => pr.id === layout.selectedItemId) ?? null
      : null;
  const { documentContext, getDocumentContext } = usePrAiContext(
    remote,
    selectedPr,
    isActive && isVisible,
  );

  // Tracker/session context for the selected PR, resolved once here and handed
  // to the detail header — the chat pane and the header chips must agree on
  // which sessions belong to this PR.
  const prTrackerContext = usePrTrackerContext(
    workspacePath,
    remote,
    selectedPr?.number ?? 0,
  );

  const linkSessionToPrTrackers = useCallback((sessionId: string, prNumber: number) => {
    const referencingItems = trackerReferences.get(prNumber) ?? [];
    for (const item of referencingItems) {
      void window.electronAPI
        .invoke('tracker:link-session', { trackerId: item.id, sessionId })
        .catch((err: unknown) =>
          console.error('[usePullRequestPanel] Failed to link session to tracker item', err),
        );
    }
  }, [trackerReferences]);

  const handleOpenSessionInChat = useCallback((sessionId: string) => {
    chatRef.current?.openSession(sessionId);
  }, [chatRef]);

  const handleStartReviewSession = useCallback(async () => {
    if (!selectedPr || !remote) return;
    const sessionId = await dispatchCreateNewSession({
      initialDraft: buildReviewContributionDraft(remote, selectedPr.number),
      launchSource: 'pull_request_panel',
    });
    if (!sessionId) return;
    linkSessionToPrTrackers(sessionId, selectedPr.number);
    chatRef.current?.openSession(sessionId);
  }, [selectedPr, remote, linkSessionToPrTrackers, chatRef]);

  // Create (or reuse) a worktree on the PR's head branch (the branch being
  // merged), then jump to Agent mode with that worktree selected so the dev
  // can work the branch with an agent.
  const handleOpenInWorktree = useCallback(async () => {
    if (!selectedPr || !remote) return;
    try {
      // Branch from the repository the panel points at
      const repoPath = remoteInfo?.workspacePath === workspacePath ? remoteInfo.repoPath : undefined;
      const worktree = await getPullRequestService().openWorktree(
        workspacePath,
        remote,
        selectedPr.number,
        repoPath,
      );
      // Reuse the worktree's existing session or spawn one, then select it —
      // selecting by worktree id alone leaves the agent view empty because the
      // selection id must be a session id.
      const sessionId = await dispatchOpenWorktreeSession(worktree.id);
      // Close the triangle: link the session to every tracker item already
      // referencing this PR (no auto-create — item creation belongs to the
      // user or their triage workflows).
      if (sessionId) {
        linkSessionToPrTrackers(sessionId, selectedPr.number);
      }
      setWindowMode('agent');
    } catch (err) {
      console.error('[usePullRequestPanel] Failed to open PR worktree', err);
    }
  }, [selectedPr, remote, remoteInfo, workspacePath, setWindowMode, linkSessionToPrTrackers]);

  return {
    sidebar: (
      <PullRequestSidebar
        remote={remote}
        activeFilters={layout.activeFilters}
        onToggleFilter={handleToggleFilter}
        activeTrackerStatusFilters={layout.trackerStatusFilters}
        onToggleTrackerStatusFilter={handleToggleTrackerStatusFilter}
      />
    ),
    list: (
      <PullRequestListView
        workspaceId={workspacePath}
        remote={remote}
        isActive={isActive && isVisible}
      />
    ),
    detail: selectedPr && remote ? (
      <PullRequestDetail
        workspaceId={workspacePath}
        remote={remote}
        pr={selectedPr}
        trackerContext={prTrackerContext}
        onClose={() => setLayout({ selectedItemId: null })}
        onStartReviewSession={handleStartReviewSession}
        onOpenSession={handleOpenSessionInChat}
        onOpenInWorktree={handleOpenInWorktree}
      />
    ) : (
      <PullRequestEmptyState />
    ),
    documentContext,
    getDocumentContext,
    selectionKey: selectedPr?.id ?? null,
    selectionSessions: prTrackerContext.sessions,
  };
}

function PullRequestEmptyState(): JSX.Element {
  return (
    <div className="pr-empty-state flex h-full items-center justify-center px-8 text-center">
      <div className="max-w-md space-y-3">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-nim bg-nim-secondary text-nim-faint">
          <MaterialSymbol icon="merge" size={24} />
        </div>
        <div className="text-sm font-medium text-nim">Select a pull request</div>
        <div className="text-sm text-nim-muted">
          Pick a PR from the left to review its conversation, files, commits, and checks.
        </div>
      </div>
    </div>
  );
}
