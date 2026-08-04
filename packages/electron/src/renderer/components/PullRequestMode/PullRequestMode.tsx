/**
 * PullRequestMode — top-level container for the GitHub PR review panel.
 *
 * Manages the poll lifecycle (start/stop + foreground focus + immediate poll
 * on enter), dispatches `pr:focus` so the main-process scheduler switches
 * cadence, and renders the sidebar + list + detail.
 */

import type { JSX } from 'react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { ResizablePanel } from '../AgenticCoding/ResizablePanel';
import { ChatSidebar, type ChatSidebarRef } from '../ChatSidebar';
import {
  prRemoteAtom,
  prModeLayoutAtom,
  setPrModeLayoutAtom,
  prListAtom,
  prNavigateRequestAtom,
  initPrModeLayout,
  type PrFilterChip,
} from '../../store/atoms/pullRequests';
import { getPullRequestService } from '../../services/RendererPullRequestService';
import {
  dispatchCreateNewSession,
  dispatchOpenWorktreeSession,
} from '../../store/actions/sessionHistoryActions';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import { GhOnboardingBanner } from './GhOnboardingBanner';
import { PullRequestSidebar } from './PullRequestSidebar';
import { PullRequestListView } from './PullRequestListView';
import { PullRequestDetail } from './PullRequestDetail';
import { buildReviewContributionDraft } from './prFormat';
import { usePrAiContext } from './usePrAiContext';
import { usePrTrackerContext, usePrTrackerReferences } from './usePrTrackerContext';

interface PullRequestModeProps {
  workspacePath: string;
  workspaceName: string;
  isActive: boolean;
  onFileOpen?: (filePath: string) => Promise<void> | void;
  onPanelStateChange?: (state: { chatCollapsed: boolean }) => void;
}

export interface PullRequestModeRef {
  toggleChatCollapsed: () => void;
  createNewChatSession: () => Promise<void>;
}

export const PullRequestMode = forwardRef<PullRequestModeRef, PullRequestModeProps>(function PullRequestMode({
  workspacePath,
  workspaceName,
  isActive,
  onFileOpen,
  onPanelStateChange,
}, ref): JSX.Element {
  const remote = useAtomValue(prRemoteAtom);
  const layout = useAtomValue(prModeLayoutAtom);
  const setLayout = useSetAtom(setPrModeLayoutAtom);
  const prList = useAtomValue(prListAtom);
  const setWindowMode = useSetAtom(setWindowModeAtom);
  const navigateRequest = useAtomValue(prNavigateRequestAtom);
  const setNavigateRequest = useSetAtom(prNavigateRequestAtom);

  const remoteForWorkspace =
    remote && remote.workspacePath === workspacePath ? remote.remote : null;
  const trackerReferences = usePrTrackerReferences(remoteForWorkspace);
  const chatSidebarRef = useRef<ChatSidebarRef>(null);

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

  // Resolve pending navigate-to-PR requests (nimbalyst:navigate-pr) to a list
  // selection. When the PR isn't in the cached list yet, trigger a poll and
  // resolve on the next list update; the request stays pending until resolved
  // or superseded.
  useEffect(() => {
    if (!navigateRequest || !remoteForWorkspace) return;
    if (navigateRequest.remote.toLowerCase() !== remoteForWorkspace.toLowerCase()) return;
    const match = prList.find((pr) => pr.number === navigateRequest.prNumber);
    if (match) {
      setLayout({ selectedItemId: match.id });
      setNavigateRequest(null);
    } else {
      void getPullRequestService().pollNow(workspacePath);
    }
  }, [navigateRequest, prList, remoteForWorkspace, workspacePath, setLayout, setNavigateRequest]);

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

  const handleSidebarWidthChange = useCallback(
    (width: number) => setLayout({ sidebarWidth: width }),
    [setLayout],
  );

  const handleChatWidthChange = useCallback(
    (width: number) => setLayout({ chatWidth: width }),
    [setLayout],
  );

  const toggleChatCollapsed = useCallback(() => {
    setLayout({ chatCollapsed: !layout.chatCollapsed });
  }, [layout.chatCollapsed, setLayout]);

  const selectedPr =
    layout.selectedItemId != null
      ? prList.find((pr) => pr.id === layout.selectedItemId) ?? null
      : null;
  const { documentContext, getDocumentContext } = usePrAiContext(
    remoteForWorkspace,
    selectedPr,
    isActive,
  );

  // Tracker/session context for the selected PR, resolved once here and handed
  // to the detail header — the chat pane and the header chips must agree on
  // which sessions belong to this PR.
  const prTrackerContext = usePrTrackerContext(
    workspacePath,
    remoteForWorkspace,
    selectedPr?.number ?? 0,
  );

  useEffect(() => {
    onPanelStateChange?.({ chatCollapsed: layout.chatCollapsed });
  }, [layout.chatCollapsed, onPanelStateChange]);

  useImperativeHandle(ref, () => ({
    toggleChatCollapsed,
    createNewChatSession: async () => {
      if (layout.chatCollapsed) {
        setLayout({ chatCollapsed: false });
      }
      await chatSidebarRef.current?.createNewSession();
    },
  }), [layout.chatCollapsed, setLayout, toggleChatCollapsed]);

  const linkSessionToPrTrackers = useCallback((sessionId: string, prNumber: number) => {
    const referencingItems = trackerReferences.get(prNumber) ?? [];
    for (const item of referencingItems) {
      void window.electronAPI
        .invoke('tracker:link-session', { trackerId: item.id, sessionId })
        .catch((err: unknown) =>
          console.error('[PullRequestMode] Failed to link session to tracker item', err),
        );
    }
  }, [trackerReferences]);

  /**
   * Load an already-linked session into this pane's chat sidebar. Reviewing a
   * PR stays in PR mode — jumping to Agent mode would lose the diff the session
   * is about.
   */
  const handleOpenSessionInChat = useCallback((sessionId: string) => {
    if (layout.chatCollapsed) {
      setLayout({ chatCollapsed: false });
    }
    chatSidebarRef.current?.loadSession(sessionId);
  }, [layout.chatCollapsed, setLayout]);

  /**
   * Selecting a PR points the chat pane at that PR's most recent linked
   * session, so the review conversation follows the selection. Kept per PR id
   * so a manual session switch within one PR isn't undone by a re-render, and
   * skipped when the PR has no linked session — the pane keeps what it had.
   * A collapsed pane stays collapsed; selecting a PR isn't a request to open
   * the chat.
   */
  const autoOpenedPrIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedPr) {
      autoOpenedPrIdRef.current = null;
      return;
    }
    if (autoOpenedPrIdRef.current === selectedPr.id) return;
    // Sessions resolve asynchronously (tracker items, worktree lookup); until
    // one shows up this effect re-runs and stays a no-op.
    const [mostRecent] = prTrackerContext.sessions;
    if (!mostRecent) return;
    autoOpenedPrIdRef.current = selectedPr.id;
    chatSidebarRef.current?.loadSession(mostRecent.id);
  }, [selectedPr, prTrackerContext.sessions]);

  const handleStartReviewSession = useCallback(async () => {
    if (!selectedPr || !remoteForWorkspace) return;
    const sessionId = await dispatchCreateNewSession(
      buildReviewContributionDraft(remoteForWorkspace, selectedPr.number),
    );
    if (!sessionId) return;
    linkSessionToPrTrackers(sessionId, selectedPr.number);
    if (layout.chatCollapsed) {
      setLayout({ chatCollapsed: false });
    }
    chatSidebarRef.current?.loadSession(sessionId);
  }, [
    selectedPr,
    remoteForWorkspace,
    linkSessionToPrTrackers,
    layout.chatCollapsed,
    setLayout,
  ]);

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
      const sessionId = await dispatchOpenWorktreeSession(worktree.id);
      // Close the triangle: link the session to every tracker item already
      // referencing this PR (no auto-create — item creation belongs to the
      // user or their triage workflows).
      if (sessionId) {
        linkSessionToPrTrackers(sessionId, selectedPr.number);
      }
      setWindowMode('agent');
    } catch (err) {
      console.error('[PullRequestMode] Failed to open PR worktree', err);
    }
  }, [selectedPr, remoteForWorkspace, workspacePath, setWindowMode, linkSessionToPrTrackers]);

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
    <div className="flex flex-col h-full w-full overflow-hidden bg-nim-secondary">
      <PullRequestSidebar
        remote={remoteForWorkspace}
        activeFilters={layout.activeFilters}
        onToggleFilter={handleToggleFilter}
        activeTrackerStatusFilters={layout.trackerStatusFilters}
        onToggleTrackerStatusFilter={handleToggleTrackerStatusFilter}
      />
      <div className="min-h-0 flex-1 border-t border-nim">
        <PullRequestListView
          workspaceId={workspacePath}
          remote={remoteForWorkspace}
          isActive={isActive}
        />
      </div>
    </div>
  );

  const mainContent = (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <GhOnboardingBanner />
      <div className="flex-1 min-h-0 overflow-hidden">
        {selectedPr ? (
          <PullRequestDetail
            workspaceId={workspacePath}
            remote={remoteForWorkspace}
            pr={selectedPr}
            trackerContext={prTrackerContext}
            onClose={() => setLayout({ selectedItemId: null })}
            onStartReviewSession={handleStartReviewSession}
            onOpenSession={handleOpenSessionInChat}
            onOpenInWorktree={handleOpenInWorktree}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center">
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
        )}
      </div>
    </div>
  );

  return (
    <div className="pr-review-mode flex-1 flex flex-row overflow-hidden min-h-0">
      <div className="pr-review-content flex-1 min-w-0 overflow-hidden">
        <ResizablePanel
          leftPanel={sidebarContent}
          rightPanel={mainContent}
          leftWidth={layout.sidebarWidth}
          minWidth={160}
          maxWidth={550}
          onWidthChange={handleSidebarWidthChange}
        />
      </div>
      <ChatSidebar
        ref={chatSidebarRef}
        workspacePath={workspacePath}
        isActive={isActive}
        isCollapsed={layout.chatCollapsed}
        onToggleCollapse={toggleChatCollapsed}
        width={layout.chatWidth}
        onWidthChange={handleChatWidthChange}
        documentContext={documentContext}
        getDocumentContext={getDocumentContext}
        onFileOpen={onFileOpen}
      />
    </div>
  );
});

PullRequestMode.displayName = 'PullRequestMode';
