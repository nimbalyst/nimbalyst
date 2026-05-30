/**
 * AgentMode - Clean rewrite of AgenticPanel with state pushed down.
 *
 * Key principles:
 * 1. NO useState in this component - it's just a layout shell
 * 2. All state comes from Jotai atoms
 * 3. WorkstreamList subscribes to atoms internally (no props except workspacePath)
 * 4. AgentWorkstreamPanel is fully self-contained
 *
 * This replaces AgenticPanel with a simpler architecture that eliminates
 * the massive re-renders caused by holding sessionTabs[] in useState.
 */

import React, { forwardRef, useImperativeHandle, useEffect, useCallback, useMemo, useRef } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import { ResizablePanel } from '../AgenticCoding/ResizablePanel';
import { SessionHistory } from '../AgenticCoding/SessionHistory';
import { SessionKanbanBoard } from '../TrackerMode/SessionKanbanBoard';
import { useSuperLoopInit } from '../../hooks/useSuperLoop';
import { AgentWorkstreamPanel, type AgentWorkstreamPanelRef } from './AgentWorkstreamPanel';
import {
  selectedWorkstreamAtom,
  setSelectedWorkstreamAtom,
  sessionHistoryWidthAtom,
  sessionHistoryCollapsedAtom,
  setSessionHistoryWidthAtom,
  initSessionList,
  initAgentModeLayout,
  initSessionEditors,
  addSessionFullAtom,
  store,
  refreshSessionListAtom,
  sessionAgentRoleAtom,
  pushNavigationEntryAtom,
  isRestoringNavigationAtom,
  activeSessionIdAtom,
  viewModeAtom,
  setViewModeAtom,
  registerWorkstreamSelectedHook,
} from '../../store';
import { initWorkstreamState, loadWorkstreamStates, workstreamStateAtom, workstreamActiveChildAtom } from '../../store/atoms/workstreamState';
import { blitzAnalysisCreatedAtom } from '../../store/atoms/blitz';
import { initSessionStateListeners, updateSessionStateListenerWorkspace } from '../../store/sessionStateListeners';
import { initFileStateListeners } from '../../store/listeners/fileStateListeners';
import { initFileTreeListeners } from '../../store/listeners/fileTreeListeners';
import { initSessionListListeners } from '../../store/listeners/sessionListListeners';
import { initSessionTranscriptListeners } from '../../store/listeners/sessionTranscriptListeners';
import { initTrayListeners, trayNewSessionRequestAtom } from '../../store/listeners/trayListeners';
import { initDeepLinkListeners } from '../../store/listeners/deepLinkListeners';
import { requestOpenSessionAtom } from '../../store/atoms/agentMode';
import { fetchSessionSharesAtom } from '../../store';
import { BlitzDialog } from '../BlitzDialog/BlitzDialog';
import { MetaAgentMode } from '../MetaAgentMode/MetaAgentMode';
import { tipCreateWorktreeSessionRequestAtom } from '../../tips/atoms';
import {
  blitzDialogOpenAtom,
  isGitRepoAtom,
  sessionQuickOpenRequestedAtom,
  selectSessionActionAtom,
  openSessionInTabActionAtom,
  createNewSessionActionAtom,
  createNewWorktreeSessionActionAtom,
  createWorktreeSessionCoreActionAtom,
  addSessionToWorktreeActionAtom,
} from '../../store/actions/sessionHistoryActions';
import { defaultAgentModelAtom } from '../../store/atoms/appSettings';

export interface AgentModeRef {
  createNewSession: (initialDraft?: string) => Promise<string | undefined>;
  createNewWorktreeSession: (options?: { baseBranch?: string; name?: string }) => Promise<void>;
  openSessionInTab: (sessionId: string) => Promise<void>;
  closeActiveTab: () => void;
  reopenLastClosedSession: () => void;
  nextTab: () => void;
  previousTab: () => void;
}

export interface AgentModeProps {
  workspacePath: string;
  workspaceName?: string;
  isActive?: boolean;
  onFileOpen?: (filePath: string) => Promise<void>;
  onOpenQuickSearch?: () => void;
  onReady?: () => void;
  onSwitchToAgentMode?: (planDocumentPath?: string, sessionId?: string) => void;
  onOpenSessionInChat?: (sessionId: string) => void;
}

/**
 * AgentMode is the top-level container for the agent workspace.
 *
 * Layout:
 * - Left sidebar: WorkstreamList (session/workstream list)
 * - Right side: AgentWorkstreamPanel (selected workstream)
 *
 * Most state comes from atoms. The isGitRepo state is local since it's
 * only needed for the SessionHistory component's worktree button.
 */
export const AgentMode = forwardRef<AgentModeRef, AgentModeProps>(function AgentMode({
  workspacePath,
  workspaceName,
  isActive = true,
  onFileOpen,
  onOpenQuickSearch,
  onReady,
  onSwitchToAgentMode,
  onOpenSessionInChat,
}, ref) {
  // Ref to the workstream panel for closing tabs
  const workstreamPanelRef = useRef<AgentWorkstreamPanelRef>(null);

  // Git repo status for the worktree feature. Stored per-workspace in an
  // atom so SessionHistory and the New Worktree action atom can read it
  // without prop-threading.
  const isGitRepo = useAtomValue(isGitRepoAtom(workspacePath));

  // Blitz dialog open state. Lives in an atom so SessionHistory's
  // "New Blitz" button can open the dialog via an action atom while the
  // dialog itself is still rendered here in AgentMode.
  const blitzDialogOpen = useAtomValue(blitzDialogOpenAtom);
  const setBlitzDialogOpen = useSetAtom(blitzDialogOpenAtom);

  // Keep Super Loop listeners active even when session history is collapsed/hidden.
  useSuperLoopInit(workspacePath);

  // Layout state from atoms
  const historyWidth = useAtomValue(sessionHistoryWidthAtom);
  const historyCollapsed = useAtomValue(sessionHistoryCollapsedAtom);

  // Selection state
  const selectedWorkstream = useAtomValue(selectedWorkstreamAtom(workspacePath));
  const setSelectedWorkstream = useSetAtom(setSelectedWorkstreamAtom);

  // Layout setters
  const setHistoryWidth = useSetAtom(setSessionHistoryWidthAtom);
  const addSession = useSetAtom(addSessionFullAtom);

  // Default model for blitz analysis sessions (still needed in handleBlitzCreated below)
  const defaultModel = useAtomValue(defaultAgentModelAtom);

  // Shares state
  const fetchShares = useSetAtom(fetchSessionSharesAtom);

  // Action-atom setters. `useSetAtom` returns an identity-stable setter, so
  // these can be safely passed to children or used in effect deps without
  // forcing re-renders.
  const dispatchSelectSession = useSetAtom(selectSessionActionAtom);
  const dispatchOpenSessionInTab = useSetAtom(openSessionInTabActionAtom);
  const dispatchCreateNewSession = useSetAtom(createNewSessionActionAtom);
  const dispatchCreateNewWorktreeSession = useSetAtom(createNewWorktreeSessionActionAtom);
  const dispatchCreateWorktreeSessionCore = useSetAtom(createWorktreeSessionCoreActionAtom);
  const dispatchAddSessionToWorktree = useSetAtom(addSessionToWorktreeActionAtom);

  // Get the active child session ID if the selected workstream has one
  const activeChildAtom = useMemo(
    () => selectedWorkstream ? workstreamActiveChildAtom(selectedWorkstream.id) : atom(null),
    [selectedWorkstream?.id]
  );
  const activeChildId = useAtomValue(activeChildAtom);

  // The actual active session is either the active child OR the workstream parent
  const actualActiveSessionId = activeChildId || selectedWorkstream?.id || null;

  // Sync the active session to the global atom so nav gutter components
  // (VoiceModeButton) can read it without workstream context. The global
  // atom must mirror `actualActiveSessionId` exactly — including `null` —
  // so a rail switch to a workspace with no selected workstream clears
  // the previous workspace's session id instead of leaving a cross-
  // workspace stale value behind.
  useEffect(() => {
    store.set(activeSessionIdAtom, actualActiveSessionId);
  }, [actualActiveSessionId]);

  // Initialize on mount
  useEffect(() => {
    initSessionList(workspacePath);
    initAgentModeLayout(workspacePath);
    initSessionEditors(workspacePath);
    // Initialize unified workstream state
    initWorkstreamState(workspacePath);
    loadWorkstreamStates(workspacePath);
    // Notify parent that component is ready
    onReady?.();
  }, [workspacePath, onReady]);

  // Initialize session state listeners (global, runs once)
  useEffect(() => {
    console.log("[AgentMode] initing session state listeners SHOULD ONLY HAPPEN ONCE")
    const cleanup = initSessionStateListeners();
    return cleanup;
  }, []);

  // Keep workspace routing in sync without re-registering listeners.
  useEffect(() => {
    updateSessionStateListenerWorkspace(workspacePath);
  }, [workspacePath]);

  // Initialize session list listeners (global, runs once)
  useEffect(() => {
    const cleanup = initSessionListListeners();
    return cleanup;
  }, []);

  // Initialize session transcript listeners (global, runs once)
  useEffect(() => {
    const cleanup = initSessionTranscriptListeners();
    return cleanup;
  }, []);

  // Initialize tray navigation listeners (global, runs once)
  useEffect(() => {
    const cleanup = initTrayListeners();
    return cleanup;
  }, []);

  // Initialize deep-link navigation listeners (global, runs once)
  useEffect(() => {
    const cleanup = initDeepLinkListeners();
    return cleanup;
  }, []);

  // Register global hook: exit kanban view whenever a workstream is selected.
  // This is the ONE place that handles kanban exit for ALL navigation paths:
  // tray clicks, SessionQuickOpen, kanban double-click, session list click, etc.
  // Uses a plain module-level callback in sessions.ts (not a Jotai atom) to
  // avoid Provider/store mismatch issues and circular dependency.
  useEffect(() => {
    registerWorkstreamSelectedHook(() => {
      store.set(setViewModeAtom, 'list');
    });
    return () => {
      registerWorkstreamSelectedHook(null);
    };
  }, []);

  // Fetch session shares on mount (if authenticated)
  useEffect(() => {
    fetchShares();
  }, [fetchShares]);

  // Initialize file state listeners (global, runs once per workspace)
  useEffect(() => {
    if (!workspacePath) return;
    const cleanup = initFileStateListeners(workspacePath);
    return cleanup;
  }, [workspacePath]);

  // Initialize file tree listeners (global, runs once per workspace)
  useEffect(() => {
    if (!workspacePath) return;
    const cleanup = initFileTreeListeners(workspacePath);
    return cleanup;
  }, [workspacePath]);

  // Check if workspace is a git repository (needed for worktree feature).
  // Writes the per-workspace `isGitRepoAtom` so SessionHistory and the
  // worktree action atoms can read it without prop drilling.
  useEffect(() => {
    if (!workspacePath || !window.electronAPI?.invoke) {
      store.set(isGitRepoAtom(workspacePath), false);
      return;
    }

    window.electronAPI.invoke('git:is-repo', workspacePath)
      .then(result => {
        store.set(isGitRepoAtom(workspacePath), Boolean(result?.success && result.isRepo));
      })
      .catch(() => {
        store.set(isGitRepoAtom(workspacePath), false);
      });
  }, [workspacePath]);

  // Push navigation entry when selected workstream changes (unified cross-mode navigation)
  const pushNavigationEntry = useSetAtom(pushNavigationEntryAtom);
  const isRestoringNavigation = useAtomValue(isRestoringNavigationAtom);
  const lastNavigationSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Only track navigation when this mode is active
    if (!isActive) return;

    // Don't push while restoring (going back/forward)
    if (isRestoringNavigation) return;

    // Use the actual active session (either child session or parent workstream)
    if (actualActiveSessionId && actualActiveSessionId !== lastNavigationSessionIdRef.current) {
      lastNavigationSessionIdRef.current = actualActiveSessionId;
      pushNavigationEntry({
        mode: 'agent',
        agent: {
          workstreamId: selectedWorkstream?.id || actualActiveSessionId,
          childSessionId: activeChildId || null,
        },
      });
    }
  }, [isActive, actualActiveSessionId, selectedWorkstream?.id, activeChildId, pushNavigationEntry, isRestoringNavigation]);

  // Handle "New Session" from tray menu (dispatchCreateNewSession is identity-stable)
  const trayNewSessionRequest = useAtomValue(trayNewSessionRequestAtom);
  const setTrayNewSessionRequest = useSetAtom(trayNewSessionRequestAtom);
  useEffect(() => {
    if (trayNewSessionRequest) {
      setTrayNewSessionRequest(false);
      void dispatchCreateNewSession(undefined);
    }
  }, [trayNewSessionRequest, setTrayNewSessionRequest, dispatchCreateNewSession]);

  const tipCreateWorktreeRequest = useAtomValue(tipCreateWorktreeSessionRequestAtom);
  const processedTipCreateWorktreeRequestRef = useRef(0);
  useEffect(() => {
    if (
      tipCreateWorktreeRequest === 0 ||
      tipCreateWorktreeRequest === processedTipCreateWorktreeRequestRef.current
    ) {
      return;
    }

    processedTipCreateWorktreeRequestRef.current = tipCreateWorktreeRequest;
    void dispatchCreateNewWorktreeSession(undefined);
  }, [tipCreateWorktreeRequest, dispatchCreateNewWorktreeSession]);

  // `createWorktreeSession` returns the new id (for plan-mode integration);
  // wraps the core action atom and swallows errors.
  const createWorktreeSession = useCallback(async (worktreeId: string): Promise<string | null> => {
    try {
      return await dispatchCreateWorktreeSessionCore(worktreeId);
    } catch (error) {
      console.error('[AgentMode] Failed to create worktree session:', error);
      return null;
    }
  }, [dispatchCreateWorktreeSessionCore]);

  // Session management atoms (declared early so blitz handler can reference refreshSessions)
  const refreshSessions = useSetAtom(refreshSessionListAtom);

  // Handle blitz creation result
  const handleBlitzCreated = useCallback(async (result: any) => {
    if (!result.success) return;

    const { blitzSessionId, worktrees: worktreeResults, sessionIds, models } = result;

    // Add blitz parent session to registry so sessionListRootAtom can identify blitz children
    addSession({
      id: blitzSessionId,
      title: 'Blitz',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'claude-code',
      sessionType: 'blitz',
      messageCount: 0,
      workspaceId: workspacePath,
      isArchived: false,
      isPinned: false,
      parentSessionId: null,
      worktreeId: null,
      childCount: 0,
      uncommittedCount: 0,
    });

    // Add each child session to the session registry
    if (worktreeResults && sessionIds) {
      for (let i = 0; i < worktreeResults.length; i++) {
        const wResult = worktreeResults[i];
        if (!wResult.success || !wResult.worktree) continue;

        const sessionId = sessionIds[i];
        if (!sessionId) continue;

        const worktree = wResult.worktree;

        addSession({
          id: sessionId,
          title: `Blitz: ${worktree.name}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          provider: 'claude-code',
          model: models?.[i] || defaultModel,
          sessionType: 'session',
          messageCount: 0,
          workspaceId: workspacePath,
          isArchived: false,
          isPinned: false,
          worktreeId: worktree.id,
          parentSessionId: blitzSessionId,
          childCount: 0,
          uncommittedCount: 0,
        });

        // Initialize workstream state with worktree type
        store.set(workstreamStateAtom(sessionId), {
          type: 'worktree',
          worktreeId: worktree.id,
        });
      }

      // Select the first session
      if (sessionIds[0]) {
        setSelectedWorkstream({
          workspacePath,
          selection: { type: 'worktree', id: sessionIds[0] },
        });
      }

      // Refresh session list to pick up the new sessions
      refreshSessions();

      // Trigger queue processing for all sessions so they start immediately
      for (const sessionId of sessionIds) {
        window.electronAPI.invoke('ai:triggerQueueProcessing', sessionId, workspacePath)
          .catch(error => {
            console.error('[AgentMode] Failed to trigger blitz session queue processing:', error);
          });
      }
    }
  }, [workspacePath, addSession, setSelectedWorkstream, defaultModel, refreshSessions]);

  // React to `blitz:analysis-created` events broadcast by main when all blitz
  // children complete. The IPC event is handled centrally in
  // store/listeners/blitzListeners.ts which writes blitzAnalysisCreatedAtom;
  // we register the analysis session and trigger queue processing only for
  // events matching our workspacePath, skipping the initial-mount value.
  const blitzAnalysisCreated = useAtomValue(blitzAnalysisCreatedAtom);
  const initialBlitzAnalysisCreatedRef = useRef(blitzAnalysisCreated);
  useEffect(() => {
    if (blitzAnalysisCreated === initialBlitzAnalysisCreatedRef.current) return;
    if (!blitzAnalysisCreated) return;
    const data = blitzAnalysisCreated.payload;
    if (data.workspacePath !== workspacePath) return;

    addSession({
      id: data.analysisSessionId,
      title: 'Analysis',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: data.analysisProvider || 'claude-code',
      model: data.analysisModel || 'claude-code:opus',
      sessionType: 'session',
      messageCount: 0,
      workspaceId: workspacePath,
      isArchived: false,
      isPinned: false,
      worktreeId: null,
      parentSessionId: data.blitzId,
      childCount: 0,
      uncommittedCount: 0,
    });

    // Trigger queue processing to start the analysis
    window.electronAPI.invoke('ai:triggerQueueProcessing', data.analysisSessionId, workspacePath)
      .catch((error: Error) => {
        console.error('[AgentMode] Failed to trigger analysis session queue processing:', error);
      });

    refreshSessions();
  }, [blitzAnalysisCreated, workspacePath, addSession, refreshSessions]);

  // Handle @@session reference link clicks from transcript
  const requestedSessionId = useAtomValue(requestOpenSessionAtom);
  const setRequestedSessionId = useSetAtom(requestOpenSessionAtom);
  useEffect(() => {
    if (requestedSessionId) {
      setRequestedSessionId(null);
      void dispatchOpenSessionInTab(requestedSessionId);
    }
  }, [requestedSessionId, setRequestedSessionId, dispatchOpenSessionInTab]);

  // Expose ref methods. All implementations dispatch to action atoms; the
  // setter identities returned by useSetAtom are stable, so the deps array
  // does not churn.
  useImperativeHandle(ref, () => ({
    createNewSession: (initialDraft?: string) => dispatchCreateNewSession(initialDraft),
    createNewWorktreeSession: (options?: { baseBranch?: string; name?: string }) =>
      dispatchCreateNewWorktreeSession(options),
    openSessionInTab: (sessionId: string) => dispatchOpenSessionInTab(sessionId),
    closeActiveTab: () => {
      // Route to workstream panel - it will only close editor tabs if they have focus
      workstreamPanelRef.current?.closeActiveTab();
    },
    reopenLastClosedSession: () => {
      // TODO: Implement closed session stack
    },
    nextTab: () => {
      // TODO: Implement tab navigation
    },
    previousTab: () => {
      // TODO: Implement tab navigation
    },
  }), [
    dispatchCreateNewSession,
    dispatchCreateNewWorktreeSession,
    dispatchOpenSessionInTab,
  ]);

  // Handle worktree archived - refresh the session list to show updated state
  const handleWorktreeArchived = useCallback(() => {
    // console.log('[AgentMode] Worktree archived, refreshing sessions');
    refreshSessions();
  }, [refreshSessions]);

  // Check if the selected session is a meta-agent
  const selectedWorkstreamId = selectedWorkstream?.id ?? null;
  const selectedAgentRoleAtom = useMemo(
    () => (selectedWorkstreamId ? sessionAgentRoleAtom(selectedWorkstreamId) : atom<'standard'>('standard')),
    [selectedWorkstreamId]
  );
  const selectedAgentRole = useAtomValue(selectedAgentRoleAtom);
  const isSelectedMetaAgent = selectedWorkstreamId !== null && selectedAgentRole === 'meta-agent';

  // Subscribe to the session quick-open request signal. SessionHistory bumps
  // `sessionQuickOpenRequestedAtom` when the user clicks the quick-search
  // button; here we forward to the inbound `onOpenQuickSearch` prop (App
  // owns the dialog ref).
  const sessionQuickOpenRequested = useAtomValue(sessionQuickOpenRequestedAtom);
  const lastQuickOpenSeenRef = useRef(sessionQuickOpenRequested);
  useEffect(() => {
    if (sessionQuickOpenRequested === lastQuickOpenSeenRef.current) return;
    lastQuickOpenSeenRef.current = sessionQuickOpenRequested;
    onOpenQuickSearch?.();
  }, [sessionQuickOpenRequested, onOpenQuickSearch]);

  // Content for the right side
  const rightContent = selectedWorkstream ? (
    isSelectedMetaAgent ? (
      <MetaAgentMode
        key={selectedWorkstream.id}
        workspacePath={workspacePath}
        isActive={isActive}
        sessionId={selectedWorkstream.id}
        onOpenSessionInAgent={dispatchSelectSession}
      />
    ) : (
      <AgentWorkstreamPanel
        ref={workstreamPanelRef}
        workspacePath={workspacePath}
        workstreamId={selectedWorkstream.id}
        workstreamType={selectedWorkstream.type}
        onFileOpen={onFileOpen}
        onAddSessionToWorktree={dispatchAddSessionToWorktree}
        onCreateWorktreeSession={createWorktreeSession}
        onWorktreeArchived={handleWorktreeArchived}
        isGitRepo={isGitRepo}
        onSwitchToAgentMode={onSwitchToAgentMode}
        onOpenSessionInChat={onOpenSessionInChat}
      />
    )
  ) : (
    <div className="agent-mode-empty flex flex-col items-center justify-center h-full gap-4 text-nim-muted">
      <p className="m-0 text-sm">Select a session or create a new one to get started</p>
      <button
        onClick={() => dispatchCreateNewSession(undefined)}
        className="agent-mode-new-button py-2 px-4 rounded-md border border-nim-border bg-nim-bg-secondary text-nim cursor-pointer text-sm transition-colors hover:bg-nim-bg-active"
      >
        New Session
      </button>
    </div>
  );

  // Content for the left side (session history). SessionHistory now reads
  // workspace path, active session, layout preferences, and all handlers
  // directly from atoms; no props are required.
  const leftContent = <SessionHistory />;

  const viewMode = useAtomValue(viewModeAtom);

  const kanbanContent = (
    <SessionKanbanBoard
      onSessionSelect={dispatchSelectSession}
      onSessionOpen={dispatchSelectSession}
    />
  );

  return (
    <div className="agent-mode flex flex-row h-full w-full overflow-hidden">
      <ResizablePanel
        leftPanel={leftContent}
        rightPanel={viewMode === 'kanban' ? kanbanContent : rightContent}
        leftWidth={historyWidth}
        minWidth={200}
        maxWidth={500}
        onWidthChange={(width) => setHistoryWidth(width)}
        collapsed={historyCollapsed}
      />
      <BlitzDialog
        isOpen={blitzDialogOpen}
        onClose={() => setBlitzDialogOpen(false)}
        onCreated={handleBlitzCreated}
        workspacePath={workspacePath}
      />
    </div>
  );
});
