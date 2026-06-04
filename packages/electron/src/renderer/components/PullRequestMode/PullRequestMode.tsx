/**
 * PullRequestMode — top-level container for the GitHub PR review panel.
 *
 * Manages the poll lifecycle (start/stop + foreground focus + immediate poll
 * on enter), dispatches `pr:focus` so the main-process scheduler switches
 * cadence, and renders the sidebar + list + detail.
 */

import { useCallback, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ResizablePanel } from '../AgenticCoding/ResizablePanel';
import {
  prRemoteAtom,
  prModeLayoutAtom,
  setPrModeLayoutAtom,
  prListAtom,
  initPrModeLayout,
  type PrFilterChip,
} from '../../store/atoms/pullRequests';
import { getPullRequestService } from '../../services/RendererPullRequestService';
import { dispatchOpenWorktreeSession } from '../../store/actions/sessionHistoryActions';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import { GhOnboardingBanner } from './GhOnboardingBanner';
import { PullRequestSidebar } from './PullRequestSidebar';
import { PullRequestListView } from './PullRequestListView';
import { PullRequestDetail } from './PullRequestDetail';

interface PullRequestModeProps {
  workspacePath: string;
  workspaceName: string;
  isActive: boolean;
  onSwitchToFilesMode?: () => void;
}

export function PullRequestMode({
  workspacePath,
  workspaceName,
  isActive,
}: PullRequestModeProps): JSX.Element {
  const remote = useAtomValue(prRemoteAtom);
  const layout = useAtomValue(prModeLayoutAtom);
  const setLayout = useSetAtom(setPrModeLayoutAtom);
  const prList = useAtomValue(prListAtom);
  const setWindowMode = useSetAtom(setWindowModeAtom);

  const remoteForWorkspace =
    remote && remote.workspacePath === workspacePath ? remote.remote : null;

  // Load persisted layout when the workspace becomes known / changes.
  useEffect(() => {
    void initPrModeLayout(workspacePath);
  }, [workspacePath]);

  // Start/stop the background poller for this workspace's remote.
  useEffect(() => {
    if (!remoteForWorkspace) return;
    const service = getPullRequestService();
    void service.startPolling(workspacePath, workspacePath, remoteForWorkspace);
    return () => {
      void service.stopPolling(workspacePath);
    };
  }, [workspacePath, remoteForWorkspace]);

  // Drive the scheduler's foreground set + trigger an immediate poll on enter.
  useEffect(() => {
    if (!remoteForWorkspace) return;
    const service = getPullRequestService();
    service.setFocus(workspacePath, isActive);
    if (isActive) {
      void service.pollNow(workspacePath);
    }
    return () => {
      service.setFocus(workspacePath, false);
    };
  }, [workspacePath, isActive, remoteForWorkspace]);

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

  const handleSidebarWidthChange = useCallback(
    (width: number) => setLayout({ sidebarWidth: width }),
    [setLayout],
  );

  const selectedPr =
    layout.selectedItemId != null
      ? prList.find((pr) => pr.id === layout.selectedItemId) ?? null
      : null;

  // Create (or reuse) a worktree on the PR's head branch (the branch being
  // merged), then jump to Agent mode with that worktree selected so the dev
  // can work the branch with an agent.
  // NOTE: this hook (and every other) must run before the early return below,
  // or switching to a project without a GitHub remote changes the hook count
  // and React throws "Rendered fewer hooks than expected".
  const handleOpenInWorktree = useCallback(async () => {
    if (!selectedPr || !remoteForWorkspace) return;
    try {
      const worktree = await getPullRequestService().openWorktree(
        workspacePath,
        remoteForWorkspace,
        selectedPr.number,
      );
      // Reuse the worktree's existing session or spawn one, then select it —
      // selecting by worktree id alone leaves the agent view empty because the
      // selection id must be a session id.
      await dispatchOpenWorktreeSession(worktree.id);
      setWindowMode('agent');
    } catch (err) {
      console.error('[PullRequestMode] Failed to open PR worktree', err);
    }
  }, [selectedPr, remoteForWorkspace, workspacePath, setWindowMode]);

  if (!remoteForWorkspace) {
    return (
      <div className="pr-review-mode flex flex-col h-full w-full overflow-hidden">
        <GhOnboardingBanner />
        <div className="pr-review-placeholder flex flex-1 items-center justify-center text-nim-muted text-sm">
          No GitHub remote detected for {workspaceName}.
        </div>
      </div>
    );
  }

  const sidebarContent = (
    <PullRequestSidebar
      remote={remoteForWorkspace}
      activeFilters={layout.activeFilters}
      onToggleFilter={handleToggleFilter}
    />
  );

  // A selected PR takes over the whole content area (with a back-to-list
  // button) instead of cramming into a side panel; the list is hidden while a
  // PR is open. Both are kept mounted so returning to the list is instant and
  // the Monaco diff isn't torn down mid-review by a list re-render.
  const mainContent = (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <GhOnboardingBanner />
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div className={`absolute inset-0 ${selectedPr ? 'hidden' : 'flex'} flex-col`}>
          <PullRequestListView
            workspaceId={workspacePath}
            remote={remoteForWorkspace}
            isActive={isActive}
          />
        </div>
        {selectedPr && (
          <div className="absolute inset-0 flex flex-col">
            <PullRequestDetail
              workspaceId={workspacePath}
              remote={remoteForWorkspace}
              pr={selectedPr}
              onClose={() => setLayout({ selectedItemId: null })}
              onOpenInWorktree={handleOpenInWorktree}
            />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="pr-review-mode flex-1 flex flex-row overflow-hidden min-h-0">
      <ResizablePanel
        leftPanel={sidebarContent}
        rightPanel={mainContent}
        leftWidth={layout.sidebarWidth}
        minWidth={160}
        maxWidth={350}
        onWidthChange={handleSidebarWidthChange}
      />
    </div>
  );
}
