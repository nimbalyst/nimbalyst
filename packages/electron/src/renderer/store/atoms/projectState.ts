/**
 * Project State Atom
 *
 * Holds in-memory project state with per-field persistence via workspace:update-state IPC.
 * Each setter atom that needs persistence calls workspace:update-state directly
 * (the same pattern used by every other piece of state that survives restart).
 *
 * Types are still exported for use elsewhere even when the atom itself is internal.
 */

import { atom } from 'jotai';
import type { EditorKey, EditorContext } from '@nimbalyst/runtime/store';

/**
 * Tab information for persistence.
 */
export interface PersistedTabInfo {
  key: EditorKey;
  isPinned: boolean;
}

/**
 * Per-context tab state.
 */
export interface ContextTabState {
  tabs: PersistedTabInfo[];
  activeTabKey: EditorKey | null;
}

/**
 * Panel layout configuration.
 */
export interface PanelLayout {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  aiPanelWidth: number;
  aiPanelCollapsed: boolean;
}

/**
 * File tree UI state.
 */
export interface FileTreeState {
  expandedDirs: string[];
  activeFilter: string | null;
}

/**
 * Diff tree view settings.
 */
export interface DiffTreeState {
  groupByDirectory: boolean;
}

/**
 * FileGutter (referenced/edited file lists in chat) collapsed state per type.
 */
export type FileGutterType = 'referenced' | 'edited';
export type FileGutterCollapsedState = Partial<Record<FileGutterType, boolean>>;

/**
 * File scope mode for the Files Edited sidebar in agent mode.
 * - current-changes: Show only files with uncommitted git changes (default)
 * - session-files: Show all files touched in this session/workstream
 * - all-changes: Show all uncommitted files in the repository
 */
export type AgentFileScopeMode = 'current-changes' | 'session-files' | 'all-changes';

/**
 * Agent mode settings for the Files Edited sidebar.
 */
export interface AgentModeSettings {
  fileScopeMode: AgentFileScopeMode;
}

/**
 * IDs of gutter buttons that can be hidden via context menu.
 * Mode buttons (files, agent, tracker) and user menu are not hideable.
 */
export type HideableGutterButton =
  | 'voice-mode'
  | 'trust-indicator'
  | 'sync-status'
  | 'theme-toggle'
  | 'feedback'
  | 'claude-usage'
  | 'codex-usage'
  | 'gemini-usage'
  | 'extension-dev';

/**
 * Complete project state.
 */
export interface ProjectState {
  version: number;
  contexts: Record<EditorContext, ContextTabState>;
  layout: PanelLayout;
  fileTree: FileTreeState;
  diffTree: DiffTreeState;
  fileGutterCollapsed: FileGutterCollapsedState;
  agentMode: AgentModeSettings;
  lastOpenedFile: string | null;
  recentFiles: string[];
  /** Gutter buttons hidden by the user via context menu */
  hiddenGutterButtons: HideableGutterButton[];
}

/**
 * Default project state values.
 */
const defaultProjectState: ProjectState = {
  version: 1,
  contexts: {
    main: {
      tabs: [],
      activeTabKey: null,
    },
  },
  layout: {
    sidebarWidth: 250,
    sidebarCollapsed: false,
    aiPanelWidth: 400,
    aiPanelCollapsed: true,
  },
  fileTree: {
    expandedDirs: [],
    activeFilter: null,
  },
  diffTree: {
    groupByDirectory: true,
  },
  fileGutterCollapsed: {},
  agentMode: {
    fileScopeMode: 'session-files',
  },
  lastOpenedFile: null,
  recentFiles: [],
  hiddenGutterButtons: [],
};

/**
 * The main project state atom (in-memory only).
 */
export const projectStateAtom = atom<ProjectState>(defaultProjectState);

// === Derived read-only atoms ===

/**
 * Diff tree group by directory setting.
 */
export const diffTreeGroupByDirectoryAtom = atom(
  (get) => get(projectStateAtom).diffTree.groupByDirectory
);

/**
 * FileGutter collapsed state map.
 */
export const fileGutterCollapsedAtom = atom(
  (get) => get(projectStateAtom).fileGutterCollapsed ?? {}
);

/**
 * Agent mode file scope mode setting.
 */
export const agentFileScopeModeAtom = atom(
  (get) => get(projectStateAtom).agentMode.fileScopeMode
);

/**
 * Which gutter buttons are currently hidden.
 */
export const hiddenGutterButtonsAtom = atom(
  (get) => get(projectStateAtom).hiddenGutterButtons ?? []
);

// === Setter atoms (each persists its own field via workspace:update-state) ===

/**
 * Set diff tree group by directory.
 * Persists to workspace state via IPC.
 */
export const setDiffTreeGroupByDirectoryAtom = atom(
  null,
  (get, set, payload: { groupByDirectory: boolean; workspacePath: string }) => {
    const { groupByDirectory, workspacePath } = payload;
    const state = get(projectStateAtom);
    set(projectStateAtom, {
      ...state,
      diffTree: { ...state.diffTree, groupByDirectory },
    });
    if (workspacePath && typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.invoke('workspace:update-state', workspacePath, {
        diffTreeGroupByDirectory: groupByDirectory,
      }).catch((err: unknown) => {
        console.error('[projectState] Failed to persist diffTreeGroupByDirectory:', err);
      });
    }
  }
);

/**
 * Set FileGutter collapsed state for a given type.
 * Persists to workspace state via IPC.
 */
export const setFileGutterCollapsedAtom = atom(
  null,
  (get, set, payload: { type: FileGutterType; collapsed: boolean; workspacePath: string }) => {
    const { type, collapsed, workspacePath } = payload;
    const state = get(projectStateAtom);
    const nextMap: FileGutterCollapsedState = {
      ...(state.fileGutterCollapsed ?? {}),
      [type]: collapsed,
    };
    set(projectStateAtom, {
      ...state,
      fileGutterCollapsed: nextMap,
    });
    if (workspacePath && typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.invoke('workspace:update-state', workspacePath, {
        fileGutterCollapsed: { [type]: collapsed },
      }).catch((err: unknown) => {
        console.error('[projectState] Failed to persist fileGutterCollapsed:', err);
      });
    }
  }
);

/**
 * Hydrate FileGutter collapsed state from persisted workspace state.
 * Called on startup hydration.
 */
export const hydrateFileGutterCollapsedAtom = atom(
  null,
  (get, set, value: FileGutterCollapsedState) => {
    const state = get(projectStateAtom);
    set(projectStateAtom, { ...state, fileGutterCollapsed: { ...value } });
  }
);

/**
 * Set agent file scope mode.
 * Persists to workspace state via IPC.
 */
export const setAgentFileScopeModeAtom = atom(
  null,
  (get, set, payload: { fileScopeMode: AgentFileScopeMode; workspacePath: string }) => {
    const { fileScopeMode, workspacePath } = payload;
    const state = get(projectStateAtom);
    set(projectStateAtom, {
      ...state,
      agentMode: { ...state.agentMode, fileScopeMode },
    });
    if (workspacePath && typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.invoke('workspace:update-state', workspacePath, {
        agentFileScopeMode: fileScopeMode,
      }).catch((err: unknown) => {
        console.error('[projectState] Failed to persist agentFileScopeMode:', err);
      });
    }
  }
);

/**
 * Set hidden gutter buttons from persisted workspace state.
 * Called on startup hydration.
 */
export const setHiddenGutterButtonsAtom = atom(
  null,
  (get, set, buttons: HideableGutterButton[]) => {
    const state = get(projectStateAtom);
    set(projectStateAtom, { ...state, hiddenGutterButtons: buttons });
  }
);

/**
 * Toggle a gutter button's hidden state.
 * Persists to workspace state via IPC.
 */
export const toggleGutterButtonHiddenAtom = atom(
  null,
  (get, set, payload: { buttonId: HideableGutterButton; workspacePath: string }) => {
    const { buttonId, workspacePath } = payload;
    const state = get(projectStateAtom);
    const current = state.hiddenGutterButtons ?? [];
    const hidden = current.includes(buttonId)
      ? current.filter((id) => id !== buttonId)
      : [...current, buttonId];
    set(projectStateAtom, { ...state, hiddenGutterButtons: hidden });
    if (workspacePath && typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.invoke('workspace:update-state', workspacePath, {
        hiddenGutterButtons: hidden,
      }).catch((err: unknown) => {
        console.error('[projectState] Failed to persist hiddenGutterButtons:', err);
      });
    }
  }
);

/**
 * Show all hidden gutter buttons (reset).
 * Persists to workspace state via IPC.
 */
export const showAllGutterButtonsAtom = atom(
  null,
  (get, set, workspacePath: string) => {
    const state = get(projectStateAtom);
    set(projectStateAtom, { ...state, hiddenGutterButtons: [] });
    if (workspacePath && typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.invoke('workspace:update-state', workspacePath, {
        hiddenGutterButtons: [],
      }).catch((err: unknown) => {
        console.error('[projectState] Failed to persist hiddenGutterButtons:', err);
      });
    }
  }
);
