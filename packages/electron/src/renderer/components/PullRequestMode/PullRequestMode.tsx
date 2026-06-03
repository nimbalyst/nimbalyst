/**
 * PullRequestMode — top-level container for the GitHub PR review panel
 * (issue #307).
 *
 * Manages the poll lifecycle (start/stop + foreground focus + immediate poll
 * on enter), dispatches `pr:focus` so the main-process scheduler switches
 * cadence, and renders the sidebar + list (Phase F). The detail panel lands
 * in Phase G.
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

  const selectedPr =
    layout.selectedItemId != null
      ? prList.find((pr) => pr.id === layout.selectedItemId) ?? null
      : null;

  const mainContent = (
    <div className="flex flex-row h-full w-full overflow-hidden">
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <GhOnboardingBanner />
        <PullRequestListView
          workspaceId={workspacePath}
          remote={remoteForWorkspace}
          isActive={isActive}
        />
      </div>
      {selectedPr && (
        <div
          className="shrink-0 border-l border-nim overflow-hidden"
          style={{ width: layout.detailPanelWidth }}
        >
          <PullRequestDetail
            workspaceId={workspacePath}
            remote={remoteForWorkspace}
            pr={selectedPr}
            onClose={() => setLayout({ selectedItemId: null })}
          />
        </div>
      )}
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
