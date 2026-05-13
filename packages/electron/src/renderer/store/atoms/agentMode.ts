/**
 * Agent Mode State Atoms
 *
 * Centralized state management for agent mode layout and UI state.
 * This replaces useState variables in AgenticPanel that were causing
 * unnecessary re-renders and prop drilling.
 *
 * Pattern: "blob atom" - single atom for related state, derived atoms for slices.
 *
 * @example
 * // Read layout values
 * const width = useAtomValue(sessionHistoryWidthAtom);
 *
 * // Update layout
 * const updateLayout = useSetAtom(setAgentModeLayoutAtom);
 * updateLayout({ sessionHistoryWidth: 300 });
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';
import { selectedWorkstreamAtom, type WorkstreamType } from './sessions';
import { sessionStoreAtom } from './sessions';
import { activeWorkspacePathAtom } from './openProjects';
import type { TeammateInfo } from '../../components/AgentMode/TeammatePanel';

// ============================================================
// Types
// ============================================================

/**
 * Layout state for agent mode session history panel.
 * This shape is used both at runtime and for persistence.
 */
export interface SessionHistoryLayout {
  width: number;
  collapsed: boolean;
  preCollapseWidth?: number;
  collapsedGroups: string[];
  sortOrder: 'updated' | 'created';
  viewMode: 'list' | 'kanban';
}

/**
 * Full agent mode layout state.
 * This shape is used both at runtime and for persistence.
 */
export interface AgentModeLayout {
  sessionHistoryLayout: SessionHistoryLayout;
  filesEditedWidth: number;
  todoPanelCollapsed: boolean;
  teammatePanelCollapsed: boolean;
  agentPanelCollapsed: boolean;
  trackerPanelCollapsed: boolean;
}

// ============================================================
// Main Layout Atom
// ============================================================

const DEFAULT_SESSION_HISTORY_LAYOUT: SessionHistoryLayout = {
  width: 240,
  collapsed: false,
  preCollapseWidth: undefined,
  collapsedGroups: [],
  sortOrder: 'updated',
  viewMode: 'list',
};

const DEFAULT_LAYOUT: AgentModeLayout = {
  sessionHistoryLayout: DEFAULT_SESSION_HISTORY_LAYOUT,
  filesEditedWidth: 256,
  todoPanelCollapsed: false,
  teammatePanelCollapsed: false,
  agentPanelCollapsed: false,
  trackerPanelCollapsed: false,
};

/**
 * Deep merge persisted state with defaults.
 * Handles missing fields from old persisted data.
 */
function mergeWithDefaults(persisted: Partial<AgentModeLayout> | undefined): AgentModeLayout {
  const sessionHistoryLayout: SessionHistoryLayout = {
    ...DEFAULT_SESSION_HISTORY_LAYOUT,
    ...persisted?.sessionHistoryLayout,
    // The retired 'card' view mode coerces to 'list' on load.
    viewMode: persisted?.sessionHistoryLayout?.viewMode === 'kanban' ? 'kanban' : 'list',
  };
  // Only pick known layout fields from persisted data.
  // agenticCodingWindowState stores both layout AND selectedWorkstream at the same level.
  // Blindly spreading ...persisted would pull selectedWorkstream into the layout object,
  // and schedulePersist would write it back, overwriting newer selections.
  return {
    sessionHistoryLayout,
    filesEditedWidth: persisted?.filesEditedWidth ?? DEFAULT_LAYOUT.filesEditedWidth,
    todoPanelCollapsed: persisted?.todoPanelCollapsed ?? DEFAULT_LAYOUT.todoPanelCollapsed,
    teammatePanelCollapsed: persisted?.teammatePanelCollapsed ?? DEFAULT_LAYOUT.teammatePanelCollapsed,
    agentPanelCollapsed: persisted?.agentPanelCollapsed ?? DEFAULT_LAYOUT.agentPanelCollapsed,
    trackerPanelCollapsed: persisted?.trackerPanelCollapsed ?? DEFAULT_LAYOUT.trackerPanelCollapsed,
  };
}

/**
 * Per-workspace agent mode layout. Keep-warm switching needs each open
 * project to retain its own layout while inactive, so the layout state is
 * keyed by workspace path.
 */
export const agentModeLayoutAtomFamily = atomFamily((_workspacePath: string) =>
  atom<AgentModeLayout>(DEFAULT_LAYOUT)
);

/** Drop the cached layout slot for a workspace (called on rail close). */
export function pruneAgentModeWorkspaceState(workspacePath: string): void {
  agentModeLayoutAtomFamily.remove(workspacePath);
}

/**
 * Read+write proxy that resolves to the active workspace's layout slot.
 * Existing callers that import `agentModeLayoutAtom` keep working — the
 * proxy reads/writes the family entry for whatever path is in
 * `activeWorkspacePathAtom`.
 */
export const agentModeLayoutAtom = atom<AgentModeLayout, [AgentModeLayout], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return DEFAULT_LAYOUT;
    return get(agentModeLayoutAtomFamily(path));
  },
  (get, set, value: AgentModeLayout) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(agentModeLayoutAtomFamily(path), value);
  }
);

// ============================================================
// Derived Atoms (read-only slices)
// ============================================================

/** Session history panel width */
export const sessionHistoryWidthAtom = atom(
  (get) => get(agentModeLayoutAtom).sessionHistoryLayout.width
);

/** Whether session history is collapsed */
export const sessionHistoryCollapsedAtom = atom(
  (get) => get(agentModeLayoutAtom).sessionHistoryLayout.collapsed
);

/** Files edited sidebar width */
export const filesEditedWidthAtom = atom(
  (get) => get(agentModeLayoutAtom).filesEditedWidth
);

/** Collapsed group keys */
export const collapsedGroupsAtom = atom(
  (get) => get(agentModeLayoutAtom).sessionHistoryLayout.collapsedGroups
);

/** Sort order for sessions */
export const sortOrderAtom = atom(
  (get) => get(agentModeLayoutAtom).sessionHistoryLayout.sortOrder
);

/** View mode for session history (list or kanban) */
export const viewModeAtom = atom(
  (get) => get(agentModeLayoutAtom).sessionHistoryLayout.viewMode
);

/** Whether the todo panel is collapsed */
export const todoPanelCollapsedAtom = atom(
  (get) => get(agentModeLayoutAtom).todoPanelCollapsed
);

/** Whether the teammate panel is collapsed */
export const teammatePanelCollapsedAtom = atom(
  (get) => get(agentModeLayoutAtom).teammatePanelCollapsed
);

/** Whether the agent panel is collapsed */
export const agentPanelCollapsedAtom = atom(
  (get) => get(agentModeLayoutAtom).agentPanelCollapsed
);

/** Whether the tracker panel is collapsed */
export const trackerPanelCollapsedAtom = atom(
  (get) => get(agentModeLayoutAtom).trackerPanelCollapsed
);

/** Per-session derived atom for current teammates from session metadata */
export const sessionTeammatesAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const session = get(sessionStoreAtom(sessionId));
    const raw = session?.metadata?.currentTeammates;
    return Array.isArray(raw) ? raw as TeammateInfo[] : [];
  })
);

/** Task info from SDK-native sub-agents (task_started/task_progress/task_notification) */
export interface TaskInfo {
  taskId: string;
  description: string;
  taskType?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  toolUseId?: string;
  toolCount: number;
  tokenCount: number;
  durationMs: number;
  lastToolName?: string;
  summary?: string;
}

/** Per-session derived atom for SDK-native sub-agent tasks from session metadata */
export const sessionTasksAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const session = get(sessionStoreAtom(sessionId));
    const raw = session?.metadata?.currentTasks;
    return Array.isArray(raw) ? raw as TaskInfo[] : [];
  })
);

/** Write-only atom to request scrolling to a teammate's spawn point in the transcript.
 *  Set by TeammatePanel on click, consumed by RichTranscriptView.  */
export const scrollToTeammateAtom = atom<{ sessionId: string; agentId: string } | null>(null);

/** Write-only atom to request scrolling to a specific message in the transcript.
 *  Set by PromptQuickOpen on select, consumed by SessionTranscript.  */
export const scrollToMessageAtom = atom<{ sessionId: string; timestamp: number } | null>(null);

/** Write-only atom to request navigating to a session by ID.
 *  Set by MarkdownRenderer link clicks (@@session references), consumed by AgentMode.  */
export const requestOpenSessionAtom = atom<string | null>(null);

// ============================================================
// Debounced Persistence
// ============================================================

// Per-workspace persist timers so a write to project A is not cancelled when
// the user switches to project B before the debounce fires.
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePersist(workspacePath: string, layout: AgentModeLayout): void {
  const existing = persistTimers.get(workspacePath);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(async () => {
    persistTimers.delete(workspacePath);
    try {
      const state = { agenticCodingWindowState: layout };
      await window.electronAPI.invoke('workspace:update-state', workspacePath, state);
    } catch (err) {
      console.error('[agentMode] Failed to persist layout:', err);
    }
  }, 500);

  persistTimers.set(workspacePath, timer);
}

// ============================================================
// Setter Atoms
// ============================================================

/**
 * Update session history layout with partial values.
 */
export const setSessionHistoryLayoutAtom = atom(
  null,
  (get, set, updates: Partial<SessionHistoryLayout>) => {
    const workspacePath = get(activeWorkspacePathAtom);
    const current = get(agentModeLayoutAtom);
    const newLayout: AgentModeLayout = {
      ...current,
      sessionHistoryLayout: { ...current.sessionHistoryLayout, ...updates },
    };

    set(agentModeLayoutAtom, newLayout);

    if (!workspacePath) {
      console.warn('[agentMode] Cannot persist layout - no active workspace');
      return;
    }
    schedulePersist(workspacePath, newLayout);
  }
);

/**
 * Update agent mode layout (top-level fields only).
 * For sessionHistoryLayout updates, use setSessionHistoryLayoutAtom.
 */
export const setAgentModeLayoutAtom = atom(
  null,
  (get, set, updates: { filesEditedWidth?: number }) => {
    const workspacePath = get(activeWorkspacePathAtom);
    const current = get(agentModeLayoutAtom);
    const newLayout = { ...current, ...updates };

    set(agentModeLayoutAtom, newLayout);

    if (!workspacePath) {
      console.warn('[agentMode] Cannot persist layout - no active workspace');
      return;
    }
    schedulePersist(workspacePath, newLayout);
  }
);

/**
 * Set session history width.
 */
export const setSessionHistoryWidthAtom = atom(
  null,
  (get, set, width: number) => {
    set(setSessionHistoryLayoutAtom, { width });
  }
);

/**
 * Set files edited sidebar width.
 */
export const setFilesEditedWidthAtom = atom(
  null,
  (get, set, width: number) => {
    const clampedWidth = Math.max(150, Math.min(500, width));
    set(setAgentModeLayoutAtom, { filesEditedWidth: clampedWidth });
  }
);

/**
 * Toggle a collapsed group.
 */
export const toggleCollapsedGroupAtom = atom(
  null,
  (get, set, groupKey: string) => {
    const current = get(collapsedGroupsAtom);
    const isCollapsed = current.includes(groupKey);
    const newGroups = isCollapsed
      ? current.filter((g) => g !== groupKey)
      : [...current, groupKey];
    set(setSessionHistoryLayoutAtom, { collapsedGroups: newGroups });
  }
);

/**
 * Set collapsed groups directly.
 */
export const setCollapsedGroupsAtom = atom(
  null,
  (get, set, groups: string[]) => {
    set(setSessionHistoryLayoutAtom, { collapsedGroups: groups });
  }
);

/**
 * Set sort order.
 */
export const setSortOrderAtom = atom(
  null,
  (get, set, sortOrder: 'updated' | 'created') => {
    set(setSessionHistoryLayoutAtom, { sortOrder });
  }
);

/**
 * Set view mode.
 */
export const setViewModeAtom = atom(
  null,
  (get, set, viewMode: 'list' | 'kanban') => {
    set(setSessionHistoryLayoutAtom, { viewMode });
  }
);

/**
 * Toggle todo panel collapsed state.
 */
export const toggleTodoPanelCollapsedAtom = atom(
  null,
  (get, set) => {
    const workspacePath = get(activeWorkspacePathAtom);
    const current = get(agentModeLayoutAtom);
    const newLayout = { ...current, todoPanelCollapsed: !current.todoPanelCollapsed };

    set(agentModeLayoutAtom, newLayout);

    if (!workspacePath) {
      console.warn('[agentMode] Cannot persist layout - no active workspace');
      return;
    }
    schedulePersist(workspacePath, newLayout);
  }
);

/**
 * Toggle teammate panel collapsed state.
 */
export const toggleTeammatePanelCollapsedAtom = atom(
  null,
  (get, set) => {
    const workspacePath = get(activeWorkspacePathAtom);
    const current = get(agentModeLayoutAtom);
    const newLayout = { ...current, teammatePanelCollapsed: !current.teammatePanelCollapsed };

    set(agentModeLayoutAtom, newLayout);

    if (!workspacePath) {
      console.warn('[agentMode] Cannot persist layout - no active workspace');
      return;
    }
    schedulePersist(workspacePath, newLayout);
  }
);

/**
 * Toggle agent panel collapsed state.
 */
export const toggleAgentPanelCollapsedAtom = atom(
  null,
  (get, set) => {
    const workspacePath = get(activeWorkspacePathAtom);
    const current = get(agentModeLayoutAtom);
    const newLayout = { ...current, agentPanelCollapsed: !current.agentPanelCollapsed };

    set(agentModeLayoutAtom, newLayout);

    if (!workspacePath) {
      console.warn('[agentMode] Cannot persist layout - no active workspace');
      return;
    }
    schedulePersist(workspacePath, newLayout);
  }
);

/**
 * Toggle tracker panel collapsed state.
 */
export const toggleTrackerPanelCollapsedAtom = atom(
  null,
  (get, set) => {
    const workspacePath = get(activeWorkspacePathAtom);
    const current = get(agentModeLayoutAtom);
    const newLayout = { ...current, trackerPanelCollapsed: !current.trackerPanelCollapsed };

    set(agentModeLayoutAtom, newLayout);

    if (!workspacePath) {
      console.warn('[agentMode] Cannot persist layout - no active workspace');
      return;
    }
    schedulePersist(workspacePath, newLayout);
  }
);

/**
 * Toggle session history collapsed state.
 * Preserves the width when collapsing and restores it when expanding.
 */
export const toggleSessionHistoryCollapsedAtom = atom(
  null,
  (get, set) => {
    const layout = get(agentModeLayoutAtom).sessionHistoryLayout;
    if (layout.collapsed) {
      // Expanding - restore previous width
      set(setSessionHistoryLayoutAtom, {
        collapsed: false,
        width: layout.preCollapseWidth ?? DEFAULT_SESSION_HISTORY_LAYOUT.width,
      });
    } else {
      // Collapsing - save current width
      set(setSessionHistoryLayoutAtom, {
        collapsed: true,
        preCollapseWidth: layout.width,
      });
    }
  }
);

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize agent mode layout from workspace state.
 * Call this when workspace path is known (typically in useEffect).
 * Restores layout settings and selected workstream.
 *
 * @param workspacePath The workspace whose layout should be loaded.
 * @param options.setActive When true (default), this workspace becomes the
 *   active path for the window. Pass `false` to warm-load a project for the
 *   project rail without stealing focus from the currently visible project.
 */
export async function initAgentModeLayout(
  workspacePath: string,
  options: { setActive?: boolean } = {}
): Promise<void> {
  const { setActive = true } = options;
  if (setActive) {
    store.set(activeWorkspacePathAtom, workspacePath);
  }

  try {
    const workspaceState = await window.electronAPI.invoke(
      'workspace:get-state',
      workspacePath
    );
    const agenticState = workspaceState?.agenticCodingWindowState;
    const persisted = agenticState as Partial<AgentModeLayout> | undefined;

    const restoredLayout = mergeWithDefaults(persisted);
    store.set(agentModeLayoutAtomFamily(workspacePath), restoredLayout);

    if (agenticState?.selectedWorkstream) {
      const selection = agenticState.selectedWorkstream as { type: WorkstreamType; id: string };
      store.set(selectedWorkstreamAtom(workspacePath), selection);
    }
  } catch (err) {
    console.error('[agentMode] Failed to load layout:', err);
  }
}
