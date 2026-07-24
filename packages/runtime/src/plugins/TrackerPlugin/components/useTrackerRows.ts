/**
 * useTrackerRows -- shared row interaction model for the tracker list view
 * (`TrackerTable`) and the tracker grid view (`TrackerTableGrid`).
 *
 * Owns selection, keyboard navigation, inline editing, context menu state,
 * and bulk updates so both view surfaces share identical behavior.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFloating, offset, flip, shift } from '@floating-ui/react';
import { usePostHog } from 'posthog-js/react';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import type { TrackerItemType } from '../../../core/DocumentService';
import { globalRegistry } from '../models';
import { getMembersField, addMembersValue } from '../models/trackerCollections';
import { resolveRoleFieldName } from '../trackerRecordAccessors';

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
  /** Bulk archive callback. */
  onArchiveItems?: (itemIds: string[], archive: boolean) => void;
  /** Files-mode switcher used when opening an item that lives in a document. */
  onSwitchToFilesMode?: () => void;
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

  // Row interaction
  isItemEditable: (item: TrackerRecord) => boolean;
  handleRowClick: (item: TrackerRecord, index: number, e: React.MouseEvent) => void;
  openItemInEditor: (item: TrackerRecord) => void;

  // Context menu
  contextAnchor: DOMRect | null;
  contextRefs: ReturnType<typeof useFloating>['refs'];
  contextFloatingStyles: ReturnType<typeof useFloating>['floatingStyles'];
  handleContextMenu: (e: React.MouseEvent, item: TrackerRecord, index: number) => void;
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
  onSwitchToFilesMode,
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

  // Context menu state
  const [contextAnchor, setContextAnchor] = useState<DOMRect | null>(null);

  // Floating context menu
  const { refs: contextRefs, floatingStyles: contextFloatingStyles } = useFloating({
    placement: 'right-start',
    middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 })],
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
  }, [activeTypeFilter]);

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
  const handleItemUpdate = useCallback(async (item: TrackerRecord, updates: Record<string, unknown>) => {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.documentService) return;
    if (Object.keys(updates).length === 0) return;

    try {
      if ((item.source === 'frontmatter' || item.source === 'import' || item.source === 'inline') && item.system.documentPath) {
        if (electronAPI.documentService.updateTrackerItemInFile) {
          await electronAPI.documentService.updateTrackerItemInFile({
            itemId: item.id,
            updates,
          });
        }
      } else if (!item.system.documentPath || item.source === 'native') {
        const tracker = globalRegistry.get(item.primaryType);
        const syncMode = tracker?.sync?.mode || 'local';
        await electronAPI.documentService.updateTrackerItem({
          itemId: item.id,
          updates,
          syncMode,
        });
      }
    } catch (err) {
      console.error('[useTrackerRows] Failed to update item:', err);
    }
  }, []);

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
    await Promise.all(itemsToUpdate.map(item =>
      handleItemUpdate(item, { [resolveRoleFieldName(item.primaryType, role)]: value })
    ));
    setEditingCell(null);
  }, [selectedIds, closeContextMenu, isItemEditable, handleItemUpdate]);

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
    await handleItemUpdate(collection, {
      [membersField.name]: addMembersValue(collection, selected),
    });
  }, [selectedIds, closeContextMenu, handleItemUpdate]);

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

  // Scroll focused row into view (looks for data-testid="tracker-table-row"
  // or "tracker-table-grid-row" so the same logic works for both surfaces)
  useEffect(() => {
    if (focusedIndex < 0) return;
    const rows = containerRef.current?.querySelectorAll(
      '[data-testid="tracker-table-row"], [data-testid="tracker-table-grid-row"]'
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
    isItemEditable,
    handleRowClick,
    openItemInEditor,
    contextAnchor,
    contextRefs,
    contextFloatingStyles,
    handleContextMenu,
    closeContextMenu,
    handleBulkStatusUpdate,
    handleBulkPriorityUpdate,
    handleAddSelectionToCollection,
    statusOptionsForBulk,
  };
}
