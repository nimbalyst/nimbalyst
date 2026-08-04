/**
 * Tracker Atoms
 *
 * State for the tracker system (bugs, plans, tasks, etc.).
 * Uses tracker type as keys for per-tracker-type state.
 */

import { atom, type Setter } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';

// ============================================================
// Types
// ============================================================

/**
 * Tracker item types supported by the system.
 */
export type TrackerType = 'bug' | 'plan' | 'task' | 'idea' | 'decision' | 'feature';

/**
 * Status values for tracker items.
 */
export type TrackerStatus =
  | 'open'
  | 'in-progress'
  | 'in-review'
  | 'completed'
  | 'blocked'
  | 'rejected';

/**
 * Tracker item data structure.
 */
export interface TrackerItem {
  id: string;
  type: TrackerType;
  title: string;
  description?: string;
  status: TrackerStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';
  filePath: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

// Track workspace path for persistence
let currentWorkspacePath: string | null = null;

// ============================================================
// Initialization
// ============================================================

/**
 * Migrations for persisted `viewMode` literals.
 *
 * Two rewrites, in the order they shipped:
 *
 * 1. `'table'` once meant the row-list view (now called `'list'`). Workspaces
 *    persisted by builds from before that rename carry `viewMode: 'table'` with
 *    the old meaning; rewrite those once to `'list'` and set
 *    `viewModeMigrated: true` so later loads pass `'table'` through untouched.
 * 2. `'grid'` was the RevoGrid table's own view mode while it sat beside the
 *    hand-rolled table. RevoGrid *is* the table now, so `'grid'` folds into
 *    `'table'` unconditionally.
 *
 * Why a per-load idempotent flag instead of a save-time rewrite: workspace
 * state lives on multiple machines and installs. A flag is robust against
 * a workspace that an older build touched last.
 */
function migrateViewMode(
  raw: unknown,
  alreadyMigrated: boolean,
): TrackerModeLayout['viewMode'] {
  if (raw === 'table' && !alreadyMigrated) return 'list';
  return normalizeViewMode(raw, DEFAULT_MODE_LAYOUT.viewMode);
}

/**
 * Initialize tracker layout from workspace state.
 * Call this when workspace path is known.
 */
export async function initTrackerPanelLayout(workspacePath: string): Promise<void> {
  currentWorkspacePath = workspacePath;
  // Clear the previous project's state before any asynchronous reads complete.
  // Without this, switching projects briefly exposes (and allows actions on)
  // saved views owned by the workspace that was just left.
  store.set(trackerModeLayoutAtom, DEFAULT_MODE_LAYOUT);
  store.set(trackerSavedViewsAtom, []);
  store.set(sharedTrackerSavedViewsAtom, []);

  try {
    const workspaceState = await window.electronAPI.invoke(
      'workspace:get-state',
      workspacePath
    );
    if (currentWorkspacePath !== workspacePath) return;

    const savedModeLayout = workspaceState?.trackerModeLayout;
    if (savedModeLayout && typeof savedModeLayout === 'object') {
      const alreadyMigrated = savedModeLayout.viewModeMigrated === true;
      const migratedViewMode = migrateViewMode(savedModeLayout.viewMode, alreadyMigrated);

      const newLayout: TrackerModeLayout = {
        selectedType: savedModeLayout.selectedType ?? DEFAULT_MODE_LAYOUT.selectedType,
        activeFilters: Array.isArray(savedModeLayout.activeFilters)
          ? savedModeLayout.activeFilters
          : DEFAULT_MODE_LAYOUT.activeFilters,
        viewMode: migratedViewMode,
        selectedItemId: savedModeLayout.selectedItemId ?? DEFAULT_MODE_LAYOUT.selectedItemId,
        sidebarWidth: savedModeLayout.sidebarWidth ?? DEFAULT_MODE_LAYOUT.sidebarWidth,
        detailPanelWidth: savedModeLayout.detailPanelWidth ?? DEFAULT_MODE_LAYOUT.detailPanelWidth,
        typeColumnConfigs: savedModeLayout.typeColumnConfigs ?? DEFAULT_MODE_LAYOUT.typeColumnConfigs,
        typeColumnFilters: savedModeLayout.typeColumnFilters ?? DEFAULT_MODE_LAYOUT.typeColumnFilters,
        groupBy: savedModeLayout.groupBy ?? DEFAULT_MODE_LAYOUT.groupBy,
        sortBy: typeof savedModeLayout.sortBy === 'string' ? savedModeLayout.sortBy : DEFAULT_MODE_LAYOUT.sortBy,
        sortDirection: savedModeLayout.sortDirection === 'asc' || savedModeLayout.sortDirection === 'desc'
          ? savedModeLayout.sortDirection
          : DEFAULT_MODE_LAYOUT.sortDirection,
        recentlyViewedDays: savedModeLayout.recentlyViewedDays === null
          || savedModeLayout.recentlyViewedDays === 7
          || savedModeLayout.recentlyViewedDays === 30
          || savedModeLayout.recentlyViewedDays === 90
          ? savedModeLayout.recentlyViewedDays
          : DEFAULT_MODE_LAYOUT.recentlyViewedDays,
        inboxScope: savedModeLayout.inboxScope === 'type' ? 'type' : DEFAULT_MODE_LAYOUT.inboxScope,
        itemViews: normalizeItemViews(savedModeLayout.itemViews),
        documentListPaneVisible: typeof savedModeLayout.documentListPaneVisible === 'boolean'
          ? savedModeLayout.documentListPaneVisible
          : DEFAULT_MODE_LAYOUT.documentListPaneVisible,
        documentListPaneWidth: clampDocumentListPaneWidth(
          savedModeLayout.documentListPaneWidth ?? DEFAULT_MODE_LAYOUT.documentListPaneWidth,
        ),
        documentRightPanelVisible: typeof savedModeLayout.documentRightPanelVisible === 'boolean'
          ? savedModeLayout.documentRightPanelVisible
          : DEFAULT_MODE_LAYOUT.documentRightPanelVisible,
        documentRightPanelWidth: clampDocumentRightPanelWidth(
          savedModeLayout.documentRightPanelWidth ?? DEFAULT_MODE_LAYOUT.documentRightPanelWidth,
        ),
        documentRightPanelMode: normalizeDocumentPanelMode(savedModeLayout.documentRightPanelMode),
        documentChatSessions: normalizeDocumentChatSessions(savedModeLayout.documentChatSessions),
        viewModeMigrated: true,
      };

      store.set(trackerModeLayoutAtom, newLayout);

      // Persist the flag immediately so we never re-run the rewrite.
      if (!alreadyMigrated) {
        scheduleModeLayoutPersist(workspacePath, newLayout);
      }
    }

    // Saved views are stored alongside the layout but as their own key so the
    // (frequently re-persisted) layout blob stays small.
    const savedViews = workspaceState?.trackerSavedViews;
    if (Array.isArray(savedViews)) {
      store.set(trackerSavedViewsAtom, savedViews
        .filter((view): view is SavedView => !!view && typeof view === 'object' && typeof view.id === 'string' && typeof view.name === 'string')
        .map((view) => ({ ...view, definition: normalizeViewDefinition(view.definition) })));
    }
  } catch (err) {
    console.error('[trackers] Failed to load layout:', err);
  }
}

// ============================================================
// Tracker Mode State (full-screen mode)
// ============================================================

/**
 * Tracker mode layout state.
 * Persisted to workspace state so it survives app restarts.
 */
/** Filter chips that can be toggled independently */
export type TrackerFilterChip = 'mine' | 'unassigned' | 'high-priority' | 'recently-updated'
  | 'favorites' | 'recently-viewed' | 'recently-edited-by-others' | 'archived';

/** Per-type column configuration (re-exported from runtime) */
export type { TypeColumnConfig } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import type { TypeColumnConfig } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import type { SortColumn, SortDirection } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import type { InboxScope, TrackerFilterSet } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  mergeSavedViews,
  normalizeViewDefinition,
  normalizeViewMode,
  parseSharedSavedView,
  serializeSharedSavedView,
  type SavedView,
  type TrackerGroupBy,
} from '../../components/TrackerMode/trackerSavedViews';

export interface TrackerModeLayout {
  /** Selected type filter in sidebar ('all' or specific type) */
  selectedType: string;
  /** Active filter chips (empty = show all, multiple = intersection) */
  activeFilters: TrackerFilterChip[];
  /**
   * Display mode for the tracker main view.
   * - `list`   -- title-left / badges-right row list (`TrackerTable`).
   * - `table`  -- virtualized, in-place-editable RevoGrid table
   *               (`TrackerGridView`).
   * - `kanban` -- column-per-status board (`KanbanBoard`).
   * - `tag-board` -- column-per-tag board (`TagBoard`).
   * - `inbox`  -- keyboard-driven triage queue of untriaged items
   *               (`TrackerInboxView`).
   *
   * Legacy persisted state used `'table'` for the list view and `'grid'` for
   * the RevoGrid table; `migrateViewMode` rewrites both on load.
   */
  viewMode: 'list' | 'table' | 'kanban' | 'tag-board' | 'inbox';
  /** Currently selected tracker item ID (opens detail panel when non-null) */
  selectedItemId: string | null;
  /** Sidebar width in pixels */
  sidebarWidth: number;
  /** Detail panel width in pixels */
  detailPanelWidth: number;
  /** Per-type column configuration (keyed by tracker type, 'all' for the all-types view) */
  typeColumnConfigs: Record<string, TypeColumnConfig>;
  /**
   * Per-type column filter sets, in the shared `{field, op, value}` language
   * (keyed the same way as `typeColumnConfigs`). Applied on top of the coarse
   * `activeFilters` chips.
   */
  typeColumnFilters: Record<string, TrackerFilterSet>;
  /** Active grouping for grouped renderings (NIM-788). Defaults to 'none'. */
  groupBy: TrackerGroupBy;
  sortBy: SortColumn;
  sortDirection: SortDirection;
  recentlyViewedDays: 7 | 30 | 90 | null;
  /** Whether the triage inbox spans every type or only the selected one. */
  inboxScope: InboxScope;
  /**
   * Per-item presentation of the selected tracker item. `'document'` swaps
   * Tracker Mode into the focused document layout (slim list left, the item's
   * content filling the main area); `'item'` is the ordinary detail panel.
   *
   * Only items in document view are stored, so the map stays small and an
   * absent key reads as `'item'`. Capped at {@link MAX_PERSISTED_ITEM_VIEWS}
   * entries -- this is a UI preference, not a record of every item ever opened.
   */
  itemViews: Record<string, TrackerItemView>;
  /** Document view: whether the slim list pane on the left is shown. */
  documentListPaneVisible: boolean;
  /** Document view: width of the slim list pane, in pixels. */
  documentListPaneWidth: number;
  /** Document view: whether the switchable chat/discussion panel is shown. */
  documentRightPanelVisible: boolean;
  /** Document view: width of the right panel, in pixels. */
  documentRightPanelWidth: number;
  /** Document view: which surface the right panel is showing. */
  documentRightPanelMode: TrackerDocumentPanelMode;
  /**
   * Chat session paired with a tracker item, so reopening an item's document
   * returns to the same conversation instead of starting a new one. Bounded the
   * same way as {@link TrackerModeLayout.itemViews}.
   */
  documentChatSessions: Record<string, string>;
  /**
   * Set to `true` once the one-shot `'table' -> 'list'` rewrite has run for
   * this workspace. Future loads pass `viewMode` through untouched so users
   * can pick the new `'table'` grid without it being clobbered.
   */
  viewModeMigrated?: boolean;
}

const DEFAULT_MODE_LAYOUT: TrackerModeLayout = {
  selectedType: 'all',
  activeFilters: [],
  viewMode: 'list',
  selectedItemId: null,
  sidebarWidth: 220,
  detailPanelWidth: 400,
  typeColumnConfigs: {},
  typeColumnFilters: {},
  groupBy: 'none',
  sortBy: 'lastIndexed',
  sortDirection: 'desc',
  recentlyViewedDays: 30,
  inboxScope: 'global',
  itemViews: {},
  documentListPaneVisible: true,
  documentListPaneWidth: 280,
  documentRightPanelVisible: true,
  documentRightPanelWidth: 380,
  documentRightPanelMode: 'chat',
  documentChatSessions: {},
  viewModeMigrated: true,
};

/** Presentation of a single tracker item inside Tracker Mode. */
export type TrackerItemView = 'item' | 'document';

/** Surface shown in the document view's right panel. */
export type TrackerDocumentPanelMode = 'chat' | 'discussion';

const DOCUMENT_PANEL_MODES: readonly TrackerDocumentPanelMode[] = ['chat', 'discussion'];

/** Upper bound on remembered document-view items (oldest entries drop first). */
export const MAX_PERSISTED_ITEM_VIEWS = 100;

export const DOCUMENT_LIST_PANE_MIN_WIDTH = 200;
export const DOCUMENT_LIST_PANE_MAX_WIDTH = 480;

export function clampDocumentListPaneWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return DEFAULT_MODE_LAYOUT.documentListPaneWidth;
  }
  return Math.round(Math.max(
    DOCUMENT_LIST_PANE_MIN_WIDTH,
    Math.min(DOCUMENT_LIST_PANE_MAX_WIDTH, width),
  ));
}

export const DOCUMENT_RIGHT_PANEL_MIN_WIDTH = 300;
export const DOCUMENT_RIGHT_PANEL_MAX_WIDTH = 720;

export function clampDocumentRightPanelWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return DEFAULT_MODE_LAYOUT.documentRightPanelWidth;
  }
  return Math.round(Math.max(
    DOCUMENT_RIGHT_PANEL_MIN_WIDTH,
    Math.min(DOCUMENT_RIGHT_PANEL_MAX_WIDTH, width),
  ));
}

function normalizeDocumentPanelMode(raw: unknown): TrackerDocumentPanelMode {
  return DOCUMENT_PANEL_MODES.includes(raw as TrackerDocumentPanelMode)
    ? (raw as TrackerDocumentPanelMode)
    : DEFAULT_MODE_LAYOUT.documentRightPanelMode;
}

/**
 * Item -> chat session pairings, normalized the same defensive way as
 * `itemViews`: anything that isn't a `string -> string` map reads as absent.
 */
function normalizeDocumentChatSessions(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(([id, sessionId]) => (
      typeof id === 'string' && id.length > 0
      && typeof sessionId === 'string' && sessionId.length > 0
    ))
    .slice(-MAX_PERSISTED_ITEM_VIEWS) as Array<[string, string]>;
  return Object.fromEntries(entries);
}

/**
 * Persisted `itemViews` predates nothing -- but workspace state is written by
 * many builds, so treat anything that isn't a `{ id: 'document' }` map as
 * absent rather than trusting it into the atom.
 */
function normalizeItemViews(raw: unknown): Record<string, TrackerItemView> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(([id, view]) => typeof id === 'string' && id.length > 0 && view === 'document')
    .slice(-MAX_PERSISTED_ITEM_VIEWS) as Array<[string, TrackerItemView]>;
  return Object.fromEntries(entries);
}

/** Main atom for tracker mode layout. */
export const trackerModeLayoutAtom = atom<TrackerModeLayout>(DEFAULT_MODE_LAYOUT);

/** Selected type in tracker mode sidebar. */
export const trackerModeSelectedTypeAtom = atom(
  (get) => get(trackerModeLayoutAtom).selectedType
);

/** Active filter chips in tracker mode sidebar. */
export const trackerModeActiveFiltersAtom = atom(
  (get) => get(trackerModeLayoutAtom).activeFilters
);

/** View mode (`list` row-list, `table` grid, or `kanban` board) in tracker mode. */
export const trackerModeViewModeAtom = atom(
  (get) => get(trackerModeLayoutAtom).viewMode
);

/** Currently selected item ID in tracker mode (opens detail panel). */
export const trackerModeSelectedItemIdAtom = atom(
  (get) => get(trackerModeLayoutAtom).selectedItemId
);

let modeLayoutPersistTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleModeLayoutPersist(workspacePath: string, layout: TrackerModeLayout): void {
  if (modeLayoutPersistTimer) clearTimeout(modeLayoutPersistTimer);
  modeLayoutPersistTimer = setTimeout(async () => {
    try {
      await window.electronAPI.invoke('workspace:update-state', workspacePath, {
        trackerModeLayout: layout,
      });
    } catch (err) {
      console.error('[trackers] Failed to persist mode layout:', err);
    }
  }, 300);
}

/** Update tracker mode layout with partial values and persist. */
export const setTrackerModeLayoutAtom = atom(
  null,
  (get, set, updates: Partial<TrackerModeLayout>) => {
    const current = get(trackerModeLayoutAtom);
    const newLayout = { ...current, ...updates };
    set(trackerModeLayoutAtom, newLayout);

    if (currentWorkspacePath) {
      scheduleModeLayoutPersist(currentWorkspacePath, newLayout);
    }
  }
);

/** Active grouping in tracker mode. */
export const trackerModeGroupByAtom = atom(
  (get) => get(trackerModeLayoutAtom).groupBy
);

/**
 * The item currently presented as a document, or `null` when Tracker Mode is
 * in its ordinary list + detail-panel presentation. Document view only applies
 * to the *selected* item, so switching selection to an item that was never
 * opened as a document leaves the focused layout.
 */
export const trackerModeDocumentItemIdAtom = atom((get) => {
  const layout = get(trackerModeLayoutAtom);
  const itemId = layout.selectedItemId;
  if (!itemId) return null;
  return layout.itemViews[itemId] === 'document' ? itemId : null;
});

/** Set (or clear) the document presentation for one item and persist it. */
export const setTrackerItemViewAtom = atom(
  null,
  (get, set, params: { itemId: string; view: TrackerItemView }) => {
    const current = get(trackerModeLayoutAtom);
    const next: Record<string, TrackerItemView> = { ...current.itemViews };
    // Only 'document' is stored; deleting on 'item' keeps the map bounded and
    // makes an absent key unambiguously mean "ordinary detail panel".
    if (params.view === 'document') {
      // Re-insert so the most recently opened document is the newest key --
      // the trim below drops the oldest.
      delete next[params.itemId];
      next[params.itemId] = 'document';
    } else {
      delete next[params.itemId];
    }
    const keys = Object.keys(next);
    const trimmed = keys.length > MAX_PERSISTED_ITEM_VIEWS
      ? Object.fromEntries(
          keys.slice(keys.length - MAX_PERSISTED_ITEM_VIEWS).map((id) => [id, next[id]]),
        )
      : next;
    set(setTrackerModeLayoutAtom, { itemViews: trimmed });
  }
);

/**
 * Remember (or forget) the chat session paired with a tracker item's document.
 * Bounded like `itemViews` -- this is a convenience pairing, not a record of
 * every chat ever opened.
 */
export const setTrackerDocumentChatSessionAtom = atom(
  null,
  (get, set, params: { itemId: string; sessionId: string | null }) => {
    const current = get(trackerModeLayoutAtom);
    const next: Record<string, string> = { ...current.documentChatSessions };
    delete next[params.itemId];
    if (params.sessionId) next[params.itemId] = params.sessionId;
    const keys = Object.keys(next);
    const trimmed = keys.length > MAX_PERSISTED_ITEM_VIEWS
      ? Object.fromEntries(
          keys.slice(keys.length - MAX_PERSISTED_ITEM_VIEWS).map((id) => [id, next[id]]),
        )
      : next;
    set(setTrackerModeLayoutAtom, { documentChatSessions: trimmed });
  }
);

/** Open an item in document view (selecting it if it isn't already). */
export const openTrackerItemAsDocumentAtom = atom(
  null,
  (get, set, itemId: string) => {
    set(setTrackerItemViewAtom, { itemId, view: 'document' });
    if (get(trackerModeLayoutAtom).selectedItemId !== itemId) {
      set(setTrackerModeLayoutAtom, { selectedItemId: itemId });
    }
  }
);

/**
 * Leave a focused document through its tracker/type breadcrumb.
 *
 * Unlike "Collapse to tracker", breadcrumb navigation is a destination: it
 * opens the owning type's row list with no detail panel obscuring it. Apply the
 * presentation, type, and list-view changes in one persisted layout write so
 * the title bar and Tracker Mode never observe an in-between state.
 */
export const returnToTrackerTypeListAtom = atom(
  null,
  (get, set, params: { itemId: string; trackerType: string }) => {
    const current = get(trackerModeLayoutAtom);
    const itemViews = { ...current.itemViews };
    delete itemViews[params.itemId];
    set(setTrackerModeLayoutAtom, {
      selectedType: params.trackerType,
      viewMode: 'list',
      selectedItemId: null,
      itemViews,
    });
  },
);

// ============================================================
// Saved Views (NIM-788)
// ============================================================

/** Saved view definitions for the current workspace. */
export const trackerSavedViewsAtom = atom<SavedView[]>([]);

function persistSavedViews(workspacePath: string, views: SavedView[]): void {
  window.electronAPI
    .invoke('workspace:update-state', workspacePath, { trackerSavedViews: views })
    .catch((err: unknown) => {
      console.error('[trackers] Failed to persist saved views:', err);
    });
}

/** Add (or replace by id) a saved view and persist to workspace settings. */
export const saveTrackerViewAtom = atom(
  null,
  (get, set, view: SavedView) => {
    const current = get(trackerSavedViewsAtom);
    const existingIdx = current.findIndex((v) => v.id === view.id);
    const next = existingIdx >= 0
      ? current.map((v) => (v.id === view.id ? view : v))
      : [...current, view];
    set(trackerSavedViewsAtom, next);
    if (currentWorkspacePath) persistSavedViews(currentWorkspacePath, next);
  }
);

/** Remove a saved view by id and persist. */
export const deleteTrackerViewAtom = atom(
  null,
  (get, set, viewId: string) => {
    const next = get(trackerSavedViewsAtom).filter((v) => v.id !== viewId);
    set(trackerSavedViewsAtom, next);
    if (currentWorkspacePath) persistSavedViews(currentWorkspacePath, next);
  }
);

/**
 * Team-shared views, projected from the main-process shared-view store. These
 * are not persisted in workspace settings -- the store row *is* the local copy,
 * and it round-trips through the tracker room's saved-view lane.
 */
export const sharedTrackerSavedViewsAtom = atom<SavedView[]>([]);
let sharedViewsLoadVersion = 0;

/** Local + shared views, as the sidebar renders them. */
export const allTrackerSavedViewsAtom = atom<SavedView[]>((get) =>
  mergeSavedViews(get(trackerSavedViewsAtom), get(sharedTrackerSavedViewsAtom)),
);

function applySharedViewRecords(set: Setter, records: unknown): void {
  const rows = Array.isArray(records) ? records as Array<{ viewId: string; payload: string }> : [];
  set(
    sharedTrackerSavedViewsAtom,
    rows.map(parseSharedSavedView).filter((view): view is SavedView => view !== null),
  );
}

export const loadSharedTrackerViewsAtom = atom(
  null,
  async (_get, set, workspacePath: string) => {
    const loadVersion = ++sharedViewsLoadVersion;
    set(sharedTrackerSavedViewsAtom, []);
    const records = await window.electronAPI.invoke('tracker-saved-views:list', workspacePath);
    if (loadVersion !== sharedViewsLoadVersion) return;
    applySharedViewRecords(set, records);
  },
);

/**
 * Share a view with the team: it moves out of workspace settings and into the
 * synced store, so the view exists in exactly one place and edits can't fork.
 */
export const shareTrackerViewAtom = atom(
  null,
  async (get, set, view: SavedView) => {
    if (!currentWorkspacePath) return;
    const records = await window.electronAPI.invoke(
      'tracker-saved-views:share',
      currentWorkspacePath,
      { viewId: view.id, payload: serializeSharedSavedView(view) },
    );
    applySharedViewRecords(set, records);
    const localRemainder = get(trackerSavedViewsAtom).filter((v) => v.id !== view.id);
    if (localRemainder.length !== get(trackerSavedViewsAtom).length) {
      set(trackerSavedViewsAtom, localRemainder);
      persistSavedViews(currentWorkspacePath, localRemainder);
    }
  },
);

/** Stop sharing: tombstone the synced row and keep the view as a local one. */
export const unshareTrackerViewAtom = atom(
  null,
  async (get, set, view: SavedView) => {
    if (!currentWorkspacePath) return;
    const records = await window.electronAPI.invoke(
      'tracker-saved-views:unshare',
      currentWorkspacePath,
      view.id,
    );
    applySharedViewRecords(set, records);
    const current = get(trackerSavedViewsAtom);
    if (!current.some((v) => v.id === view.id)) {
      const next = [...current, { ...view, shared: false }];
      set(trackerSavedViewsAtom, next);
      persistSavedViews(currentWorkspacePath, next);
    }
  },
);

/**
 * Delete a view regardless of where it lives. Deleting a shared view removes it
 * for the whole team, so callers should confirm first.
 */
export const removeTrackerViewAtom = atom(
  null,
  async (get, set, view: SavedView) => {
    if (view.shared && currentWorkspacePath) {
      const records = await window.electronAPI.invoke(
        'tracker-saved-views:unshare',
        currentWorkspacePath,
        view.id,
      );
      applySharedViewRecords(set, records);
      return;
    }
    set(deleteTrackerViewAtom, view.id);
  },
);

// ============================================================
// Tracker Data Atoms (separate from layout)
// ============================================================

/**
 * Counts by tracker type.
 */
export const trackerCountsAtom = atom<Record<TrackerType, number>>({
  bug: 0,
  plan: 0,
  task: 0,
  idea: 0,
  decision: 0,
  feature: 0,
});

/**
 * Per-type tracker count.
 */
export const trackerCountAtom = atomFamily((type: TrackerType) =>
  atom((get) => {
    const counts = get(trackerCountsAtom);
    return counts[type] ?? 0;
  })
);

/**
 * Items per tracker type.
 */
export const trackerItemsAtom = atomFamily((_type: TrackerType) =>
  atom<TrackerItem[]>([])
);

/**
 * Currently selected tracker item ID.
 */
export const selectedTrackerItemAtom = atom<string | null>(null);

/**
 * Filter state per tracker type.
 */
export interface TrackerFilter {
  status?: TrackerStatus[];
  priority?: TrackerItem['priority'][];
  tags?: string[];
  search?: string;
}

export const trackerFilterAtom = atomFamily((_type: TrackerType) =>
  atom<TrackerFilter>({})
);

/**
 * Derived: filtered items for a tracker type.
 */
export const filteredTrackerItemsAtom = atomFamily((type: TrackerType) =>
  atom((get) => {
    const items = get(trackerItemsAtom(type));
    const filter = get(trackerFilterAtom(type));

    let filtered = items;

    if (filter.status && filter.status.length > 0) {
      filtered = filtered.filter((item) => filter.status!.includes(item.status));
    }

    if (filter.priority && filter.priority.length > 0) {
      filtered = filtered.filter((item) =>
        filter.priority!.includes(item.priority)
      );
    }

    if (filter.tags && filter.tags.length > 0) {
      filtered = filtered.filter((item) =>
        filter.tags!.some((tag) => item.tags.includes(tag))
      );
    }

    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      filtered = filtered.filter(
        (item) =>
          item.title.toLowerCase().includes(searchLower) ||
          item.description?.toLowerCase().includes(searchLower)
      );
    }

    return filtered;
  })
);

/**
 * Derived: total open items across all tracker types.
 */
export const totalOpenItemsAtom = atom((get) => {
  const counts = get(trackerCountsAtom);
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
});

/**
 * Derived: critical/high priority items count.
 */
export const criticalItemsCountAtom = atom((get) => {
  let count = 0;
  const types: TrackerType[] = ['bug', 'plan', 'task', 'idea', 'decision', 'feature'];
  for (const type of types) {
    const items = get(trackerItemsAtom(type));
    count += items.filter(
      (item) =>
        (item.priority === 'critical' || item.priority === 'high') &&
        item.status !== 'completed' &&
        item.status !== 'rejected'
    ).length;
  }
  return count;
});

// ============================================================
// Action Atoms for Tracker Data
// ============================================================

/**
 * Update counts for all tracker types.
 */
export const updateTrackerCountsAtom = atom(
  null,
  (_get, set, counts: Record<TrackerType, number>) => {
    set(trackerCountsAtom, counts);
  }
);

/**
 * Update items for a tracker type.
 */
export const updateTrackerItemsAtom = atom(
  null,
  (
    _get,
    set,
    { type, items }: { type: TrackerType; items: TrackerItem[] }
  ) => {
    set(trackerItemsAtom(type), items);
  }
);

/**
 * Set filter for a tracker type.
 */
export const setTrackerFilterAtom = atom(
  null,
  (
    _get,
    set,
    { type, filter }: { type: TrackerType; filter: TrackerFilter }
  ) => {
    set(trackerFilterAtom(type), filter);
  }
);

/**
 * Clear filter for a tracker type.
 */
export const clearTrackerFilterAtom = atom(
  null,
  (_get, set, type: TrackerType) => {
    set(trackerFilterAtom(type), {});
  }
);
