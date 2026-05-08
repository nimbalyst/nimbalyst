import React, { useCallback, useRef, useEffect, useState } from 'react';
import { useAtomValue, useSetAtom, useAtom } from 'jotai';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { store } from '@nimbalyst/runtime/store';
import { FileTreeRow } from './FileTreeRow';
import { FileContextMenu } from './FileContextMenu';
import type { NewFileType, ExtensionFileType } from './NewFileMenu';
import { handleTreeKeyDown, type TreeActions } from '../utils/treeKeyboardHandler';
import {
  expandedDirsAtom,
  revealRequestAtom,
  selectedFolderPathAtom,
  fileTreeItemsAtom,
  flatTreeActiveFileAtom,
  selectedPathsAtom,
  lastSelectedPathAtom,
  focusedIndexAtom,
  dragStateAtom,
  visibleNodesAtom,
  type RendererFileTreeItem,
  type FlatTreeNode,
} from '../store';
import { dialogRef } from '../contexts/DialogContext';
import { DIALOG_IDS } from '../dialogs/registry';

interface FlatFileTreeProps {
  items: RendererFileTreeItem[];
  currentFilePath: string | null;
  onFileSelect: (filePath: string) => void;
  showIcons?: boolean;
  enableAutoScroll?: boolean;
  onNewFile?: (folderPath: string, fileType: NewFileType) => void;
  onNewFolder?: (folderPath: string) => void;
  onRefreshFileTree?: () => void;
  onFolderContentsLoaded?: (folderPath: string, contents: RendererFileTreeItem[]) => void;
  onViewWorkspaceHistory?: (folderPath: string) => void;
  onFolderSelect?: (folderPath: string | null) => void;
  extensionFileTypes?: ExtensionFileType[];
}

/**
 * Flat virtualized file tree component.
 *
 * Replaces the recursive FileTree component with a single Virtuoso list.
 * Tree model state lives in Jotai atoms; this component just renders
 * the flat list derived from visibleNodesAtom.
 */
export function FlatFileTree({
  items,
  currentFilePath,
  onFileSelect,
  showIcons = true,
  enableAutoScroll = true,
  onNewFile,
  onNewFolder,
  onRefreshFileTree,
  onFolderContentsLoaded,
  onViewWorkspaceHistory,
  onFolderSelect,
  extensionFileTypes = [],
}: FlatFileTreeProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Atoms
  const visibleNodes = useAtomValue(visibleNodesAtom);
  const expandedDirs = useAtomValue(expandedDirsAtom);
  const setExpandedDirs = useSetAtom(expandedDirsAtom);
  const [revealRequest, setRevealRequest] = useAtom(revealRequestAtom);
  const [selectedPaths, setSelectedPaths] = useAtom(selectedPathsAtom);
  const [lastSelectedPath, setLastSelectedPath] = useAtom(lastSelectedPathAtom);
  const [dragState, setDragState] = useAtom(dragStateAtom);
  const setSelectedFolder = useSetAtom(selectedFolderPathAtom);
  const [focusedIndex, setFocusedIndex] = useAtom(focusedIndexAtom);

  // Inline rename state
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // Type-ahead find
  const typeAheadBufferRef = useRef('');
  const typeAheadTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Viewport row count for PageUp/PageDown
  const containerRef = useRef<HTMLDivElement>(null);
  const ROW_HEIGHT = 28;

  // Auto-scroll during drag
  const autoScrollSpeedRef = useRef(0);
  const autoScrollFrameRef = useRef<number | null>(null);

  // Expand-on-hover during drag
  const expandHoverTimerRef = useRef<{ path: string; timer: NodeJS.Timeout } | null>(null);

  // Track whether focus change came from keyboard (should scroll) vs mouse (should not)
  const keyboardFocusRef = useRef(false);

  // Sync props -> atoms so visibleNodesAtom can derive from them
  useEffect(() => {
    store.set(fileTreeItemsAtom, items);
  }, [items]);

  useEffect(() => {
    store.set(flatTreeActiveFileAtom, currentFilePath);
  }, [currentFilePath]);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    filePath: string;
    fileName: string;
    fileType: 'file' | 'directory';
  } | null>(null);

  // Track user interaction for auto-scroll suppression
  const lastUserInteractionRef = useRef<number>(0);
  const fileClickedInTreeRef = useRef<boolean>(false);
  const prevFilePathRef = useRef<string | null>(null);

  // == IPC sync: notify main process when directories expand/collapse ==
  const prevExpandedRef = useRef<Set<string>>(expandedDirs);
  useEffect(() => {
    const prev = prevExpandedRef.current;
    prevExpandedRef.current = expandedDirs;

    if (!window.electronAPI) return;

    for (const dir of expandedDirs) {
      if (!prev.has(dir)) {
        window.electronAPI.invoke('workspace-folder-expanded', dir);
      }
    }

    for (const dir of prev) {
      if (!expandedDirs.has(dir)) {
        window.electronAPI.invoke('workspace-folder-collapsed', dir);
      }
    }
  }, [expandedDirs]);

  // == Helper: collect all directory paths from the tree ==
  const treeDirPathsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const paths = new Set<string>();
    function walk(treeItems: RendererFileTreeItem[]) {
      for (const item of treeItems) {
        if (item.type === 'directory') {
          paths.add(item.path);
          if (item.children) walk(item.children);
        }
      }
    }
    walk(items);
    treeDirPathsRef.current = paths;
  }, [items]);

  // == Helper: get parent dirs that exist in the tree ==
  const getTreeParentDirs = useCallback((filePath: string): string[] => {
    const parts = filePath.split('/');
    const dirs: string[] = [];
    for (let i = 1; i < parts.length - 1; i++) {
      dirs.push(parts.slice(0, i + 1).join('/'));
    }
    // Only return dirs that actually exist in the file tree items
    return dirs.filter(d => treeDirPathsRef.current.has(d));
  }, []);

  // == Expand parents of current file on mount ==
  const hasInitializedRef = useRef(false);
  useEffect(() => {
    if (hasInitializedRef.current || !currentFilePath) return;
    hasInitializedRef.current = true;

    const dirs = getTreeParentDirs(currentFilePath);
    if (dirs.length > 0) {
      setExpandedDirs(prev => {
        const next = new Set(prev);
        let changed = false;
        for (const dir of dirs) {
          if (!next.has(dir)) {
            next.add(dir);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, [currentFilePath, setExpandedDirs, getTreeParentDirs]);

  // == Auto-expand parents when active file changes ==
  useEffect(() => {
    if (!currentFilePath) return;

    const dirs = getTreeParentDirs(currentFilePath);
    if (dirs.length > 0) {
      setExpandedDirs(prev => {
        const next = new Set(prev);
        let changed = false;
        for (const dir of dirs) {
          if (!next.has(dir)) {
            next.add(dir);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, [currentFilePath, setExpandedDirs, getTreeParentDirs]);

  // == Reveal: scroll to target when revealRequest changes ==
  // If target isn't in visibleNodes, triggers a tree refresh and waits for
  // the items to change (e.g. filter clearing) before giving up.
  const revealRetryRef = useRef<{ ts: number; itemsAtRefresh: number; attempts: number } | null>(null);
  useEffect(() => {
    if (!revealRequest) return;

    const index = visibleNodes.findIndex(n => n.path === revealRequest.path);
    if (index >= 0) {
      virtuosoRef.current?.scrollToIndex({
        index,
        behavior: 'smooth',
        align: 'center',
      });
      revealRetryRef.current = null;
      setRevealRequest(null);
      return;
    }

    // Target not found -- request a tree refresh and retry when items change
    const retry = revealRetryRef.current;
    if (retry && retry.ts === revealRequest.ts) {
      // Already retrying for this request. Only give up if items didn't change
      // (meaning the refresh/filter-clear didn't produce new data) and we've
      // tried at least twice.
      if (items.length === retry.itemsAtRefresh && retry.attempts >= 3) {
        setRevealRequest(null);
        return;
      }
      // Items changed (filter cleared, tree refreshed) -- record new baseline and keep waiting
      retry.itemsAtRefresh = items.length;
      retry.attempts++;
      return;
    }

    // First attempt for this reveal request
    revealRetryRef.current = { ts: revealRequest.ts, itemsAtRefresh: items.length, attempts: 1 };
    onRefreshFileTree?.();
  }, [revealRequest, visibleNodes, items, onRefreshFileTree, setRevealRequest]);

  // == Auto-scroll to active file when tab changes ==
  // Only scroll when the active file actually changes, NOT when visibleNodes
  // changes (e.g. expanding/collapsing a directory). We use a deferred scroll
  // so the index lookup happens after visibleNodes has settled, but expire it
  // quickly so stale pending scrolls don't fire on later tree changes.
  const pendingScrollPathRef = useRef<string | null>(null);
  const pendingScrollTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!currentFilePath || !enableAutoScroll) return;

    const filePathChanged = prevFilePathRef.current !== currentFilePath;
    if (filePathChanged) {
      prevFilePathRef.current = currentFilePath;

      if (fileClickedInTreeRef.current) {
        fileClickedInTreeRef.current = false;
        return;
      }

      const timeSinceLastInteraction = Date.now() - lastUserInteractionRef.current;
      if (timeSinceLastInteraction > 2000) {
        pendingScrollPathRef.current = currentFilePath;
        // Expire pending scroll after 500ms so it doesn't fire on
        // unrelated tree changes (e.g. user manually expanding dirs)
        if (pendingScrollTimerRef.current) clearTimeout(pendingScrollTimerRef.current);
        pendingScrollTimerRef.current = setTimeout(() => {
          pendingScrollPathRef.current = null;
          pendingScrollTimerRef.current = null;
        }, 500);
      }
    }
  }, [currentFilePath, enableAutoScroll]);

  // Perform the deferred scroll once visibleNodes updates
  useEffect(() => {
    if (!pendingScrollPathRef.current) return;
    const index = visibleNodes.findIndex(n => n.path === pendingScrollPathRef.current);
    if (index >= 0) {
      virtuosoRef.current?.scrollToIndex({
        index,
        behavior: 'smooth',
        align: 'center',
      });
      pendingScrollPathRef.current = null;
      if (pendingScrollTimerRef.current) {
        clearTimeout(pendingScrollTimerRef.current);
        pendingScrollTimerRef.current = null;
      }
    }
  }, [visibleNodes]);

  // == Clear multi-selection when a file is opened from outside the tree ==
  useEffect(() => {
    if (currentFilePath && selectedPaths.size > 0 && !selectedPaths.has(currentFilePath)) {
      setSelectedPaths(new Set<string>([currentFilePath]));
      setLastSelectedPath(currentFilePath);
    }
  }, [currentFilePath, selectedPaths, setSelectedPaths, setLastSelectedPath]);

  // == Toggle directory expand/collapse ==
  const toggleDirectory = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const newSet = new Set(prev);
      const wasExpanded = newSet.has(path);
      if (wasExpanded) {
        newSet.delete(path);
      } else {
        newSet.add(path);
        // Refresh folder contents when user opens a folder
        if (window.electronAPI?.refreshFolderContents) {
          window.electronAPI.refreshFolderContents(path).then((refreshedContents) => {
            if (onFolderContentsLoaded) {
              onFolderContentsLoaded(path, Array.isArray(refreshedContents) ? refreshedContents : []);
            } else if (onRefreshFileTree) {
              onRefreshFileTree();
            }
          }).catch((error) => {
            console.error('Error refreshing folder contents:', error);
          });
        }
      }
      return newSet;
    });
  }, [setExpandedDirs, onFolderContentsLoaded, onRefreshFileTree]);

  // == Flatten visible items for range selection ==
  const flattenVisibleItems = useCallback((): RendererFileTreeItem[] => {
    // visibleNodes already represents the flat visible list
    return visibleNodes.map(n => ({ name: n.name, path: n.path, type: n.type }));
  }, [visibleNodes]);

  // == Selection handler ==
  const handleItemSelect = useCallback((e: React.MouseEvent, node: FlatTreeNode) => {
    const isMetaKey = e.metaKey || e.ctrlKey;
    const isShiftKey = e.shiftKey;

    if (isShiftKey && lastSelectedPath) {
      const lastIndex = visibleNodes.findIndex(n => n.path === lastSelectedPath);
      const currentIndex = visibleNodes.findIndex(n => n.path === node.path);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        const newSelection = new Set(selectedPaths);
        for (let i = start; i <= end; i++) {
          newSelection.add(visibleNodes[i].path);
        }
        setSelectedPaths(newSelection);
      }
    } else if (isMetaKey) {
      const newSelection = new Set(selectedPaths);
      if (newSelection.has(node.path)) {
        newSelection.delete(node.path);
      } else {
        newSelection.add(node.path);
      }
      setSelectedPaths(newSelection);
      setLastSelectedPath(node.path);
    } else {
      setSelectedPaths(new Set<string>([node.path]));
      setLastSelectedPath(node.path);

      if (node.type === 'file') {
        onFolderSelect?.(null);
        fileClickedInTreeRef.current = true;
        onFileSelect(node.path);
      }
    }
  }, [visibleNodes, lastSelectedPath, selectedPaths, setSelectedPaths, setLastSelectedPath, onFolderSelect, onFileSelect]);

  // == Row click handler ==
  const handleRowClick = useCallback((e: React.MouseEvent, node: FlatTreeNode) => {
    lastUserInteractionRef.current = Date.now();

    if (node.type === 'directory') {
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        handleItemSelect(e, node);
      } else {
        toggleDirectory(node.path);
        onFolderSelect?.(node.path);
        handleItemSelect(e, node);
      }
    } else {
      handleItemSelect(e, node);
    }
  }, [toggleDirectory, handleItemSelect, onFolderSelect]);

  // == Context menu ==
  const handleContextMenu = useCallback((e: React.MouseEvent, node: FlatTreeNode) => {
    e.preventDefault();
    e.stopPropagation();

    if (!selectedPaths.has(node.path)) {
      setSelectedPaths(new Set<string>([node.path]));
      setLastSelectedPath(node.path);
    }

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      filePath: node.path,
      fileName: node.name,
      fileType: node.type,
    });
  }, [selectedPaths, setSelectedPaths, setLastSelectedPath]);

  // == Context menu actions ==
  const handleRename = useCallback(async (filePath: string, newName: string) => {
    const result = await window.electronAPI.renameFile(filePath, newName);
    if (!result.success) {
      console.error('Failed to rename file:', result.error);
    }
  }, []);

  const handleDelete = useCallback(async (filePath: string) => {
    const result = await window.electronAPI.deleteFile(filePath);
    if (!result.success) {
      // The user just confirmed a delete; silent failure is the worst possible
      // outcome. Surface the OS-level error (e.g. "Failed to move item to
      // trash" when the trash folder is unwritable, common on Linux). See #195.
      console.error('Failed to delete file:', result.error);
      dialogRef.current?.open(DIALOG_IDS.ERROR, {
        title: 'Delete failed',
        message: `Could not delete ${filePath.split(/[/\\]/).pop() || filePath}.`,
        details: result.error || 'The OS did not provide a reason. Check that the file still exists and that the trash folder is writable.',
      });
    }
  }, []);

  const handleDeleteMultiple = useCallback(async (filePaths: string[]) => {
    const failures: Array<{ path: string; error?: string }> = [];
    for (const path of filePaths) {
      const result = await window.electronAPI.deleteFile(path);
      if (!result.success) {
        console.error('Failed to delete file:', path, result.error);
        failures.push({ path, error: result.error });
      }
    }
    setSelectedPaths(new Set());
    if (failures.length > 0) {
      // Same silent-failure concern as handleDelete, but rolled up into a
      // single summary dialog rather than one per failed file. See #195.
      const failureSummary = failures
        .map(f => `- ${f.path.split(/[/\\]/).pop() || f.path}: ${f.error || 'unknown error'}`)
        .join('\n');
      dialogRef.current?.open(DIALOG_IDS.ERROR, {
        title: failures.length === filePaths.length ? 'Delete failed' : 'Some files could not be deleted',
        message: `${failures.length} of ${filePaths.length} file${filePaths.length === 1 ? '' : 's'} could not be deleted.`,
        details: failureSummary,
      });
    }
  }, [setSelectedPaths]);

  // == Drag and drop ==
  const handleDragStart = useCallback((e: React.DragEvent, node: FlatTreeNode) => {
    const target = e.target as HTMLElement;
    if (target.closest('.file-tree-icon') || target.closest('.file-tree-chevron')) {
      e.preventDefault();
      return;
    }

    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', node.path);
    // Also set custom MIME type so AI input can accept this as an @-file mention
    e.dataTransfer.setData('application/x-nimbalyst-file-mention', node.path);
    setDragState({
      sourcePaths: [node.path],
      dropTargetPath: null,
      isCopy: false,
    });

    // Custom drag image
    const dragImage = document.createElement('div');
    dragImage.textContent = node.name;
    dragImage.style.position = 'absolute';
    dragImage.style.top = '-1000px';
    dragImage.style.left = '-1000px';
    dragImage.style.padding = '4px 8px';
    dragImage.style.backgroundColor = '#ffffff';
    dragImage.style.border = '1px solid #e5e7eb';
    dragImage.style.borderRadius = '4px';
    dragImage.style.fontSize = '13px';
    dragImage.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
    dragImage.style.color = '#1f2937';
    dragImage.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
    dragImage.style.zIndex = '10000';
    dragImage.style.pointerEvents = 'none';
    document.body.appendChild(dragImage);
    e.dataTransfer.setDragImage(dragImage, 10, 10);

    setTimeout(() => {
      if (document.body.contains(dragImage)) {
        document.body.removeChild(dragImage);
      }
    }, 0);
  }, [setDragState]);

  const handleDragEnd = useCallback(() => {
    setDragState(null);
    if (expandHoverTimerRef.current) {
      clearTimeout(expandHoverTimerRef.current.timer);
      expandHoverTimerRef.current = null;
    }
    autoScrollSpeedRef.current = 0;
  }, [setDragState]);

  const handleDragOver = useCallback((e: React.DragEvent, node: FlatTreeNode) => {
    e.preventDefault();
    e.stopPropagation();

    // Handle external drag (from Finder) - no internal dragState
    if (!dragState && node.type === 'directory' && e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
      setDragState({ sourcePaths: [], dropTargetPath: node.path, isCopy: true });
      return;
    }

    if (dragState && node.type === 'directory' && !dragState.sourcePaths.includes(node.path)) {
      // Prevent dropping into own children
      const isChild = dragState.sourcePaths.some(src =>
        node.path.startsWith(src + '/')
      );
      if (isChild) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }

      const isCopy = e.altKey || e.metaKey;
      e.dataTransfer.dropEffect = isCopy ? 'copy' : 'move';
      setDragState(prev => prev ? { ...prev, dropTargetPath: node.path, isCopy } : null);

      // Expand collapsed directory after 500ms hover during drag
      if (!node.isExpanded) {
        if (expandHoverTimerRef.current?.path !== node.path) {
          if (expandHoverTimerRef.current) {
            clearTimeout(expandHoverTimerRef.current.timer);
          }
          expandHoverTimerRef.current = {
            path: node.path,
            timer: setTimeout(() => {
              toggleDirectory(node.path);
              expandHoverTimerRef.current = null;
            }, 500),
          };
        }
      }
    } else {
      e.dataTransfer.dropEffect = 'none';
      // Clear expand timer when not over a valid target
      if (expandHoverTimerRef.current) {
        clearTimeout(expandHoverTimerRef.current.timer);
        expandHoverTimerRef.current = null;
      }
    }
  }, [dragState, setDragState, toggleDirectory]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (!e.currentTarget.contains(relatedTarget)) {
      setDragState(prev => prev ? { ...prev, dropTargetPath: null } : null);
    }
  }, [setDragState]);

  const handleDrop = useCallback(async (e: React.DragEvent, node: FlatTreeNode) => {
    e.preventDefault();
    e.stopPropagation();

    // Clear expand-on-hover timer
    if (expandHoverTimerRef.current) {
      clearTimeout(expandHoverTimerRef.current.timer);
      expandHoverTimerRef.current = null;
    }

    // Handle external files from Finder/desktop
    // Electron File objects have a .path property with the absolute file system path
    const externalFiles = Array.from(e.dataTransfer.files) as Array<File & { path: string }>;
    if (externalFiles.length > 0 && node.type === 'directory') {
      try {
        for (const file of externalFiles) {
          if (!file.path) continue;
          const result = await window.electronAPI.copyFile(file.path, node.path);
          if (!result.success) {
            console.error('Failed to copy external file:', file.path, result.error);
          }
        }
        onRefreshFileTree?.();
      } catch (error) {
        console.error('Error copying external files:', error);
      } finally {
        setDragState(null);
      }
      return;
    }

    if (!dragState || node.type !== 'directory') {
      setDragState(null);
      return;
    }

    const isCopy = e.altKey || e.metaKey;
    const sourcePath = dragState.sourcePaths[0];
    if (!sourcePath || sourcePath === node.path) {
      setDragState(null);
      return;
    }

    try {
      if (isCopy) {
        const result = await window.electronAPI.copyFile(sourcePath, node.path);
        if (!result.success) {
          console.error('Failed to copy file:', result.error);
        } else {
          onRefreshFileTree?.();
        }
      } else {
        const result = await window.electronAPI.moveFile(sourcePath, node.path);
        if (!result.success) {
          console.error('Failed to move file:', result.error);
        } else {
          onRefreshFileTree?.();
        }
      }
    } catch (error) {
      console.error('Error during drag and drop:', error);
    } finally {
      setDragState(null);
    }
  }, [dragState, setDragState, onRefreshFileTree]);

  // Update drag copy state based on keyboard modifiers
  useEffect(() => {
    const handleKeyChange = (e: KeyboardEvent) => {
      if (dragState) {
        setDragState(prev => prev ? { ...prev, isCopy: e.altKey || e.metaKey } : null);
      }
    };

    window.addEventListener('keydown', handleKeyChange);
    window.addEventListener('keyup', handleKeyChange);

    return () => {
      window.removeEventListener('keydown', handleKeyChange);
      window.removeEventListener('keyup', handleKeyChange);
    };
  }, [dragState, setDragState]);

  // == Keep focused row visible when navigating via keyboard ==
  // Only scrolls if the item is outside the visible viewport.
  useEffect(() => {
    if (focusedIndex == null || !keyboardFocusRef.current || !containerRef.current) {
      keyboardFocusRef.current = false;
      return;
    }
    keyboardFocusRef.current = false;

    // Check if already visible by looking at scroll position vs item position
    const scrollEl = containerRef.current.querySelector('[data-testid="virtuoso-scroller"]')
      ?? containerRef.current.firstElementChild;
    if (!scrollEl) {
      virtuosoRef.current?.scrollToIndex({ index: focusedIndex, align: 'center' });
      return;
    }

    const scrollTop = scrollEl.scrollTop;
    const viewportHeight = scrollEl.clientHeight;
    const itemTop = focusedIndex * ROW_HEIGHT;
    const itemBottom = itemTop + ROW_HEIGHT;

    if (itemTop < scrollTop) {
      // Item is above viewport -- scroll up so it's at the top
      virtuosoRef.current?.scrollToIndex({ index: focusedIndex, align: 'start' });
    } else if (itemBottom > scrollTop + viewportHeight) {
      // Item is below viewport -- scroll down so it's at the bottom
      virtuosoRef.current?.scrollToIndex({ index: focusedIndex, align: 'end' });
    }
    // Otherwise it's already visible -- don't scroll at all
  }, [focusedIndex]);

  // == Focus persistence: when visibleNodes recomputes, keep same path focused ==
  const prevFocusedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusedIndex != null && visibleNodes[focusedIndex]) {
      prevFocusedPathRef.current = visibleNodes[focusedIndex].path;
    }
  }, [focusedIndex, visibleNodes]);

  useEffect(() => {
    if (focusedIndex == null || !prevFocusedPathRef.current) return;
    const currentNode = visibleNodes[focusedIndex];
    if (currentNode && currentNode.path === prevFocusedPathRef.current) return;
    // Path moved -- find its new index
    const newIndex = visibleNodes.findIndex(n => n.path === prevFocusedPathRef.current);
    if (newIndex >= 0 && newIndex !== focusedIndex) {
      setFocusedIndex(newIndex);
    } else if (newIndex === -1 && focusedIndex >= visibleNodes.length) {
      // Clamp if out of bounds
      setFocusedIndex(Math.max(0, visibleNodes.length - 1));
    }
  }, [visibleNodes, focusedIndex, setFocusedIndex]);

  // == Type-ahead find ==
  const handleTypeAhead = useCallback((char: string) => {
    if (typeAheadTimerRef.current) {
      clearTimeout(typeAheadTimerRef.current);
    }
    typeAheadBufferRef.current += char.toLowerCase();

    typeAheadTimerRef.current = setTimeout(() => {
      typeAheadBufferRef.current = '';
    }, 500);

    const query = typeAheadBufferRef.current;
    const startIndex = focusedIndex != null ? focusedIndex + 1 : 0;

    // Search from after current focus, then wrap around
    for (let i = 0; i < visibleNodes.length; i++) {
      const idx = (startIndex + i) % visibleNodes.length;
      if (visibleNodes[idx].name.toLowerCase().startsWith(query)) {
        setFocusedIndex(idx);
        return;
      }
    }
  }, [focusedIndex, visibleNodes, setFocusedIndex]);

  // == Inline rename ==
  const handleStartRename = useCallback((path: string) => {
    setRenamingPath(path);
  }, []);

  const handleRenameConfirm = useCallback(async (path: string, newName: string) => {
    setRenamingPath(null);
    const result = await window.electronAPI.renameFile(path, newName);
    if (!result.success) {
      console.error('Failed to rename file:', result.error);
    }
  }, []);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // == Keyboard handler ==
  const getViewportRowCount = useCallback(() => {
    if (!containerRef.current) return 20;
    return Math.floor(containerRef.current.clientHeight / ROW_HEIGHT);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't handle keyboard when renaming
    if (renamingPath) return;

    const actions: TreeActions = {
      setFocused: (idx) => {
        keyboardFocusRef.current = true;
        setFocusedIndex(idx);
      },
      expand: (path) => {
        setExpandedDirs(prev => {
          const next = new Set(prev);
          next.add(path);
          if (window.electronAPI?.refreshFolderContents) {
            window.electronAPI.refreshFolderContents(path).then((contents) => {
              if (onFolderContentsLoaded) {
                onFolderContentsLoaded(path, Array.isArray(contents) ? contents : []);
              } else if (onRefreshFileTree) {
                onRefreshFileTree();
              }
            }).catch(console.error);
          }
          return next;
        });
      },
      collapse: (path) => {
        setExpandedDirs(prev => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      },
      toggleExpand: (path) => toggleDirectory(path),
      openFile: (path) => {
        onFolderSelect?.(null);
        onFileSelect(path);
      },
      startRename: handleStartRename,
      deleteItems: async (paths) => {
        if (paths.length === 0) return;

        // Show confirmation before deleting (matches context menu behavior)
        const confirmMessage = paths.length > 1
          ? `Are you sure you want to delete ${paths.length} items?`
          : `Are you sure you want to delete "${paths[paths.length - 1].split('/').pop()}"?`;

        if (!window.confirm(confirmMessage)) return;

        for (const path of paths) {
          const result = await window.electronAPI.deleteFile(path);
          if (!result.success) {
            console.error('Failed to delete file:', path, result.error);
          }
        }
        setSelectedPaths(new Set());
      },
      selectAll: () => {
        setSelectedPaths(new Set(visibleNodes.map(n => n.path)));
      },
      clearSelection: () => {
        setSelectedPaths(new Set());
      },
      extendSelection: (toIndex) => {
        if (toIndex < 0 || toIndex >= visibleNodes.length) return;
        const targetPath = visibleNodes[toIndex]?.path;
        if (targetPath) {
          setSelectedPaths(prev => {
            const next = new Set(prev);
            next.add(targetPath);
            return next;
          });
        }
      },
      typeAhead: handleTypeAhead,
      viewportRowCount: getViewportRowCount(),
    };

    handleTreeKeyDown(e, visibleNodes, focusedIndex, selectedPaths, actions);
  }, [
    renamingPath, visibleNodes, focusedIndex, selectedPaths,
    setFocusedIndex, setExpandedDirs, toggleDirectory, onFileSelect,
    onFolderSelect, onFolderContentsLoaded, onRefreshFileTree,
    handleStartRename, handleTypeAhead, getViewportRowCount,
    setSelectedPaths,
  ]);

  // == Auto-scroll during drag (rAF loop) ==
  useEffect(() => {
    // Only run the loop when dragging
    if (!dragState) {
      autoScrollSpeedRef.current = 0;
      return;
    }

    const tick = () => {
      if (autoScrollSpeedRef.current !== 0) {
        virtuosoRef.current?.scrollBy({ top: autoScrollSpeedRef.current });
      }
      autoScrollFrameRef.current = requestAnimationFrame(tick);
    };
    autoScrollFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (autoScrollFrameRef.current != null) {
        cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = null;
      }
    };
  }, [dragState]);

  // Container-level drag over handler for auto-scroll zones
  const handleContainerDragOver = useCallback((e: React.DragEvent) => {
    if (!containerRef.current || !dragState) return;

    const rect = containerRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const EDGE_ZONE = 40;

    if (y < EDGE_ZONE) {
      autoScrollSpeedRef.current = -(1 - y / EDGE_ZONE) * 8;
    } else if (y > rect.height - EDGE_ZONE) {
      autoScrollSpeedRef.current = (1 - (rect.height - y) / EDGE_ZONE) * 8;
    } else {
      autoScrollSpeedRef.current = 0;
    }
  }, [dragState]);

  const handleContainerDragLeave = useCallback(() => {
    autoScrollSpeedRef.current = 0;
  }, []);

  // == Track user interactions for auto-scroll suppression ==
  const handleContainerInteraction = useCallback(() => {
    lastUserInteractionRef.current = Date.now();
    // Cancel any pending auto-scroll so interacting with the tree
    // (clicking, scrolling) never jumps the viewport away.
    pendingScrollPathRef.current = null;
  }, []);

  // == Row renderer ==
  const itemContent = useCallback((index: number) => {
    const node = visibleNodes[index];
    if (!node) return null;

    return (
      <FileTreeRow
        node={node}
        showIcons={showIcons}
        isFocused={index === focusedIndex}
        isRenaming={node.path === renamingPath}
        isDragSource={dragState?.sourcePaths.includes(node.path) ?? false}
        isCopyDrag={dragState?.isCopy ?? false}
        onClick={(e) => {
          setFocusedIndex(index);
          handleRowClick(e, node);
        }}
        onContextMenu={(e) => handleContextMenu(e, node)}
        onDragStart={(e) => handleDragStart(e, node)}
        onDragEnd={handleDragEnd}
        onDragOver={node.type === 'directory' ? (e) => handleDragOver(e, node) : undefined}
        onDragLeave={node.type === 'directory' ? handleDragLeave : undefined}
        onDrop={node.type === 'directory' ? (e) => handleDrop(e, node) : undefined}
        onRenameConfirm={handleRenameConfirm}
        onRenameCancel={handleRenameCancel}
      />
    );
  }, [visibleNodes, showIcons, focusedIndex, renamingPath, dragState, handleRowClick, handleContextMenu, handleDragStart, handleDragEnd, handleDragOver, handleDragLeave, handleDrop, handleRenameConfirm, handleRenameCancel, setFocusedIndex]);

  return (
    <>
      <div
        ref={containerRef}
        className="file-tree-container"
        role="tree"
        aria-label="File Explorer"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onClick={handleContainerInteraction}
        onScroll={handleContainerInteraction}
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
      >
        <Virtuoso
          ref={virtuosoRef}
          totalCount={visibleNodes.length}
          fixedItemHeight={28}
          itemContent={itemContent}
          overscan={200}
        />
      </div>
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          filePath={contextMenu.filePath}
          fileName={contextMenu.fileName}
          fileType={contextMenu.fileType}
          onClose={() => setContextMenu(null)}
          onRename={handleRename}
          onDelete={handleDelete}
          onDeleteMultiple={handleDeleteMultiple}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
          onViewWorkspaceHistory={onViewWorkspaceHistory}
          selectedPaths={selectedPaths}
          extensionFileTypes={extensionFileTypes}
        />
      )}
    </>
  );
}
