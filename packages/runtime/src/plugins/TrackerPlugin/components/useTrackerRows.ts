/**
 * useTrackerRows -- shared row interaction model for the tracker list view
 * (`TrackerTable`) and the RevoGrid table view (`TrackerGridView`).
 *
 * Owns selection, keyboard navigation, inline editing, context menu state,
 * and bulk updates so both view surfaces share identical behavior.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFloating, offset, flip, shift } from '@floating-ui/react';
import { windowControlsClearance } from '../../../ui/floating/windowControlsClearance';
import { usePostHog } from 'posthog-js/react';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import type { TrackerItemType } from '../../../core/DocumentService';
import { globalRegistry } from '../models';
import { getMembersField, addMembersValue } from '../models/trackerCollections';
import { getRecordTitle, resolveRoleFieldName } from '../trackerRecordAccessors';
import {
  applyClear,
  applyRecord,
  applyRedo,
  applyUndo,
  areTrackerUndoValuesEqual,
  createEmptyHistory,
  mergeUndoChanges,
  MAX_UNDO_CHANGES_PER_ENTRY,
  type TrackerUndoChange,
  type TrackerUndoEntry,
  type TrackerUndoHistory,
} from './trackerUndoStack';

export type EditingField = 'status' | 'priority' | 'title';

export interface EditingCellRef {
  itemId: string;
  field: EditingField;
}

export interface UseTrackerRowsOptions {
  /** Sorted items the row UI is rendering (mirrored into an internal ref). */
  items: TrackerRecord[];
  /** Active type filter ('all' or a specific tracker type). Used to reset
   *  selection when the filter changes and to derive bulk-update options. */
  activeTypeFilter: TrackerItemType | 'all';
  /** Open the detail panel (tracker mode) when row is clicked. */
  onItemSelect?: (itemId: string) => void;
  /** Bulk delete callback. */
  onDeleteItems?: (itemIds: string[]) => void;
  /**
   * Bulk archive callback. `options.record === false` marks a replay, so a
   * recorder wrapped around this callback must not push a fresh undo entry for
   * a write the history is already tracking.
   */
  onArchiveItems?: (
    itemIds: string[],
    archive: boolean,
    options?: { record?: boolean },
  ) => void | Promise<void>;
  /** Files-mode switcher used when opening an item that lives in a document. */
  onSwitchToFilesMode?: () => void;
  /**
   * Fallback lookup for records this surface can write but does not render.
   * "Add to Collection" targets a milestone drawn from the all-types set, so
   * under a type filter the collection is absent from `items` and its undo
   * would otherwise be reported as drift it never suffered.
   */
  resolveRecordById?: (itemId: string) => TrackerRecord | undefined;
}

export interface TrackerUndoReplayResult {
  label: string;
  applied: number;
  skipped: number;
}

export interface UseTrackerRowsResult {
  // Selection
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  handleSelectAll: () => void;

  // Keyboard focus
  focusedIndex: number;
  setFocusedIndex: React.Dispatch<React.SetStateAction<number>>;
  containerRef: React.RefObject<HTMLDivElement | null>;

  // Inline edit
  editingCell: EditingCellRef | null;
  setEditingCell: (cell: EditingCellRef | null) => void;
  editingTitle: string;
  setEditingTitle: (t: string) => void;
  titleInputRef: React.RefObject<HTMLInputElement | null>;
  /**
   * Write a single field. `value` is the storage-shaped value for the field's
   * type (string, number, boolean, string[], relationship[]...), not just text --
   * pass it through `coerceCellValue` first when it came from a cell editor.
   * `undefined` clears the field.
   */
  handleFieldUpdate: (item: TrackerRecord, field: string, value: unknown) => Promise<void>;
  /** Write several fields on one item as a single update (one sync write). */
  handleItemUpdate: (item: TrackerRecord, updates: Record<string, unknown>) => Promise<void>;
  /** Apply the same field/value pair across many items (bulk edit, fill-down, paste). */
  handleBulkFieldUpdate: (items: TrackerRecord[], field: string, value: unknown) => Promise<void>;

  // Undo history
  runUndoable: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Record an entry supplied by a write path outside handleItemUpdate (archive).
   * Pass the `captureUndoGeneration()` value read *before* the write started so
   * a history clear that lands mid-write discards the entry instead of dropping
   * it into a history that no longer describes this view.
   */
  recordUndoEntry: (entry: TrackerUndoEntry, generation?: number) => void;
  /** Current history generation; bumped by every clear. */
  captureUndoGeneration: () => number;
  undo: () => Promise<TrackerUndoReplayResult | null>;
  redo: () => Promise<TrackerUndoReplayResult | null>;

  // Row interaction
  isItemEditable: (item: TrackerRecord) => boolean;
  handleRowClick: (item: TrackerRecord, index: number, e: React.MouseEvent) => void;
  openItemInEditor: (item: TrackerRecord) => void;

  // Context menu
  contextAnchor: DOMRect | null;
  contextRefs: ReturnType<typeof useFloating>['refs'];
  contextFloatingStyles: ReturnType<typeof useFloating>['floatingStyles'];
  handleContextMenu: (e: React.MouseEvent, item: TrackerRecord, index: number) => void;
  /**
   * Open the context menu over an explicit set of items. Surfaces that own
   * their own selection model (the RevoGrid table's cell ranges) hand the row
   * ids in directly instead of going through `handleContextMenu`'s
   * click-target heuristics.
   */
  openContextMenuForIds: (itemIds: string[], point: { x: number; y: number }) => void;
  closeContextMenu: () => void;
  handleBulkStatusUpdate: (status: string) => Promise<void>;
  handleBulkPriorityUpdate: (priority: string) => Promise<void>;
  /**
   * Add the current selection to a collection (milestone/release).
   * Writes the collection's members field once; the inverse `collection` field
   * on each member is filled in by inverse-relationship propagation.
   */
  handleAddSelectionToCollection: (collection: TrackerRecord) => Promise<void>;

  // Bulk submenu helper -- the active type filter's status options
  // for the context-menu Set Status submenu.
  statusOptionsForBulk: Array<string | { value: string; label: string }>;
}

/**
 * Hook owning all per-row UI state for the tracker list and grid surfaces.
 *
 * The caller is responsible for:
 * - Attaching `containerRef` to the scroll container (so keyboard nav works)
 * - Setting `tabIndex={0}` on that container
 * - Wiring `handleRowClick` / `handleContextMenu` on each row
 * - Rendering the context menu when `contextAnchor && selectedIds.size > 0`
 */
export function useTrackerRows({
  items,
  activeTypeFilter,
  onItemSelect,
  onDeleteItems,
  onArchiveItems,
  onSwitchToFilesMode,
  resolveRecordById,
}: UseTrackerRowsOptions): UseTrackerRowsResult {
  const posthog = usePostHog();

  // Inline editing state
  const [editingCell, setEditingCell] = useState<EditingCellRef | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  /** Whether an item's fields can be edited inline */
  const isItemEditable = useCallback((item: TrackerRecord): boolean => {
    return item.source === 'native'
      || !item.system.documentPath
      || item.source === 'frontmatter'
      || item.source === 'import'
      || item.source === 'inline';
  }, []);

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedIndexRef = useRef<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keyboard focus (independent of selection)
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  // Ref-only: nothing renders off the history, so putting it in state would
  // re-render every row on each recorded edit for no observable difference.
  const undoHistoryRef = useRef<TrackerUndoHistory>(createEmptyHistory());
  const undoBatchRef = useRef<{
    label: string;
    generation: number;
    changes: TrackerUndoChange[];
  } | null>(null);
  const undoGenerationRef = useRef(0);
  const replayInFlightRef = useRef(false);

  const captureUndoGeneration = useCallback(() => undoGenerationRef.current, []);

  const recordUndoEntry = useCallback((entry: TrackerUndoEntry, generation?: number) => {
    if (entry.changes.length === 0) return;
    // A clear between the write starting and this call means the entry belongs
    // to a history that no longer exists.
    if (generation !== undefined && generation !== undoGenerationRef.current) return;

    const batch = undoBatchRef.current;
    if (batch) {
      // Past the cap the entry is doomed anyway (applyRecord drops it whole), so
      // stop growing it -- one change beyond the cap already records the overflow.
      if (batch.changes.length > MAX_UNDO_CHANGES_PER_ENTRY) return;
      batch.changes = mergeUndoChanges(batch.changes, entry.changes);
      return;
    }
    undoHistoryRef.current = applyRecord(undoHistoryRef.current, {
      label: entry.label,
      changes: mergeUndoChanges([], entry.changes),
    });
  }, []);

  const runUndoable = useCallback(async <T,>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    // An open batch is joined rather than nested. Two independent gestures can
    // only overlap inside the window of a single durable write, and merging them
    // costs a coarser label -- never a lost inverse. JS has no async-context
    // hook to tell that apart from real nesting, so it is not worth machinery.
    if (undoBatchRef.current) {
      return await fn();
    }

    const batch = { label, generation: undoGenerationRef.current, changes: [] as TrackerUndoChange[] };
    undoBatchRef.current = batch;
    try {
      return await fn();
    } finally {
      if (undoBatchRef.current === batch) {
        undoBatchRef.current = null;
        // Durable writes cannot be rolled back as a group. If fn throws after
        // some writes land, keep those inverses so the user can still undo them.
        recordUndoEntry({ label: batch.label, changes: batch.changes }, batch.generation);
      }
    }
  }, [recordUndoEntry]);

  const clearUndoHistory = useCallback(() => {
    undoGenerationRef.current += 1;
    undoBatchRef.current = null;
    undoHistoryRef.current = applyClear();
  }, []);

  // Context menu state
  const [contextAnchor, setContextAnchor] = useState<DOMRect | null>(null);

  // Floating context menu
  const { refs: contextRefs, floatingStyles: contextFloatingStyles } = useFloating({
    placement: 'right-start',
    middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });
  useEffect(() => {
    if (contextAnchor) {
      contextRefs.setReference({ getBoundingClientRect: () => contextAnchor });
    }
  }, [contextAnchor, contextRefs]);

  // Clear selection when the active type filter changes
  useEffect(() => {
    setSelectedIds(new Set());
    lastClickedIndexRef.current = -1;
    clearUndoHistory();
  }, [activeTypeFilter, clearUndoHistory]);

  // Track sorted items in a ref so event handlers can access them
  const itemsRef = useRef<TrackerRecord[]>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Focus title input when editing starts
  useEffect(() => {
    if (editingCell?.field === 'title' && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingCell]);

  /**
   * Single write for one item covering any number of fields. Both the
   * document-backed and native paths take a full `updates` map, so a multi-field
   * cell commit costs one write (and one sync message) rather than one per field.
   */
  const updateItem = useCallback(async (
    item: TrackerRecord,
    updates: Record<string, unknown>,
    options?: { record?: boolean },
  ): Promise<boolean> => {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.documentService) return false;
    const fields = Object.keys(updates);
    if (fields.length === 0) return false;

    const generation = undoGenerationRef.current;
    const changes: TrackerUndoChange[] = fields.map(field => ({
      kind: 'field',
      itemId: item.id,
      field,
      previousValue: item.fields[field],
      nextValue: updates[field],
    }));

    try {
      // Both IPC calls resolve `{success, error}` rather than rejecting, so a
      // main-process failure looks exactly like a success until it is read.
      let result: { success?: boolean; error?: string } | undefined;
      if ((item.source === 'frontmatter' || item.source === 'import' || item.source === 'inline') && item.system.documentPath) {
        if (electronAPI.documentService.updateTrackerItemInFile) {
          result = await electronAPI.documentService.updateTrackerItemInFile({
            itemId: item.id,
            updates,
          });
        } else {
          return false;
        }
      } else if (!item.system.documentPath || item.source === 'native') {
        const tracker = globalRegistry.get(item.primaryType);
        const syncMode = tracker?.sync?.mode || 'local';
        result = await electronAPI.documentService.updateTrackerItem({
          itemId: item.id,
          updates,
          syncMode,
        });
      } else {
        return false;
      }

      if (result?.success === false) {
        console.error('[useTrackerRows] Tracker item update rejected:', result.error);
        return false;
      }

      // Provenance, not timing: only the caller knows whether this write is the
      // user's own edit or a replay of one already in the history. A replay in
      // flight must not suppress recording for an unrelated edit beside it.
      if (options?.record !== false) {
        const label = fields.length === 1
          ? `Edit ${fields[0].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase())}`
          : `Edit ${fields.length} fields`;
        recordUndoEntry({ label, changes }, generation);
      }
      return true;
    } catch (err) {
      console.error('[useTrackerRows] Failed to update item:', err);
      return false;
    }
  }, [recordUndoEntry]);

  const handleItemUpdate = useCallback(async (
    item: TrackerRecord,
    updates: Record<string, unknown>,
  ): Promise<void> => {
    await updateItem(item, updates);
  }, [updateItem]);

  const replayEntry = useCallback(async (
    entry: TrackerUndoEntry,
    direction: 'undo' | 'redo',
  ): Promise<TrackerUndoReplayResult> => {
    const changesByItem = new Map<string, TrackerUndoChange[]>();
    for (const change of entry.changes) {
      const group = changesByItem.get(change.itemId) ?? [];
      group.push(change);
      changesByItem.set(change.itemId, group);
    }

    let applied = 0;
    let skipped = 0;
    for (const [itemId, changes] of changesByItem) {
      // `find` may miss: archiving an item drops it out of the loaded set, and
      // that absence is the very thing an archive undo exists to reverse.
      const item = itemsRef.current.find(candidate => candidate.id === itemId)
        ?? resolveRecordById?.(itemId)
        ?? null;
      const fieldChanges = changes.filter(
        (change): change is Extract<TrackerUndoChange, { kind: 'field' }> => change.kind === 'field',
      );
      const archiveChanges = changes.filter(
        (change): change is Extract<TrackerUndoChange, { kind: 'archive' }> => change.kind === 'archive',
      );

      if (fieldChanges.length > 0) {
        // A field write needs the live record: it is the write's `item`
        // argument and the only source for the drift comparison.
        if (!item || !isItemEditable(item)) {
          skipped += fieldChanges.length;
        } else {
          const fieldUpdates: Record<string, unknown> = {};
          let eligibleFieldChanges = 0;

          for (const change of fieldChanges) {
            const expectedValue = direction === 'undo' ? change.nextValue : change.previousValue;
            if (!areTrackerUndoValuesEqual(item.fields[change.field], expectedValue)) {
              skipped += 1;
              continue;
            }

            fieldUpdates[change.field] = direction === 'undo'
              ? change.previousValue
              : change.nextValue;
            eligibleFieldChanges += 1;
          }

          if (eligibleFieldChanges > 0) {
            // All eligible fields for an item share the normal durable update
            // path, preserving its one-write-per-row behavior during replay.
            // `record: false` marks the write as a replay by provenance, so a
            // user edit landing alongside it still records its own inverse.
            if (await updateItem(item, fieldUpdates, { record: false })) {
              applied += eligibleFieldChanges;
            } else {
              skipped += eligibleFieldChanges;
            }
          }
        }
      }

      if (archiveChanges.length > 0) {
        if (!onArchiveItems) {
          skipped += archiveChanges.length;
          continue;
        }

        // One entry holds at most one archive change per item -- the recorder
        // emits a single change per id, so there is no direction to reconcile.
        const change = archiveChanges[0];
        const expectedArchived = direction === 'undo'
          ? change.nextArchived
          : change.previousArchived;
        // Drift is only checkable while the record is still loaded. Once it is
        // gone the archive flag is unreadable, and replaying is safe anyway:
        // `archiveTrackerItem` is an absolute set, not a toggle.
        if (item && item.archived !== expectedArchived) {
          skipped += archiveChanges.length;
          continue;
        }

        try {
          await onArchiveItems(
            [itemId],
            direction === 'undo' ? change.previousArchived : change.nextArchived,
            { record: false },
          );
          // A rejection is the only failure this path can see: the callback
          // returns void, and the host's archive loop logs and swallows per-item
          // IPC failures. A resolved call therefore means "attempted", not
          // "applied" -- see the Risks section of the plan.
          applied += archiveChanges.length;
        } catch (err) {
          console.error('[useTrackerRows] Failed to replay archive change:', err);
          skipped += archiveChanges.length;
        }
      }
    }

    return { label: entry.label, applied, skipped };
  }, [isItemEditable, onArchiveItems, resolveRecordById, updateItem]);

  /**
   * Replay the top of the stack, one at a time.
   *
   * A second Cmd+Z pressed while the first is still writing is **dropped, not
   * queued**. Both entries would otherwise be consumed against the same record
   * snapshot: the first replay writes B, the second still reads C and skips its
   * change as drift -- two entries gone, one write done. Queuing does not fix
   * that, because what the second replay has to wait for is the rendered record
   * catching up (IPC -> main -> tracker atom -> re-render), and the hook has no
   * handle on that round trip; it can only await its own IPC call. Dropping is
   * the fail-safe half: the history is untouched and the keystroke is the same
   * no-op as Cmd+Z on an empty stack, so pressing again works.
   */
  const replayTop = useCallback(async (
    direction: 'undo' | 'redo',
  ): Promise<TrackerUndoReplayResult | null> => {
    if (replayInFlightRef.current) return null;
    replayInFlightRef.current = true;
    try {
      const result = direction === 'undo'
        ? applyUndo(undoHistoryRef.current)
        : applyRedo(undoHistoryRef.current);
      if (!result.entry) return null;
      // Consume before replay. Even an entirely stale entry must not remain at
      // the top of the stack and trap the user on repeated no-op undos.
      undoHistoryRef.current = result.history;
      return await replayEntry(result.entry, direction);
    } finally {
      replayInFlightRef.current = false;
    }
  }, [replayEntry]);

  const undo = useCallback(() => replayTop('undo'), [replayTop]);
  const redo = useCallback(() => replayTop('redo'), [replayTop]);

  const handleFieldUpdate = useCallback(async (item: TrackerRecord, field: string, value: unknown) => {
    await handleItemUpdate(item, { [field]: value });
    setEditingCell(null);
  }, [handleItemUpdate]);

  /**
   * Apply one field/value across many items. Writes run concurrently -- each is an
   * independent per-item update, and serializing them made bulk edits over a large
   * selection feel like a hang.
   */
  const handleBulkFieldUpdate = useCallback(async (
    targets: TrackerRecord[],
    field: string,
    value: unknown,
  ) => {
    const editable = targets.filter(isItemEditable);
    await Promise.all(editable.map(item => handleItemUpdate(item, { [field]: value })));
    setEditingCell(null);
  }, [handleItemUpdate, isItemEditable]);

  /** Toggle select all / deselect all */
  const handleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      if (prev.size === itemsRef.current.length && prev.size > 0) {
        return new Set();
      }
      return new Set(itemsRef.current.map(i => i.id).filter(Boolean));
    });
  }, []);

  /** Context menu handler */
  const handleContextMenu = useCallback((e: React.MouseEvent, item: TrackerRecord, index: number) => {
    e.preventDefault();
    e.stopPropagation();

    // If right-clicking an unselected item, select just that item
    if (!selectedIds.has(item.id)) {
      setSelectedIds(new Set([item.id]));
      lastClickedIndexRef.current = index;
    }
    setFocusedIndex(index);
    setContextAnchor(DOMRect.fromRect({ x: e.clientX, y: e.clientY, width: 0, height: 0 }));
  }, [selectedIds]);

  /** Open the context menu over a caller-supplied selection. */
  const openContextMenuForIds = useCallback((
    itemIds: string[],
    point: { x: number; y: number },
  ) => {
    if (itemIds.length === 0) return;
    setSelectedIds(new Set(itemIds));
    setContextAnchor(DOMRect.fromRect({ x: point.x, y: point.y, width: 0, height: 0 }));
  }, []);

  /** Close context menu */
  const closeContextMenu = useCallback(() => setContextAnchor(null), []);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextAnchor) return;
    const handler = () => setContextAnchor(null);
    document.addEventListener('click', handler);
    document.addEventListener('contextmenu', handler);
    return () => {
      document.removeEventListener('click', handler);
      document.removeEventListener('contextmenu', handler);
    };
  }, [contextAnchor]);

  /**
   * Apply a role-mapped value across the selection. The target field name is
   * resolved per item because a mixed-type selection can map the same role
   * (workflowStatus, priority) to differently-named fields.
   */
  const handleBulkRoleUpdate = useCallback(async (
    role: 'workflowStatus' | 'priority',
    value: string,
  ) => {
    closeContextMenu();
    const itemsToUpdate = itemsRef.current.filter(i => selectedIds.has(i.id) && isItemEditable(i));
    const roleLabel = role === 'workflowStatus' ? 'Status' : 'Priority';
    await runUndoable(`Set ${roleLabel} on ${itemsToUpdate.length} items`, async () => {
      await Promise.all(itemsToUpdate.map(item =>
        handleItemUpdate(item, { [resolveRoleFieldName(item.primaryType, role)]: value })
      ));
    });
    setEditingCell(null);
  }, [selectedIds, closeContextMenu, isItemEditable, handleItemUpdate, runUndoable]);

  /** Bulk status update for selected items */
  const handleBulkStatusUpdate = useCallback(
    (newStatus: string) => handleBulkRoleUpdate('workflowStatus', newStatus),
    [handleBulkRoleUpdate],
  );

  /** Bulk priority update for selected items */
  const handleBulkPriorityUpdate = useCallback(
    (newPriority: string) => handleBulkRoleUpdate('priority', newPriority),
    [handleBulkRoleUpdate],
  );

  const handleAddSelectionToCollection = useCallback(async (collection: TrackerRecord) => {
    closeContextMenu();
    const membersField = getMembersField(collection.primaryType);
    if (!membersField) return;

    const selected = itemsRef.current.filter(i => selectedIds.has(i.id));
    if (selected.length === 0) return;

    // One write on the collection rather than one per member: the inverse edge
    // on each member is propagated by the main process.
    const collectionTitle = getRecordTitle(collection) || collection.id;
    await runUndoable(`Add ${selected.length} items to ${collectionTitle}`, async () => {
      await handleItemUpdate(collection, {
        [membersField.name]: addMembersValue(collection, selected),
      });
    });
  }, [selectedIds, closeContextMenu, handleItemUpdate, runUndoable]);

  /** Open a document-backed tracker item in the editor */
  const openItemInEditor = useCallback((item: TrackerRecord) => {
    if (onSwitchToFilesMode) {
      onSwitchToFilesMode();
    }

    const documentService = (window as any).documentService;
    if (documentService && documentService.openDocument) {
      documentService.getDocumentByPath(item.system.documentPath).then((doc: any) => {
        if (doc) {
          const fullPath = item.system.workspace && doc.path
            ? `${item.system.workspace}/${doc.path}`.replace(/\/+/g, '/')
            : doc.path;

          documentService.openDocument(doc.id).then(() => {
            if (item.system.lineNumber !== undefined && item.system.lineNumber !== 0) {
              const editorRegistry = (window as any).__editorRegistry;
              if (editorRegistry && item.id) {
                setTimeout(() => {
                  editorRegistry.scrollToTrackerItem(fullPath, item.id);
                }, 500);
              }
            }
          });
        }
      });
    }
  }, [onSwitchToFilesMode]);

  /** Keyboard navigation */
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const list = itemsRef.current;
      if (list.length === 0) return;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          setFocusedIndex(prev => {
            const next = Math.min(prev + 1, list.length - 1);
            if (e.shiftKey) {
              setSelectedIds(s => { const n = new Set(s); n.add(list[next].id); return n; });
            }
            return next;
          });
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          setFocusedIndex(prev => {
            const next = Math.max(prev - 1, 0);
            if (e.shiftKey) {
              setSelectedIds(s => { const n = new Set(s); n.add(list[next].id); return n; });
            }
            return next;
          });
          break;
        }
        case ' ': {
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < list.length) {
            const item = list[focusedIndex];
            setSelectedIds(prev => {
              const next = new Set(prev);
              if (next.has(item.id)) next.delete(item.id);
              else next.add(item.id);
              return next;
            });
          }
          break;
        }
        case 'Enter': {
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < list.length) {
            const item = list[focusedIndex];
            if (onItemSelect && item.id) {
              onItemSelect(item.id);
            }
          }
          break;
        }
        case 'Delete':
        case 'Backspace': {
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            if (selectedIds.size > 0 && onDeleteItems) {
              const ids = Array.from(selectedIds);
              if (window.confirm(`Delete ${ids.length} item${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) {
                onDeleteItems(ids);
                setSelectedIds(new Set());
              }
            }
          }
          break;
        }
        case 'a': {
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            handleSelectAll();
          }
          break;
        }
        case 'Escape': {
          setSelectedIds(new Set());
          setFocusedIndex(-1);
          closeContextMenu();
          break;
        }
      }
    };

    node.addEventListener('keydown', handleKeyDown);
    return () => node.removeEventListener('keydown', handleKeyDown);
  }, [focusedIndex, selectedIds, onItemSelect, onDeleteItems, handleSelectAll, closeContextMenu]);

  // Scroll focused row into view. The RevoGrid table does its own
  // virtualized scrolling, so this only matches the list view's rows.
  useEffect(() => {
    if (focusedIndex < 0) return;
    const rows = containerRef.current?.querySelectorAll(
      '[data-testid="tracker-table-row"]'
    );
    const row = rows?.[focusedIndex];
    if (row) row.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const handleRowClick = useCallback((item: TrackerRecord, index: number, e: React.MouseEvent) => {
    // Multi-select: Cmd/Ctrl+click toggles, Shift+click extends range
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
      lastClickedIndexRef.current = index;
      return;
    }
    if (e.shiftKey && lastClickedIndexRef.current >= 0) {
      e.preventDefault();
      const from = Math.min(lastClickedIndexRef.current, index);
      const to = Math.max(lastClickedIndexRef.current, index);
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (let i = from; i <= to; i++) {
          if (itemsRef.current[i]?.id) next.add(itemsRef.current[i].id);
        }
        return next;
      });
      return;
    }

    // Plain click: clear selection
    setSelectedIds(new Set());
    lastClickedIndexRef.current = index;

    if (posthog) {
      posthog.capture('tracker_item_clicked', {
        trackerType: item.primaryType,
        itemStatus: item.fields.status,
        isInline: item.system.lineNumber !== undefined && item.system.lineNumber !== 0,
      });
    }

    // If onItemSelect is provided (Tracker Mode), open detail panel instead
    if (onItemSelect && item.id) {
      onItemSelect(item.id);
      return;
    }

    // Editable items - start editing title inline
    if (isItemEditable(item)) {
      setEditingTitle((item.fields.title as string) ?? '');
      setEditingCell({ itemId: item.id, field: 'title' });
      return;
    }

    // Switch to files mode first if we're in agent mode
    if (onSwitchToFilesMode) {
      onSwitchToFilesMode();
    }

    openItemInEditor(item);
  }, [posthog, onItemSelect, isItemEditable, onSwitchToFilesMode, openItemInEditor]);

  // Status options for the bulk Set Status submenu
  const statusOptionsForBulk = useMemo<Array<string | { value: string; label: string }>>(() => {
    if (activeTypeFilter !== 'all') {
      const tracker = globalRegistry.get(activeTypeFilter);
      const statusFieldName = resolveRoleFieldName(activeTypeFilter, 'workflowStatus');
      const statusField = tracker?.fields.find(f => f.name === statusFieldName);
      if (statusField?.options) {
        return statusField.options;
      }
    }
    return [
      { value: 'to-do', label: 'To Do' },
      { value: 'in-progress', label: 'In Progress' },
      { value: 'in-review', label: 'In Review' },
      { value: 'done', label: 'Done' },
      { value: 'blocked', label: 'Blocked' },
    ];
  }, [activeTypeFilter]);

  return {
    selectedIds,
    setSelectedIds,
    handleSelectAll,
    focusedIndex,
    setFocusedIndex,
    containerRef,
    editingCell,
    setEditingCell,
    editingTitle,
    setEditingTitle,
    titleInputRef,
    handleFieldUpdate,
    handleItemUpdate,
    handleBulkFieldUpdate,
    runUndoable,
    recordUndoEntry,
    captureUndoGeneration,
    undo,
    redo,
    isItemEditable,
    handleRowClick,
    openItemInEditor,
    contextAnchor,
    contextRefs,
    contextFloatingStyles,
    handleContextMenu,
    openContextMenuForIds,
    closeContextMenu,
    handleBulkStatusUpdate,
    handleBulkPriorityUpdate,
    handleAddSelectionToCollection,
    statusOptionsForBulk,
  };
}
