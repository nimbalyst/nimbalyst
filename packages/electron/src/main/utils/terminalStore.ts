/**
 * Terminal Store - Manages terminal metadata and panel state
 *
 * This replaces the previous database-based terminal storage with a dedicated
 * electron-store for terminal metadata. Scrollback is stored separately in files
 * to prevent store bloat.
 *
 * Storage locations:
 * - Metadata: ~/Library/Application Support/@nimbalyst/electron/terminal-store.json
 * - Scrollback: ~/Library/Application Support/@nimbalyst/electron/terminal-scrollback/<terminalId>.scrollback
 */

import Store from 'electron-store';
import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';

// Constants
const SCROLLBACK_SUBDIR = 'terminal-scrollback';
const MAX_SCROLLBACK_SIZE = 500 * 1024; // 500KB

/**
 * Terminal instance metadata
 */
export interface TerminalInstance {
  /** Unique identifier (ULID) */
  id: string;
  /** User-visible name */
  title: string;
  /** Shell name (bash, zsh, pwsh, etc.) */
  shellName: string;
  /** Full path to shell binary */
  shellPath: string;
  /** Current working directory */
  cwd: string;
  /** Optional worktree association */
  worktreeId?: string;
  /** Worktree display name (for tab display when associated with a worktree) */
  worktreeName?: string;
  /** Creation timestamp (epoch ms) */
  createdAt: number;
  /** Last active timestamp (epoch ms) */
  lastActiveAt: number;
  /** Path to shell history file */
  historyFile?: string;
  /** Last known terminal width in columns */
  cols?: number;
  /** Last known terminal height in rows */
  rows?: number;
  /** Last known cursor column within the visible terminal viewport */
  cursorX?: number;
  /** Last known cursor row within the visible terminal viewport */
  cursorY?: number;
  /** Last known visible screen contents, one entry per terminal row */
  screenLines?: string[];
}

/**
 * Per-workspace terminal state
 */
export interface WorkspaceTerminalState {
  /** Map of terminal ID to terminal instance */
  terminals: Record<string, TerminalInstance>;
  /** Currently active terminal ID */
  activeTerminalId?: string;
  /** Tab order (array of terminal IDs) */
  tabOrder: string[];
  /** Panel height in pixels */
  panelHeight?: number;
  /** Whether panel is visible */
  panelVisible?: boolean;
}

/**
 * Terminal panel state (returned to renderer)
 */
export interface TerminalPanelState {
  /** Panel height in pixels */
  panelHeight: number;
  /** Whether panel is visible */
  panelVisible: boolean;
}

/**
 * Terminal store schema
 */
interface TerminalStoreSchema {
  /** Per-workspace terminal state (keyed by workspace path) */
  workspaces: Record<string, WorkspaceTerminalState>;
  /** @deprecated Global panel state - kept for migration, new state lives in per-workspace */
  panel: TerminalPanelState;
}

// Default values
const DEFAULT_PANEL_STATE: TerminalPanelState = {
  panelHeight: 300,
  panelVisible: false,
};

const DEFAULT_WORKSPACE_STATE: WorkspaceTerminalState = {
  terminals: {},
  activeTerminalId: undefined,
  tabOrder: [],
};

// Lazy-initialized store
let _terminalStore: Store<TerminalStoreSchema> | null = null;

/**
 * Get the terminal store instance (lazy initialization)
 */
function getTerminalStore(): Store<TerminalStoreSchema> {
  if (!_terminalStore) {
    _terminalStore = new Store<TerminalStoreSchema>({
      name: 'terminal-store',
      clearInvalidConfig: true,
      defaults: {
        workspaces: {},
        panel: DEFAULT_PANEL_STATE,
      },
    });
    console.log('[TerminalStore] Initialized at:', _terminalStore.path);
  }
  return _terminalStore;
}

// ============================================================================
// Workspace Terminal State
// ============================================================================

/**
 * Get workspace key from path (base64 encoded for safe storage)
 */
function workspaceKey(workspacePath: string): string {
  if (!workspacePath) {
    throw new Error('[TerminalStore] workspacePath is required');
  }
  const normalized = path.normalize(workspacePath).replace(/\/+$/, '');
  return Buffer.from(normalized).toString('base64url');
}

/**
 * Get terminal state for a workspace
 */
export function getWorkspaceTerminalState(workspacePath: string): WorkspaceTerminalState {
  const key = workspaceKey(workspacePath);
  const store = getTerminalStore();
  const workspaces = store.get('workspaces', {});
  return workspaces[key] ?? { ...DEFAULT_WORKSPACE_STATE, terminals: {}, tabOrder: [] };
}

/**
 * Save terminal state for a workspace
 */
export function saveWorkspaceTerminalState(workspacePath: string, state: WorkspaceTerminalState): void {
  const key = workspaceKey(workspacePath);
  const store = getTerminalStore();
  const workspaces = { ...store.get('workspaces', {}) };
  workspaces[key] = state;
  store.set('workspaces', workspaces);
}

/**
 * Update terminal state for a workspace (with updater function)
 */
export function updateWorkspaceTerminalState(
  workspacePath: string,
  updater: (state: WorkspaceTerminalState) => void | WorkspaceTerminalState
): WorkspaceTerminalState {
  const current = getWorkspaceTerminalState(workspacePath);
  const draft = structuredClone(current);
  const result = updater(draft) || draft;
  saveWorkspaceTerminalState(workspacePath, result);
  return result;
}

// ============================================================================
// Terminal Instance Management
// ============================================================================

/**
 * Create a new terminal instance
 */
export function createTerminalInstance(
  workspacePath: string,
  terminal: TerminalInstance
): TerminalInstance {
  return updateWorkspaceTerminalState(workspacePath, (state) => {
    state.terminals[terminal.id] = terminal;
    // Add to end of tab order
    if (!state.tabOrder.includes(terminal.id)) {
      state.tabOrder.push(terminal.id);
    }
    // Always set the newly created terminal as active
    state.activeTerminalId = terminal.id;
  }).terminals[terminal.id];
}

/**
 * Get a terminal instance by ID
 */
export function getTerminalInstance(
  workspacePath: string,
  terminalId: string
): TerminalInstance | undefined {
  const state = getWorkspaceTerminalState(workspacePath);
  return state.terminals[terminalId];
}

/**
 * Update a terminal instance
 */
export function updateTerminalInstance(
  workspacePath: string,
  terminalId: string,
  updates: Partial<Omit<TerminalInstance, 'id'>>
): TerminalInstance | undefined {
  let updated: TerminalInstance | undefined;
  updateWorkspaceTerminalState(workspacePath, (state) => {
    const terminal = state.terminals[terminalId];
    if (terminal) {
      updated = { ...terminal, ...updates, id: terminalId };
      state.terminals[terminalId] = updated;
    }
  });
  return updated;
}

/**
 * Delete a terminal instance
 */
export function deleteTerminalInstance(
  workspacePath: string,
  terminalId: string
): void {
  updateWorkspaceTerminalState(workspacePath, (state) => {
    delete state.terminals[terminalId];
    state.tabOrder = state.tabOrder.filter(id => id !== terminalId);
    // Update active terminal if deleted
    if (state.activeTerminalId === terminalId) {
      state.activeTerminalId = state.tabOrder[0];
    }
  });
  // Also delete scrollback file
  deleteScrollbackFile(terminalId).catch(err => {
    console.warn(`[TerminalStore] Failed to delete scrollback for ${terminalId}:`, err);
  });
}

/**
 * List all terminals for a workspace
 */
export function listTerminals(workspacePath: string): TerminalInstance[] {
  const state = getWorkspaceTerminalState(workspacePath);
  // Return in tab order
  return state.tabOrder
    .map(id => state.terminals[id])
    .filter((t): t is TerminalInstance => t !== undefined);
}

/**
 * Get all terminal IDs associated with a specific worktree
 */
export function getTerminalsByWorktreeId(workspacePath: string, worktreeId: string): string[] {
  const state = getWorkspaceTerminalState(workspacePath);
  return Object.values(state.terminals)
    .filter((t): t is TerminalInstance => t !== undefined && t.worktreeId === worktreeId)
    .map(t => t.id);
}

/**
 * Set the active terminal
 */
export function setActiveTerminal(workspacePath: string, terminalId: string | undefined): void {
  updateWorkspaceTerminalState(workspacePath, (state) => {
    state.activeTerminalId = terminalId;
  });
}

/**
 * Get the active terminal ID
 */
export function getActiveTerminalId(workspacePath: string): string | undefined {
  return getWorkspaceTerminalState(workspacePath).activeTerminalId;
}

/**
 * Update tab order
 */
export function setTabOrder(workspacePath: string, tabOrder: string[]): void {
  updateWorkspaceTerminalState(workspacePath, (state) => {
    state.tabOrder = tabOrder;
  });
}

// ============================================================================
// Panel State
// ============================================================================

/**
 * Get terminal panel state for a workspace.
 * Falls back to the legacy global panel state for migration, then to defaults.
 */
export function getTerminalPanelState(workspacePath: string): TerminalPanelState {
  const ws = getWorkspaceTerminalState(workspacePath);
  // If workspace has panel state, use it
  if (ws.panelVisible !== undefined || ws.panelHeight !== undefined) {
    return {
      panelHeight: ws.panelHeight ?? DEFAULT_PANEL_STATE.panelHeight,
      panelVisible: ws.panelVisible ?? DEFAULT_PANEL_STATE.panelVisible,
    };
  }
  // For workspaces with no saved panel state, use defaults (panel closed).
  // Previously fell back to the legacy global panel state, which caused
  // new projects to inherit panelVisible:true from unrelated workspaces.
  return { ...DEFAULT_PANEL_STATE };
}

/**
 * Update terminal panel state for a workspace
 */
export function updateTerminalPanelState(workspacePath: string, updates: Partial<TerminalPanelState>): TerminalPanelState {
  const current = getTerminalPanelState(workspacePath);
  const next = { ...current, ...updates };
  updateWorkspaceTerminalState(workspacePath, (state) => {
    if (updates.panelVisible !== undefined) state.panelVisible = updates.panelVisible;
    if (updates.panelHeight !== undefined) state.panelHeight = updates.panelHeight;
  });
  return next;
}

/**
 * Set panel visibility for a workspace
 */
export function setTerminalPanelVisible(workspacePath: string, visible: boolean): void {
  updateTerminalPanelState(workspacePath, { panelVisible: visible });
}

/**
 * Set panel height for a workspace
 */
export function setTerminalPanelHeight(workspacePath: string, height: number): void {
  updateTerminalPanelState(workspacePath, { panelHeight: height });
}

// ============================================================================
// Scrollback File Storage
// ============================================================================

let _scrollbackDirPromise: Promise<string> | null = null;

/**
 * Get the scrollback directory (creates if needed)
 */
async function getScrollbackDirectory(): Promise<string> {
  if (!_scrollbackDirPromise) {
    _scrollbackDirPromise = (async () => {
      if (!app.isReady()) {
        await app.whenReady();
      }
      const dir = path.join(app.getPath('userData'), SCROLLBACK_SUBDIR);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    })();
  }
  return _scrollbackDirPromise;
}

/**
 * Get scrollback file path for a terminal
 */
async function getScrollbackFilePath(terminalId: string): Promise<string> {
  const dir = await getScrollbackDirectory();
  return path.join(dir, `${terminalId}.scrollback`);
}

/**
 * Read scrollback from file
 */
export async function readScrollback(terminalId: string): Promise<string | null> {
  try {
    const filePath = await getScrollbackFilePath(terminalId);
    const content = await fs.readFile(filePath, 'utf8');
    // Truncate if over limit
    if (content.length > MAX_SCROLLBACK_SIZE) {
      return content.slice(-MAX_SCROLLBACK_SIZE);
    }
    return content;
  } catch (error) {
    // File doesn't exist is expected for new terminals
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    console.warn(`[TerminalStore] Error reading scrollback for ${terminalId}:`, error);
    return null;
  }
}

/**
 * Write scrollback to file
 */
export async function writeScrollback(terminalId: string, content: string): Promise<void> {
  try {
    const filePath = await getScrollbackFilePath(terminalId);
    // Truncate if over limit before writing
    const truncated = content.length > MAX_SCROLLBACK_SIZE
      ? content.slice(-MAX_SCROLLBACK_SIZE)
      : content;
    await fs.writeFile(filePath, truncated, 'utf8');
  } catch (error) {
    console.error(`[TerminalStore] Error writing scrollback for ${terminalId}:`, error);
  }
}

/**
 * Delete scrollback file
 */
export async function deleteScrollbackFile(terminalId: string): Promise<void> {
  try {
    const filePath = await getScrollbackFilePath(terminalId);
    await fs.unlink(filePath);
  } catch (error) {
    // Ignore if file doesn't exist
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[TerminalStore] Error deleting scrollback for ${terminalId}:`, error);
    }
  }
}

/**
 * Clean up orphaned scrollback files
 * Call this periodically or on startup to remove files for deleted terminals
 */
export async function cleanupOrphanedScrollback(validTerminalIds: Set<string>): Promise<number> {
  try {
    const dir = await getScrollbackDirectory();
    const files = await fs.readdir(dir);
    let cleaned = 0;

    for (const file of files) {
      if (!file.endsWith('.scrollback')) continue;
      const terminalId = file.replace('.scrollback', '');
      if (!validTerminalIds.has(terminalId)) {
        await deleteScrollbackFile(terminalId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[TerminalStore] Cleaned up ${cleaned} orphaned scrollback files`);
    }
    return cleaned;
  } catch (error) {
    console.error('[TerminalStore] Error cleaning up orphaned scrollback:', error);
    return 0;
  }
}
