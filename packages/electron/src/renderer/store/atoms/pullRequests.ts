/**
 * Pull request review panel atoms.
 *
 * Populated by store/listeners/pullRequestListeners.ts. Components read from
 * these atoms and never subscribe to IPC directly (see IPC_LISTENERS.md).
 */

import { atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import type {
  PullRequestRow,
} from '../../services/RendererPullRequestService';
import type { GhCliStatus } from '../../services/RendererGhCliService';

/**
 * Latest `gh` CLI install/auth status, fed by `pr:gh-status-changed` and the
 * initial probe. `null` means "not yet known".
 */
export const ghCliStatusAtom = atom<GhCliStatus | null>(null);

/**
 * The GitHub remote for the active workspace, or null if the workspace has no
 * GitHub origin (in which case the PR review gutter button stays hidden).
 *
 * Carries `workspacePath` so consumers can verify the remote belongs to the
 * currently-active workspace before acting on it (multi-project rail switches
 * the active workspace without unmounting).
 */
export interface PrRemoteInfo {
  workspacePath: string;
  remote: string;
  host: string;
}

export const prRemoteAtom = atom<PrRemoteInfo | null>(null);

/**
 * Cached PR list for the active workspace. Replaced wholesale by the mode
 * component after each `pr:list` fetch / `pr:list-updated` broadcast.
 */
export const prListAtom = atom<PullRequestRow[]>([]);

export const prListLoadingAtom = atom<boolean>(false);
export const prListErrorAtom = atom<string | null>(null);

/**
 * Request-atom for `pr:list-updated` broadcasts. The listener bumps `version`
 * and stores the payload; the mode component reacts (skip-initial-mount idiom)
 * to re-read the cache via `pr:list`.
 */
export interface PrListUpdated {
  version: number;
  payload: { workspacePath: string; remote: string };
}

export const prListUpdatedAtom = atom<PrListUpdated | null>(null);

// ============================================================
// PR Mode Layout (persisted to workspace state)
// ============================================================

/** Filter chips that can be toggled in the PR sidebar. */
export type PrFilterChip =
  | 'open'
  | 'closed'
  | 'awaiting-review'
  | 'created-by-me'
  | 'with-conflicts'
  | 'draft';

/** Sort keys for the PR list. */
export type PrSortKey = 'updated' | 'created' | 'number';

/** Detail-panel tabs. */
export type PrDetailTab = 'conversation' | 'files' | 'commits' | 'checks';

export interface PrModeLayout {
  /** Active filter chips. `open`/`closed` are mutually exclusive. */
  activeFilters: PrFilterChip[];
  /** Sort order for the list. */
  sortKey: PrSortKey;
  /** Currently selected PR id (opens the detail panel when non-null). */
  selectedItemId: string | null;
  /** Active tab in the detail panel. */
  activeDetailTab: PrDetailTab;
  /** Sidebar width in pixels. */
  sidebarWidth: number;
  /** Detail panel width in pixels. */
  detailPanelWidth: number;
}

const DEFAULT_PR_MODE_LAYOUT: PrModeLayout = {
  activeFilters: ['open'],
  sortKey: 'updated',
  selectedItemId: null,
  activeDetailTab: 'conversation',
  sidebarWidth: 220,
  detailPanelWidth: 460,
};

export const prModeLayoutAtom = atom<PrModeLayout>(DEFAULT_PR_MODE_LAYOUT);

// Track workspace path for persistence (mirrors trackers.ts).
let currentWorkspacePath: string | null = null;
let modeLayoutPersistTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleModeLayoutPersist(workspacePath: string, layout: PrModeLayout): void {
  if (modeLayoutPersistTimer) clearTimeout(modeLayoutPersistTimer);
  modeLayoutPersistTimer = setTimeout(async () => {
    try {
      await window.electronAPI.invoke('workspace:update-state', workspacePath, {
        prModeLayout: layout,
      });
    } catch (err) {
      console.error('[pullRequests] Failed to persist mode layout:', err);
    }
  }, 300);
}

/**
 * Load the PR mode layout from persisted workspace state. Call when the
 * workspace path becomes known. Uses `??` defaults so older persisted state
 * (missing fields) loads safely.
 */
export async function initPrModeLayout(workspacePath: string): Promise<void> {
  currentWorkspacePath = workspacePath;
  try {
    const workspaceState = await window.electronAPI.invoke('workspace:get-state', workspacePath);
    const saved = workspaceState?.prModeLayout;
    if (saved && typeof saved === 'object') {
      store.set(prModeLayoutAtom, {
        activeFilters: Array.isArray(saved.activeFilters)
          ? saved.activeFilters
          : DEFAULT_PR_MODE_LAYOUT.activeFilters,
        sortKey: saved.sortKey ?? DEFAULT_PR_MODE_LAYOUT.sortKey,
        selectedItemId: saved.selectedItemId ?? DEFAULT_PR_MODE_LAYOUT.selectedItemId,
        activeDetailTab: saved.activeDetailTab ?? DEFAULT_PR_MODE_LAYOUT.activeDetailTab,
        sidebarWidth: saved.sidebarWidth ?? DEFAULT_PR_MODE_LAYOUT.sidebarWidth,
        detailPanelWidth: saved.detailPanelWidth ?? DEFAULT_PR_MODE_LAYOUT.detailPanelWidth,
      });
    }
  } catch (err) {
    console.error('[pullRequests] Failed to load mode layout:', err);
  }
}

/** Update PR mode layout with partial values and persist (debounced). */
export const setPrModeLayoutAtom = atom(
  null,
  (get, set, updates: Partial<PrModeLayout>) => {
    const next = { ...get(prModeLayoutAtom), ...updates };
    set(prModeLayoutAtom, next);
    if (currentWorkspacePath) {
      scheduleModeLayoutPersist(currentWorkspacePath, next);
    }
  },
);
