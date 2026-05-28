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

import React, { forwardRef, useImperativeHandle, useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import { defaultAgentModelAtom, worktreesFeatureAvailableAtom, alphaFeatureEnabledAtom } from '../../store/atoms/appSettings';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
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
  collapsedGroupsAtom,
  sortOrderAtom,
  setSessionHistoryWidthAtom,
  setCollapsedGroupsAtom,
  setSortOrderAtom,
  initSessionList,
  initAgentModeLayout,
  initSessionEditors,
  addSessionFullAtom,
  setActiveSessionInWorkstreamAtom,
  loadSessionChildrenAtom,
  store,
  refreshSessionListAtom,
  removeSessionFullAtom,
  updateSessionStoreAtom,
  sessionAgentRoleAtom,
  sessionRegistryAtom,
  sessionStoreAtom,
  pushNavigationEntryAtom,
  isRestoringNavigationAtom,
  markSessionReadAtom,
  activeSessionIdAtom,
  setSessionDraftInputAtom,
  viewModeAtom,
  setViewModeAtom,
  registerWorkstreamSelectedHook,
} from '../../store';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { initWorkstreamState, loadWorkstreamStates, workstreamStateAtom, workstreamActiveChildAtom, setWorkstreamActiveChildAtom, setWorktreeActiveSessionAtom } from '../../store/atoms/workstreamState';
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
import type { WorktreeCreateResult, SessionCreateResult } from '../../../shared/ipc/types';
import { BlitzDialog } from '../BlitzDialog/BlitzDialog';
import { MetaAgentMode } from '../MetaAgentMode/MetaAgentMode';

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

  // Git repo status for worktree feature
  const [isGitRepo, setIsGitRepo] = useState(false);

  // Blitz dialog state
  const [showBlitzDialog, setShowBlitzDialog] = useState(false);

  // Check if worktrees feature is available (developer mode + feature enabled)
  const isWorktreesAvailable = useAtomValue(worktreesFeatureAvailableAtom);
  // Blitz is gated by its alpha feature alone (like Meta Agent), not developer
  // mode. The worktrees it creates still require a git repo, enforced in
  // createNewBlitz and on the New Blitz button (disabled when !isGitRepo).
  const isBlitzAlphaEnabled = useAtomValue(alphaFeatureEnabledAtom('blitz'));
  const isBlitzAvailable = isBlitzAlphaEnabled;

  // Keep Super Loop listeners active even when session history is collapsed/hidden.
  useSuperLoopInit(workspacePath);

  // Layout state from atoms
  const historyWidth = useAtomValue(sessionHistoryWidthAtom);
  const historyCollapsed = useAtomValue(sessionHistoryCollapsedAtom);
  const collapsedGroups = useAtomValue(collapsedGroupsAtom);
  const sortOrder = useAtomValue(sortOrderAtom);

  // Selection state
  const selectedWorkstream = useAtomValue(selectedWorkstreamAtom(workspacePath));
  const setSelectedWorkstream = useSetAtom(setSelectedWorkstreamAtom);

  // Layout setters
  const setHistoryWidth = useSetAtom(setSessionHistoryWidthAtom);
  const setCollapsedGroups = useSetAtom(setCollapsedGroupsAtom);
  const setSortOrder = useSetAtom(setSortOrderAtom);
  const addSession = useSetAtom(addSessionFullAtom);

  // Default model for new sessions (user's last selected model)
  const defaultModel = useAtomValue(defaultAgentModelAtom);

  // Shares state
  const fetchShares = useSetAtom(fetchSessionSharesAtom);

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

  // Check if workspace is a git repository (needed for worktree feature)
  useEffect(() => {
    if (!workspacePath || !window.electronAPI?.invoke) {
      setIsGitRepo(false);
      return;
    }

    window.electronAPI.invoke('git:is-repo', workspacePath)
      .then(result => {
        if (result?.success) {
          setIsGitRepo(result.isRepo);
        } else {
          setIsGitRepo(false);
        }
      })
      .catch(() => {
        setIsGitRepo(false);
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

  // Create new session
  const createNewSession = useCallback(async (initialDraft?: string): Promise<string | undefined> => {
    if (!window.electronAPI) return undefined;

    try {
      const sessionId = crypto.randomUUID();
      // Parse provider from defaultModel using ModelIdentifier
      const parsedModel = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
      const provider = parsedModel?.provider || 'claude-code';
      // console.log('[AgentMode] Creating new session with defaultModel:', defaultModel, 'provider:', provider);
      const result = await window.electronAPI.invoke('sessions:create', {
        session: {
          id: sessionId,
          provider,
          model: defaultModel,
          title: 'New Session',
        },
        workspaceId: workspacePath,
      });

      if (result.success && result.id) {
        // Add to session list
        addSession({
          id: result.id,
          title: 'New Session',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          provider,
          model: defaultModel,
          sessionType: 'session',
          messageCount: 0,
          workspaceId: workspacePath,
          isArchived: false,
          isPinned: false,
          parentSessionId: null,
          worktreeId: null,
          childCount: 0,
          uncommittedCount: 0,
        });

        // Set initial draft input before selecting the session
        // so it's ready when the session component mounts
        if (initialDraft) {
          store.set(setSessionDraftInputAtom, {
            sessionId: result.id,
            draftInput: initialDraft,
            workspacePath,
            persist: true,
          });
        }

        // Select the new session
        setSelectedWorkstream({
          workspacePath,
          selection: { type: 'session', id: result.id },
        });

        return result.id;
      }
    } catch (error) {
      console.error('[AgentMode] Failed to create session:', error);
    }
    return undefined;
  }, [workspacePath, addSession, setSelectedWorkstream, defaultModel]);

  // Handle "New Session" from tray menu
  const trayNewSessionRequest = useAtomValue(trayNewSessionRequestAtom);
  const setTrayNewSessionRequest = useSetAtom(trayNewSessionRequestAtom);
  useEffect(() => {
    if (trayNewSessionRequest) {
      setTrayNewSessionRequest(false);
      createNewSession();
    }
  }, [trayNewSessionRequest, setTrayNewSessionRequest, createNewSession]);

  // Create new worktree session
  const createNewWorktreeSession = useCallback(async (options?: { baseBranch?: string; name?: string }) => {
    if (!window.electronAPI) return;

    // Check if worktrees feature is available
    if (!isWorktreesAvailable) return;

    // Check if this is a git repo
    if (!isGitRepo) return;

    try {
      // Create the worktree
      const ipcOptions = options?.baseBranch || options?.name ? options : undefined;
      const worktreeResult: WorktreeCreateResult = await window.electronAPI.invoke(
        'worktree:create',
        workspacePath,
        ipcOptions
      );
      if (!worktreeResult.success || !worktreeResult.worktree) {
        throw new Error(worktreeResult.error || 'Failed to create worktree');
      }

      const worktree = worktreeResult.worktree;

      // Create session with worktree association
      const sessionId = crypto.randomUUID();
      const parsedWorktreeModel = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
      const worktreeProvider = parsedWorktreeModel?.provider || 'claude-code';
      const result: SessionCreateResult = await window.electronAPI.invoke('sessions:create', {
        session: {
          id: sessionId,
          provider: worktreeProvider,
          model: defaultModel,
          title: `Worktree: ${worktree.name}`,
          worktreeId: worktree.id,
        },
        workspaceId: workspacePath,
      });

      if (result.success && result.id) {
        // Add to session list
        addSession({
          id: result.id,
          title: `Worktree: ${worktree.name}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          provider: worktreeProvider,
          model: defaultModel,
          sessionType: 'session',
          messageCount: 0,
          workspaceId: workspacePath,
          isArchived: false,
          isPinned: false,
          parentSessionId: null,
          worktreeId: worktree.id,
          childCount: 0,
          uncommittedCount: 0,
        });

        // Initialize workstream state with worktree type
        store.set(workstreamStateAtom(result.id), {
          type: 'worktree',
          worktreeId: worktree.id,
        });

        // Select the new worktree session
        setSelectedWorkstream({
          workspacePath,
          selection: { type: 'worktree', id: result.id },
        });
      }
    } catch (error) {
      console.error('[AgentMode] Failed to create worktree session:', error);
      // Re-throw so callers awaiting the promise (e.g. WorktreeBaseBranchPicker)
      // can surface the error to the user instead of silently closing.
      throw error;
    }
  }, [workspacePath, addSession, setSelectedWorkstream, defaultModel, isWorktreesAvailable, isGitRepo]);

  // Create session in an existing worktree and return the session ID
  // This is the core logic shared by both addSessionToWorktree and createWorktreeSession
  const createWorktreeSessionCore = useCallback(async (worktreeId: string): Promise<string | null> => {
    if (!window.electronAPI) return null;

    // Get the worktree data to use its name
    const worktreeResult = await window.electronAPI.invoke('worktree:get', worktreeId);
    if (!worktreeResult?.worktree) {
      throw new Error('Worktree not found');
    }

    const worktree = worktreeResult.worktree;

    // Create session with worktree association (no parentSessionId - this is NOT a workstream)
    const sessionId = crypto.randomUUID();
    const parsedCoreModel = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
    const coreProvider = parsedCoreModel?.provider || 'claude-code';
    const result = await window.electronAPI.invoke('sessions:create', {
      session: {
        id: sessionId,
        provider: coreProvider,
        model: defaultModel,
        title: 'New Session',
        worktreeId: worktree.id,
      },
      workspaceId: workspacePath,
    });

    if (result.success && result.id) {
      // Add to session list
      addSession({
        id: result.id,
        title: 'New Session',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provider: coreProvider,
        model: defaultModel,
        sessionType: 'session',
        messageCount: 0,
        workspaceId: workspacePath,
        isArchived: false,
        isPinned: false,
        parentSessionId: null,
        worktreeId: worktree.id,
        childCount: 0,
        uncommittedCount: 0,
      });

      // Initialize workstream state with worktree type
      store.set(workstreamStateAtom(result.id), {
        type: 'worktree',
        worktreeId: worktree.id,
      });

      // Select the new session within the worktree
      setSelectedWorkstream({
        workspacePath,
        selection: { type: 'worktree', id: result.id },
      });

      return result.id;
    } else {
      throw new Error(result.error || 'Failed to create session');
    }
  }, [workspacePath, addSession, setSelectedWorkstream, defaultModel]);

  // Add session to an existing worktree (void return, shows error notification on failure)
  const addSessionToWorktree = useCallback(async (worktreeId: string) => {
    try {
      await createWorktreeSessionCore(worktreeId);
    } catch (error) {
      errorNotificationService.showError(
        'Failed to Create Session',
        error instanceof Error ? error.message : 'An unexpected error occurred while adding a session to the worktree.',
        { duration: 5000 }
      );
    }
  }, [createWorktreeSessionCore]);

  // Create session in worktree and return the session ID (for use by plan mode)
  const createWorktreeSession = useCallback(async (worktreeId: string): Promise<string | null> => {
    try {
      return await createWorktreeSessionCore(worktreeId);
    } catch (error) {
      console.error('[AgentMode] Failed to create worktree session:', error);
      return null;
    }
  }, [createWorktreeSessionCore]);

  // Session management atoms (declared early so blitz handler can reference refreshSessions)
  const refreshSessions = useSetAtom(refreshSessionListAtom);
  const removeSessionFromAtom = useSetAtom(removeSessionFullAtom);
  const updateSessionStore = useSetAtom(updateSessionStoreAtom);

  // Create new blitz - opens the blitz dialog
  const createNewBlitz = useCallback(() => {
    if (!isBlitzAlphaEnabled || !isGitRepo) return;
    setShowBlitzDialog(true);
  }, [isBlitzAlphaEnabled, isGitRepo]);

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

  // Open session by ID
  const openSessionInTab = useCallback(async (sessionId: string) => {
    // console.log('[AgentMode] openSessionInTab called with:', sessionId);

    // Check session list for parentSessionId (more reliable than aiLoadSession)
    try {
      const result = await window.electronAPI.invoke('sessions:list', workspacePath, { includeArchived: false });
      if (!result.success) {
        throw new Error('Failed to load session list');
      }

      const sessionListItem = result.sessions.find((s: any) => s.id === sessionId);
      // console.log('[AgentMode] Session list item:', sessionListItem?.id, 'parentSessionId:', sessionListItem?.parentSessionId);

      // Check if session is in the registry - if not, add it
      // This handles cases where a session was just created (e.g., via rebase conflict resolution)
      const registry = store.get(sessionRegistryAtom);
      if (sessionListItem && !registry.has(sessionId)) {
        // console.log('[AgentMode] Session not in registry, adding it');
        addSession({
          id: sessionListItem.id,
          title: sessionListItem.title || 'Untitled Session',
          createdAt: sessionListItem.createdAt,
          updatedAt: sessionListItem.updatedAt,
          provider: sessionListItem.provider || 'claude-code',
          model: sessionListItem.model,
          sessionType: sessionListItem.sessionType || 'session',
          messageCount: sessionListItem.messageCount || 0,
          workspaceId: workspacePath,
          isArchived: sessionListItem.isArchived || false,
          isPinned: sessionListItem.isPinned || false,
          worktreeId: sessionListItem.worktreeId || null,
          parentSessionId: sessionListItem.parentSessionId || null,
          childCount: sessionListItem.childCount || 0,
          uncommittedCount: sessionListItem.uncommittedCount || 0,
        });

        // If it's a worktree session, initialize workstream state
        if (sessionListItem.worktreeId) {
          // console.log('[AgentMode] Initializing worktree state for session');
          store.set(workstreamStateAtom(sessionId), {
            type: 'worktree',
            worktreeId: sessionListItem.worktreeId,
          });
        }
      }

      if (sessionListItem?.parentSessionId) {
        // This is a child session in a workstream
        // console.log('[AgentMode] Child session detected, parent:', sessionListItem.parentSessionId);

        // CRITICAL: Load the parent's children first to populate the workstream state
        // This ensures the child session IDs are in the state before we set active child
        await store.set(loadSessionChildrenAtom, {
          parentSessionId: sessionListItem.parentSessionId,
          workspacePath,
        });
        // console.log('[AgentMode] Parent children loaded');

        // Now set the active child in the workstream state (and mark as read)
        store.set(setActiveSessionInWorkstreamAtom, {
          workstreamId: sessionListItem.parentSessionId,
          sessionId,
        });
        // console.log('[AgentMode] Active child set to:', sessionId);

        // Finally, select the parent workstream
        const parentState = store.get(workstreamStateAtom(sessionListItem.parentSessionId));
        const parentType = parentState.type === 'worktree' ? 'worktree'
          : parentState.type === 'workstream' ? 'workstream'
          : 'session';

        // console.log('[AgentMode] Selecting parent workstream:', sessionListItem.parentSessionId, 'type:', parentType);
        setSelectedWorkstream({
          workspacePath,
          selection: { type: parentType, id: sessionListItem.parentSessionId },
        });
      } else {
        // This is a root session - check its type
        const state = store.get(workstreamStateAtom(sessionId));
        const type = state.type === 'worktree' ? 'worktree'
          : state.type === 'workstream' ? 'workstream'
          : 'session';

        setSelectedWorkstream({
          workspacePath,
          selection: { type, id: sessionId },
        });
      }
    } catch (error) {
      console.error('[AgentMode] Failed to load session data:', error);
      // Fallback: treat as a simple session
      setSelectedWorkstream({
        workspacePath,
        selection: { type: 'session', id: sessionId },
      });
    }
  }, [workspacePath, setSelectedWorkstream, addSession]);

  // Handle @@session reference link clicks from transcript
  const requestedSessionId = useAtomValue(requestOpenSessionAtom);
  const setRequestedSessionId = useSetAtom(requestOpenSessionAtom);
  useEffect(() => {
    if (requestedSessionId) {
      setRequestedSessionId(null);
      openSessionInTab(requestedSessionId);
    }
  }, [requestedSessionId, setRequestedSessionId, openSessionInTab]);

  // Handle child session selection from workstream group
  // Opens the parent workstream and sets the child as active
  const handleChildSessionSelect = useCallback(async (
    childSessionId: string,
    parentId: string,
    parentType: 'workstream' | 'worktree'
  ) => {
    if (parentType === 'worktree') {
      // For worktrees, parentId is the worktree ID (not a session ID)
      // We need to select the child session directly, which has a worktreeId field
      // The workstreamSessionsAtom will find sibling sessions via the worktreeId

      // Track active session for worktree (for "return to last session" feature)
      store.set(setWorktreeActiveSessionAtom, {
        worktreeId: parentId,
        sessionId: childSessionId,
      });

      // Set the clicked child as active (and mark as read)
      store.set(setActiveSessionInWorkstreamAtom, {
        workstreamId: parentId,
        sessionId: childSessionId,
      });

      setSelectedWorkstream({
        workspacePath,
        selection: { type: 'session', id: childSessionId },
      });
    } else {
      // For workstreams, parentId is a session ID
      // Load the parent's children to populate workstream state
      await store.set(loadSessionChildrenAtom, {
        parentSessionId: parentId,
        workspacePath,
      });

      // Set the clicked child as active and mark as read
      store.set(setWorkstreamActiveChildAtom, {
        workstreamId: parentId,
        childId: childSessionId,
      });
      store.set(markSessionReadAtom, childSessionId);

      // Select the parent workstream
      setSelectedWorkstream({
        workspacePath,
        selection: { type: parentType, id: parentId },
      });
    }
  }, [workspacePath, setSelectedWorkstream]);

  // Handle session selection from list (for root sessions/workstreams)
  // Also handles child sessions by detecting parentSessionId and redirecting to parent
  const handleSessionSelect = useCallback((sessionId: string) => {
    // Check if this is a child session - if so, redirect to the parent workstream
    const registry = store.get(sessionRegistryAtom);
    const sessionMeta = registry.get(sessionId);
    if (sessionMeta?.parentSessionId) {
      // Blitz children have worktreeId - select directly as worktree sessions
      // so they get full worktree UI (git operations, terminal, merge buttons)
      if (sessionMeta.worktreeId) {
        const state = store.get(workstreamStateAtom(sessionId));
        if (state.type !== 'worktree') {
          store.set(workstreamStateAtom(sessionId), {
            type: 'worktree',
            worktreeId: sessionMeta.worktreeId,
          });
        }
        store.set(setWorktreeActiveSessionAtom, {
          worktreeId: sessionMeta.worktreeId,
          sessionId,
        });
        setSelectedWorkstream({
          workspacePath,
          selection: { type: 'worktree', id: sessionId },
        });
        return;
      }

      // Non-worktree child session - select the parent workstream instead
      handleChildSessionSelect(sessionId, sessionMeta.parentSessionId, 'workstream');
      return;
    }

    // Determine the actual type by checking the workstream state
    const state = store.get(workstreamStateAtom(sessionId));
    // Map internal state type ('single') to selection type ('session')
    const type = state.type === 'worktree' ? 'worktree'
      : state.type === 'workstream' ? 'workstream'
      : 'session';

    // Track active session for worktree (for "return to last session" feature)
    const sessionData = store.get(sessionStoreAtom(sessionId));
    if (sessionData?.worktreeId) {
      store.set(setWorktreeActiveSessionAtom, {
        worktreeId: sessionData.worktreeId,
        sessionId,
      });
    }

    setSelectedWorkstream({
      workspacePath,
      selection: { type, id: sessionId },
    });
  }, [workspacePath, setSelectedWorkstream, handleChildSessionSelect]);

  // Branch a session - creates a fork at the current message
  const handleSessionBranch = useCallback(async (sessionId: string) => {
    try {
      // console.log('[AgentMode] Branching session:', sessionId);

      // Call IPC to create a branch
      const result = await window.electronAPI.invoke('sessions:branch', {
        parentSessionId: sessionId,
        workspacePath
      });

      if (result.success && result.session) {
        // console.log('[AgentMode] Branch created:', result.session.id);

        // Refresh session list to show the new branch
        refreshSessions();

        // Open the new branch
        await openSessionInTab(result.session.id);
      } else {
        console.error('[AgentMode] Failed to branch session:', result.error);
        errorNotificationService.showError('Failed to branch conversation', result.error || 'Unknown error');
      }
    } catch (err) {
      console.error('[AgentMode] Error branching session:', err);
      errorNotificationService.showError('Failed to branch conversation', String(err));
    }
  }, [workspacePath, refreshSessions, openSessionInTab]);

  // Delete a session
  const handleSessionDelete = useCallback(async (sessionId: string) => {
    try {
      const result = await window.electronAPI.invoke('sessions:delete', sessionId);
      if (result.success) {
        // Remove from atom store
        removeSessionFromAtom(sessionId);

        // If this was the selected session, clear selection
        if (selectedWorkstream?.id === sessionId) {
          setSelectedWorkstream({ workspacePath, selection: null });
        }
      } else {
        console.error('[AgentMode] Failed to delete session:', result.error);
        errorNotificationService.showError('Failed to delete session', result.error || 'Unknown error');
      }
    } catch (err) {
      console.error('[AgentMode] Error deleting session:', err);
      errorNotificationService.showError('Failed to delete session', String(err));
    }
  }, [removeSessionFromAtom, selectedWorkstream, workspacePath, setSelectedWorkstream]);

  // Archive a session
  const handleSessionArchive = useCallback(async (sessionId: string) => {
    try {
      const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: true });
      if (result.success) {
        // Update in atom store (syncs both sessionStoreAtom and sessionRegistryAtom)
        updateSessionStore({ sessionId, updates: { isArchived: true } });

        // If this was the selected session, clear selection
        if (selectedWorkstream?.id === sessionId) {
          setSelectedWorkstream({ workspacePath, selection: null });
        }
      } else {
        console.error('[AgentMode] Failed to archive session:', result.error);
      }
    } catch (err) {
      console.error('[AgentMode] Error archiving session:', err);
    }
  }, [updateSessionStore, selectedWorkstream, workspacePath, setSelectedWorkstream]);

  // Rename a session
  const [renamedSession, setRenamedSession] = useState<{ id: string; title: string } | null>(null);
  const handleSessionRename = useCallback(async (sessionId: string, newName: string) => {
    try {
      const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, { title: newName });
      if (result.success) {
        // Update in atom store (syncs both sessionStoreAtom and sessionRegistryAtom)
        updateSessionStore({ sessionId, updates: { title: newName, updatedAt: Date.now() } });
        // Sub-sessions render from SessionHistory's workstreamChildrenCache, not from
        // sessionRegistryAtom. The cache only patches when its `renamedSession` prop
        // changes, so trigger that here.
        setRenamedSession({ id: sessionId, title: newName });
      } else {
        console.error('[AgentMode] Failed to rename session:', result.error);
      }
    } catch (err) {
      console.error('[AgentMode] Error renaming session:', err);
    }
  }, [updateSessionStore]);

  // Expose ref methods
  useImperativeHandle(ref, () => ({
    createNewSession,
    createNewWorktreeSession,
    openSessionInTab,
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
  }), [createNewSession, createNewWorktreeSession, openSessionInTab, workspacePath, setSelectedWorkstream]);

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

  // Content for the right side
  const rightContent = selectedWorkstream ? (
    isSelectedMetaAgent ? (
      <MetaAgentMode
        key={selectedWorkstream.id}
        workspacePath={workspacePath}
        isActive={isActive}
        sessionId={selectedWorkstream.id}
        onOpenSessionInAgent={(sessionId) => handleSessionSelect(sessionId)}
      />
    ) : (
      <AgentWorkstreamPanel
        ref={workstreamPanelRef}
        workspacePath={workspacePath}
        workstreamId={selectedWorkstream.id}
        workstreamType={selectedWorkstream.type}
        onFileOpen={onFileOpen}
        onAddSessionToWorktree={addSessionToWorktree}
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
        onClick={() => createNewSession()}
        className="agent-mode-new-button py-2 px-4 rounded-md border border-nim-border bg-nim-bg-secondary text-nim cursor-pointer text-sm transition-colors hover:bg-nim-bg-active"
      >
        New Session
      </button>
    </div>
  );

  // Content for the left side (session history)
  // Only pass worktree props if the feature is available (developer mode + feature enabled)
  const leftContent = (
    <SessionHistory
      workspacePath={workspacePath}
      activeSessionId={actualActiveSessionId}
      onSessionSelect={handleSessionSelect}
      onChildSessionSelect={handleChildSessionSelect}
      onSessionDelete={handleSessionDelete}
      onSessionArchive={handleSessionArchive}
      onSessionRename={handleSessionRename}
      renamedSession={renamedSession}
      onSessionBranch={handleSessionBranch}
      onNewSession={createNewSession}
      onNewWorktreeSession={isWorktreesAvailable ? createNewWorktreeSession : undefined}
      onNewBlitz={isBlitzAvailable ? createNewBlitz : undefined}
      onAddSessionToWorktree={isWorktreesAvailable ? addSessionToWorktree : undefined}
      isGitRepo={isGitRepo}
      collapsedGroups={collapsedGroups}
      onCollapsedGroupsChange={(groups) => setCollapsedGroups(groups)}
      sortOrder={sortOrder}
      onSortOrderChange={(order) => setSortOrder(order)}
      onOpenQuickSearch={onOpenQuickSearch}
      mode="agent"
    />
  );

  const viewMode = useAtomValue(viewModeAtom);

  // Double-click a kanban card: select the session (kanban exit is handled
  // globally by registerWorkstreamSelectedHook in setSelectedWorkstreamAtom)
  const handleKanbanSessionOpen = useCallback((sessionId: string) => {
    handleSessionSelect(sessionId);
  }, [handleSessionSelect]);

  const kanbanContent = (
    <SessionKanbanBoard
      onSessionSelect={handleSessionSelect}
      onSessionOpen={handleKanbanSessionOpen}
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
        isOpen={showBlitzDialog}
        onClose={() => setShowBlitzDialog(false)}
        onCreated={handleBlitzCreated}
        workspacePath={workspacePath}
      />
    </div>
  );
});
