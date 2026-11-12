/**
 * Terminal Atoms
 *
 * State management for terminal instances and panel UI using Jotai.
 * Provides reactive updates when terminals are created, deleted, or modified.
 *
 * Key principle: Backend emits IPC events, atoms update, UI re-renders.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from './openProjects';

/**
 * Terminal instance metadata
 */
export interface TerminalInstance {
  id: string;
  title: string;
  shellName: string;
  shellPath: string;
  cwd: string;
  worktreeId?: string;
  worktreeName?: string;
  createdAt: number;
  lastActiveAt: number;
  historyFile?: string;
  cols?: number;
  rows?: number;
}

/**
 * Terminal workspace state
 */
export interface TerminalWorkspaceState {
  terminals: Record<string, TerminalInstance>;
  activeTerminalId?: string;
  tabOrder: string[];
}

/**
 * Main atom for terminal list (sorted by tab order)
 */
export const terminalListAtom = atom<TerminalInstance[]>([]);

/**
 * The project that `terminalListAtom` was loaded for (GitHub #1818).
 *
 * One window can switch between projects, but the terminal list is shared by the
 * whole window. After a switch, the list still holds the old project's terminals
 * until the new project's list arrives. Readers compare this value with their own
 * project and ignore the list when the two differ.
 */
export const terminalListWorkspaceAtom = atom<string | undefined>(undefined);

/**
 * The terminals that belong to `workspacePath`. Returns an empty list while the
 * shared list still belongs to another project, so a terminal is never shown, or
 * started, inside the wrong project. The empty list is one shared array so
 * callers can use the result as a hook dependency.
 */
const NO_TERMINALS: TerminalInstance[] = [];

export function terminalsForWorkspace(
  terminals: TerminalInstance[],
  listWorkspacePath: string | undefined,
  workspacePath: string
): TerminalInstance[] {
  return listWorkspacePath === workspacePath ? terminals : NO_TERMINALS;
}

/**
 * Active terminal ID atom
 */
export const activeTerminalIdAtom = atom<string | undefined>(undefined);

// --- Terminal Panel UI State ---

interface TerminalPanelState {
  visible: boolean;
  height: number;
  /** Whether this project's state has been loaded from persistent storage. */
  hydrated: boolean;
}

/**
 * Bottom terminal panel state, one per project. A multi-project window switches
 * projects without remounting, so a single window-wide value would carry one
 * project's open panel into the next project.
 */
export const terminalPanelStateAtomFamily = atomFamily((_workspacePath: string) =>
  atom<TerminalPanelState>({ visible: false, height: 300, hydrated: false })
);

const activeTerminalPanelStateAtom = atom((get) =>
  terminalPanelStateAtomFamily(get(activeWorkspacePathAtom) ?? '')
);

/**
 * Terminal panel visibility for the visible project. Writes persist to that
 * project once its stored state has loaded.
 */
export const terminalPanelVisibleAtom = atom(
  (get) => get(get(activeTerminalPanelStateAtom)).visible,
  (get, set, update: boolean | ((previous: boolean) => boolean)) => {
    const workspacePath = get(activeWorkspacePathAtom);
    const stateAtom = get(activeTerminalPanelStateAtom);
    const state = get(stateAtom);
    const visible = typeof update === 'function' ? update(state.visible) : update;
    if (visible === state.visible) return;
    set(stateAtom, { ...state, visible });
    if (workspacePath && state.hydrated) {
      window.electronAPI?.terminal?.setPanelVisible(workspacePath, visible);
    }
  }
);

/**
 * Terminal panel height for the visible project
 */
export const terminalPanelHeightAtom = atom(
  (get) => get(get(activeTerminalPanelStateAtom)).height
);

/**
 * Whether the visible project's terminal panel state has been hydrated from persistent storage
 */
export const terminalPanelHydratedAtom = atom(
  (get) => get(get(activeTerminalPanelStateAtom)).hydrated
);

/**
 * Set the panel height for a project while resizing. Persisting is left to the
 * caller so a drag writes once.
 */
export function setTerminalPanelHeight(workspacePath: string, height: number): void {
  store.set(terminalPanelStateAtomFamily(workspacePath), (prev) => ({ ...prev, height }));
}

/**
 * Toggle terminal panel visibility (write-only atom)
 */
export const toggleTerminalPanelAtom = atom(null, (_get, set) => {
  set(terminalPanelVisibleAtom, (prev) => !prev);
});

/**
 * Close terminal panel (write-only atom)
 */
export const closeTerminalPanelAtom = atom(null, (_get, set) => {
  set(terminalPanelVisibleAtom, false);
});

/**
 * Open terminal panel (write-only atom)
 */
export const openTerminalPanelAtom = atom(null, (_get, set) => {
  set(terminalPanelVisibleAtom, true);
});

/**
 * Load a project's terminal panel state from the backend. A project that is
 * already loaded keeps its in-memory state, which every change has persisted.
 */
export async function loadTerminalPanelState(workspacePath: string): Promise<void> {
  const stateAtom = terminalPanelStateAtomFamily(workspacePath);
  if (store.get(stateAtom).hydrated) return;
  let loaded: { panelVisible?: boolean; panelHeight?: number } | undefined;
  try {
    loaded = await window.electronAPI?.terminal?.getPanelState?.(workspacePath);
  } catch (error) {
    console.error('[terminals] Failed to load terminal panel state:', error);
  }
  store.set(stateAtom, (prev) => ({
    visible: loaded?.panelVisible ?? prev.visible,
    height: loaded?.panelHeight ?? prev.height,
    hydrated: true,
  }));
}

/**
 * Atom family for tracking command running state per terminal
 * Each terminal has its own atom to avoid unnecessary re-renders
 */
export const terminalCommandRunningAtom = atomFamily((terminalId: string) =>
  atom(false)
);

/**
 * Update command running state for a terminal
 */
export function setTerminalCommandRunning(terminalId: string, isRunning: boolean): void {
  store.set(terminalCommandRunningAtom(terminalId), isRunning);
}

// --- claude-code-cli raw-terminal drawer (NIM-810) ---

/**
 * Per-session expand/collapse for the `claude-code-cli` raw-terminal drawer.
 * Lifted out of SessionTranscript local state so the central reveal listener can
 * drive it. Default EXPANDED preserves prior behavior (the strip's
 * IntersectionObserver must fire to spawn the CLI).
 */
export const cliTerminalExpandedAtom = atomFamily((_sessionId: string) => atom(true));

/**
 * Per-session focus pulse: the reveal listener bumps this so the mounted xterm
 * grabs focus (keyboard nav must reach the native picker). A counter, not a flag,
 * so repeated reveals each re-focus.
 */
export const cliTerminalFocusNonceAtom = atomFamily((_sessionId: string) => atom(0));

/**
 * Marks that the drawer's current expansion was AUTO-triggered from a collapsed
 * state (interactive picker). Drives next-normal-prompt collapse without
 * regressing a drawer the user (or the default) left expanded.
 */
export const cliTerminalAutoRevealedAtom = atomFamily((_sessionId: string) => atom(false));

/**
 * Sticky per-session "the user explicitly closed the drawer" flag (NIM-820).
 * Output-sourced reveal signals (the PTY picker sniffer) must NOT reopen a
 * drawer the user closed; an input-sourced interactive reveal (the user typed
 * /model) clears it. Hydrated from session metadata (`cliRawTerminalCollapsed`)
 * alongside the expanded state.
 */
export const cliTerminalUserCollapsedAtom = atomFamily((_sessionId: string) => atom(false));

/**
 * Shared user-toggle for the CLI raw-terminal drawer (NIM-820) — used by both
 * the drawer header button and the keyboard shortcut so they keep the sticky
 * user-collapsed flag and the persisted metadata in sync.
 */
export const toggleCliTerminalDrawerAtom = atom(null, (get, set, sessionId: string) => {
  const next = !get(cliTerminalExpandedAtom(sessionId));
  set(cliTerminalExpandedAtom(sessionId), next);
  set(cliTerminalUserCollapsedAtom(sessionId), !next);
  // Manual toggle is a user decision — clear the auto-reveal flag so the next
  // normal prompt does not yank the drawer closed (NIM-810).
  set(cliTerminalAutoRevealedAtom(sessionId), false);
  // Persist (merge-style metadata update main-side). Best-effort.
  void window.electronAPI
    .invoke('sessions:update-metadata', sessionId, { cliRawTerminalCollapsed: !next })
    .catch((err: unknown) => {
      console.warn('[terminals] Failed to persist cliRawTerminalCollapsed:', err);
    });
});

/** Default / clamp bounds for the resizable raw-terminal drawer body (px). */
export const DEFAULT_CLI_TERMINAL_HEIGHT = 300;
export const MIN_CLI_TERMINAL_HEIGHT = 120;
export const MAX_CLI_TERMINAL_HEIGHT = 900;

/**
 * Per-session height (px) of the `claude-code-cli` raw-terminal drawer body.
 * Hydrated from session metadata (`cliRawTerminalHeight`) on mount and persisted
 * back on resize. In-memory default applies to brand-new sessions.
 */
export const cliTerminalHeightAtom = atomFamily((_sessionId: string) =>
  atom(DEFAULT_CLI_TERMINAL_HEIGHT)
);

// Counts load calls so a slow answer for an old project cannot overwrite the
// answer for the current project (GitHub #1818).
let latestLoadNumber = 0;

/**
 * Load terminals from backend and update atoms
 */
export async function loadTerminals(workspacePath: string): Promise<void> {
  const loadNumber = ++latestLoadNumber;
  try {
    const state = await window.electronAPI.terminal.getWorkspaceState(workspacePath);
    // A newer load started while this one waited. Its answer wins.
    if (loadNumber !== latestLoadNumber) return;
    const terminalList = state.tabOrder
      .map((id: string) => state.terminals[id])
      .filter((t: TerminalInstance | undefined): t is TerminalInstance => t !== undefined);

    // Set the list first and its project second, so a reader never sees a new
    // project name paired with the previous project's list.
    store.set(terminalListAtom, terminalList);
    store.set(terminalListWorkspaceAtom, workspacePath);
    store.set(activeTerminalIdAtom, state.activeTerminalId);
  } catch (error) {
    console.error('[terminals] Failed to load terminals:', error);
  }
}

/**
 * Remove a terminal from the list (optimistic update)
 */
export function removeTerminalFromList(terminalId: string): void {
  store.set(terminalListAtom, (prev) => prev.filter((t) => t.id !== terminalId));

  // Update active terminal if the removed one was active
  const activeId = store.get(activeTerminalIdAtom);
  if (activeId === terminalId) {
    const remaining = store.get(terminalListAtom);
    store.set(activeTerminalIdAtom, remaining[0]?.id);
  }
}

/**
 * Add a terminal to the list (optimistic update)
 */
export function addTerminalToList(terminal: TerminalInstance): void {
  store.set(terminalListAtom, (prev) => [...prev, terminal]);
}

/**
 * Set the active terminal
 */
export function setActiveTerminal(terminalId: string | undefined): void {
  store.set(activeTerminalIdAtom, terminalId);
}

/**
 * Initialize terminal IPC listeners
 * Call this once at app startup to listen for backend events
 */
export function initTerminalListeners(workspacePath: string): () => void {
  // Listen for terminal list changes (e.g., when worktree is archived)
  // Note: electronAPI.on strips the event object, so data is the first arg
  const handleTerminalListChanged = (data: { workspacePath: string }) => {
    if (data.workspacePath === workspacePath) {
      loadTerminals(workspacePath).catch((err: unknown) => {
        console.error('[terminals] Failed to reload terminals after list change:', err);
      });
    }
  };

  const unsubscribe = window.electronAPI.on('terminal:list-changed', handleTerminalListChanged);

  // Return cleanup function
  return () => {
    unsubscribe();
  };
}
