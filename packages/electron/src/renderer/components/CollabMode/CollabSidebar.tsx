import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { usePostHog } from 'posthog-js/react';
import { useAtom, useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { InputModal } from '../InputModal';
import { WorkspaceSummaryHeader } from '../WorkspaceSummaryHeader';
import { CollabCreateItemDialog } from './CollabCreateItemDialog';
import {
  buildSharedNewDocumentMenuItems,
  CollabNewDocumentMenu,
} from './CollabNewDocumentMenu';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../../hooks/useFloatingMenu';
import {
  sharedDocumentsAtom,
  allSharedDocumentsAtom,
  sharedFoldersAtom,
  teamSyncStatusAtom,
  trashSharedDocument,
  updateSharedDocumentTitle,
  moveSharedDocument,
  createSharedFolder,
  renameSharedFolder,
  renameLegacyCollabFolder,
  moveSharedFolder,
  removeSharedFolder,
  collectFolderSubtree,
  activeTeamOrgIdAtom,
  workspaceHasTeamAtom,
  buildSharedDocumentDeepLink,
  buildSharedFolderDeepLink,
  pendingCollabFolderAtom,
  type SharedDocument,
  type SharedFolder,
} from '../../store/atoms/collabDocuments';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import {
  buildCollabTreeAdaptive,
  filterCollabTree,
  pruneEmptyFolders,
  getCollabDocumentPath,
  getCollabNodeName,
  getCollabParentPath,
  joinCollabPath,
  normalizeCollabPath,
  resolveCollabCreateTargetFolderId,
  type CollabTreeNode,
} from './collabTree';
import { useCollabLocalOrigin } from '../../hooks/useCollabLocalOrigin';
import { useSetAtom } from 'jotai';
import { historyDialogFileAtom } from '../../store/atoms/historyDialog';
import { buildCollabUri } from '../../utils/collabUri';
import { DocUnreadDot } from './DocUnreadDot';
import { useDocUnread, markDocViewed } from '../../hooks/useDocUnread';
import {
  collabTreeFilterAtom,
  showUnreadBubblesAtom,
  collabFavoritesAtom,
  changedDocIdsAtom,
  toggleFavoriteDoc,
  markAllSharedDocsViewed,
  type CollabTreeFilter,
} from '../../store/atoms/collabDiscovery';
import {
  getCollaborativeDocumentTypeCatalog,
  type CollaborativeDocumentTypeDescriptor,
} from '../../services/CollaborativeDocumentTypeCatalog';
import { resolveSharedDocumentTypePresentation } from '../../utils/sharedDocumentTypeMetadata';
import { createCollaborativeDocument } from '../../services/collaborativeDocumentCreationOrchestrator';

// ---------------------------------------------------------------------------
// TeamSync status indicator -- shown in the header subtitle slot
// ---------------------------------------------------------------------------

type TeamSyncStatus = 'disconnected' | 'connecting' | 'syncing' | 'connected' | 'error';

const STATUS_CONFIG: Record<TeamSyncStatus, { label: string; dotClass: string }> = {
  connected:    { label: 'Team synced',   dotClass: 'bg-green-500' },
  syncing:      { label: 'Syncing...',    dotClass: 'bg-blue-500 animate-pulse' },
  connecting:   { label: 'Connecting...', dotClass: 'bg-yellow-500 animate-pulse' },
  disconnected: { label: 'Disconnected',  dotClass: 'bg-gray-500' },
  error:        { label: 'Sync error',    dotClass: 'bg-red-500' },
};

const TeamSyncStatusLabel: React.FC<{ status: TeamSyncStatus }> = ({ status }) => {
  const { label, dotClass } = STATUS_CONFIG[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      <span>{label}</span>
    </span>
  );
};

interface CollabSidebarProps {
  workspacePath: string;
  onDocumentSelect: (doc: SharedDocument) => void;
  activeDocumentId?: string | null;
  /** Open the discovery hub (center pane). Shown as a Home action. */
  onShowHome?: () => void;
  /** Highlight the Home action when the hub is the active surface. */
  homeActive?: boolean;
}

export const CollabSidebar: React.FC<CollabSidebarProps> = ({
  workspacePath,
  onDocumentSelect,
  activeDocumentId,
  onShowHome,
  homeActive,
}) => {
  const documentTypeCatalog = getCollaborativeDocumentTypeCatalog();
  const catalogRevision = useSyncExternalStore(
    documentTypeCatalog.subscribe,
    documentTypeCatalog.getSnapshot,
    documentTypeCatalog.getSnapshot,
  );
  const posthog = usePostHog();
  const sharedDocuments = useAtomValue(sharedDocumentsAtom);
  const allSharedDocuments = useAtomValue(allSharedDocumentsAtom);
  const sharedFolders = useAtomValue(sharedFoldersAtom);
  const teamSyncStatus = useAtomValue(teamSyncStatusAtom);
  const teamOrgId = useAtomValue(activeTeamOrgIdAtom);
  const workspaceHasTeam = useAtomValue(workspaceHasTeamAtom);

  // Discovery: favorites, tree filter, and unread-bubble visibility.
  const [treeFilter, setTreeFilter] = useAtom(collabTreeFilterAtom);
  const [showUnreadBubbles, setShowUnreadBubbles] = useAtom(showUnreadBubblesAtom);
  const favorites = useAtomValue(collabFavoritesAtom);
  const changedDocIds = useAtomValue(changedDocIdsAtom);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const [overflowOpen, setOverflowOpen] = useState(false);

  // Drive the per-doc "unread" dots from the local read-receipt store.
  useDocUnread();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: CollabTreeNode;
  } | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  // First-class folders: the folderId a create/rename/move should target. Kept
  // alongside selectedFolderPath (the display/expansion key) since folder ops
  // key off the stable id, not the derived breadcrumb path.
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [folderToRename, setFolderToRename] = useState<SharedFolder | null>(null);
  // Legacy (path-in-title) folder rename target: these folders have no
  // first-class folderId, so the rename rewrites descendant document titles.
  const [legacyFolderToRename, setLegacyFolderToRename] = useState<{ path: string; name: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [createDocumentDescriptor, setCreateDocumentDescriptor] = useState<CollaborativeDocumentTypeDescriptor | null>(null);
  const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
  const [createTargetFolderId, setCreateTargetFolderId] = useState<string | null>(null);
  const [documentToRename, setDocumentToRename] = useState<SharedDocument | null>(null);
  const [hasLoadedState, setHasLoadedState] = useState(false);
  const [loadedWorkspacePath, setLoadedWorkspacePath] = useState<string | null>(null);
  const setHistoryDialogFile = useSetAtom(historyDialogFileAtom);
  const [pendingCollabFolder, setPendingCollabFolder] = useAtom(pendingCollabFolderAtom);
  const [draggedDocument, setDraggedDocument] = useState<{
    documentId: string;
    sourcePath: string;
    name: string;
  } | null>(null);
  const [draggedFolder, setDraggedFolder] = useState<{
    folderId: string;
    name: string;
  } | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  // Track whether the user has manually customized the expansion set since
  // the initial workspace state load. Until they do, we auto-expand folders
  // that contain shared docs so newly synced content isn't hidden behind
  // collapsed parents the user has never opened.
  const [userTouchedExpansion, setUserTouchedExpansion] = useState(false);

  // Full tree (all docs + first-class folders) — used for path-collision checks
  // and auto-expand, independent of the active filter.
  const tree = useMemo(
    () => buildCollabTreeAdaptive(sharedDocuments, sharedFolders),
    [sharedDocuments, sharedFolders]
  );

  // Docs visible under the active segmented filter (All / Favorites / Updated).
  const visibleDocuments = useMemo(() => {
    if (treeFilter === 'favorites') {
      return sharedDocuments.filter((d) => favoriteSet.has(d.documentId));
    }
    if (treeFilter === 'updated') {
      return sharedDocuments.filter((d) => changedDocIds.has(d.documentId));
    }
    return sharedDocuments;
  }, [sharedDocuments, treeFilter, favoriteSet, changedDocIds]);

  // Rendered tree — filtered docs; drop empty folders in filtered views so the
  // Favorites/Updated segments show only folders that still contain a match.
  const displayTree = useMemo(
    () => {
      const built = buildCollabTreeAdaptive(visibleDocuments, sharedFolders);
      return treeFilter === 'all' ? built : pruneEmptyFolders(built);
    },
    [visibleDocuments, sharedFolders, treeFilter]
  );
  const trimmedSearchQuery = searchQuery.trim();
  const hasActiveSearch = trimmedSearchQuery.length > 0;
  const filteredTree = useMemo(
    () => filterCollabTree(displayTree, trimmedSearchQuery),
    [displayTree, trimmedSearchQuery]
  );

  const existingPaths = useMemo(() => {
    const paths = new Set<string>();

    const collect = (nodes: CollabTreeNode[]) => {
      for (const node of nodes) {
        paths.add(node.path);
        if (node.type === 'folder') {
          collect(node.children);
        }
      }
    };

    collect(tree);
    return paths;
  }, [tree]);

  const activeDocument = useMemo(
    () => sharedDocuments.find(document => document.documentId === activeDocumentId) ?? null,
    [activeDocumentId, sharedDocuments]
  );

  const folderById = useMemo(
    () => new Map(sharedFolders.map(f => [f.folderId, f])),
    [sharedFolders]
  );

  // Derive each folder's breadcrumb path (used for dual-write titles so
  // un-upgraded clients still render the tree from the path-in-title).
  const folderPathById = useMemo(() => {
    const paths = new Map<string, string>();
    const resolve = (folderId: string, guard: Set<string>): string => {
      const cached = paths.get(folderId);
      if (cached !== undefined) return cached;
      const folder = folderById.get(folderId);
      if (!folder || guard.has(folderId)) return '';
      guard.add(folderId);
      const parentPath = folder.parentFolderId ? resolve(folder.parentFolderId, guard) : '';
      const path = joinCollabPath(parentPath, folder.name);
      paths.set(folderId, path);
      return path;
    };
    for (const f of sharedFolders) resolve(f.folderId, new Set());
    return paths;
  }, [sharedFolders, folderById]);

  const canMutateMetadata = useCallback((actionLabel: string) => {
    if (teamSyncStatus === 'connected') {
      return true;
    }

    window.alert(
      `Cannot ${actionLabel} while shared document sync is ${teamSyncStatus}. Reconnect to the team before changing shared document metadata.`
    );
    return false;
  }, [teamSyncStatus]);

  const contextMenuReference = useMemo(
    () => (contextMenu ? virtualElement(contextMenu.x, contextMenu.y) : null),
    [contextMenu]
  );
  const contextMenuFloating = useFloatingMenu({
    placement: 'right-start',
    reference: contextMenuReference,
    open: contextMenu !== null,
    onOpenChange: (open) => {
      if (!open) setContextMenu(null);
    },
  });

  const overflowMenu = useFloatingMenu({
    placement: 'bottom-end',
    open: overflowOpen,
    onOpenChange: setOverflowOpen,
  });
  const newDocumentMenu = useFloatingMenu({
    placement: 'bottom-start',
  });
  const sharedNewDocumentMenuItems = useMemo(
    () => buildSharedNewDocumentMenuItems(documentTypeCatalog.getDescriptors()),
    [catalogRevision, documentTypeCatalog],
  );

  const handleMarkAllRead = useCallback(() => {
    setOverflowOpen(false);
    if (teamOrgId) {
      void markAllSharedDocsViewed(teamOrgId);
    }
  }, [teamOrgId]);

  const handleToggleFavorite = useCallback((document: SharedDocument) => {
    toggleFavoriteDoc(document.documentId);
  }, []);

  const handleMarkDocRead = useCallback((document: SharedDocument) => {
    if (!teamOrgId) return;
    void markDocViewed(document.documentId, teamOrgId, document.updatedAt ?? null);
  }, [teamOrgId]);

  useEffect(() => {
    setHasLoadedState(false);
    setLoadedWorkspacePath(null);
    setContextMenu(null);
    setDocumentToRename(null);
    setFolderToRename(null);
    setLegacyFolderToRename(null);
    setSelectedFolderPath(null);
    setSelectedFolderId(null);
    setSearchQuery('');
    setExpandedFolders(new Set());
    setUserTouchedExpansion(false);

    if (!workspacePath || !window.electronAPI?.invoke) {
      setHasLoadedState(true);
      return;
    }

    let cancelled = false;
    window.electronAPI.invoke('workspace:get-state', workspacePath)
      .then((state) => {
        if (cancelled) return;

        const nextExpanded = Array.isArray(state?.collabTree?.expandedFolders)
          ? state.collabTree.expandedFolders.map((folder: string) => normalizeCollabPath(folder)).filter(Boolean)
          : [];

        setExpandedFolders(new Set(nextExpanded));
        // Treat persisted tree state as a user customization so we don't
        // override the user's collapse decisions with the auto-expand fallback.
        setUserTouchedExpansion(
          state?.collabTree?.userTouched === true || nextExpanded.length > 0
        );
        setHasLoadedState(true);
        setLoadedWorkspacePath(workspacePath);
      })
      .catch(() => {
        if (cancelled) return;
        setHasLoadedState(true);
        setLoadedWorkspacePath(workspacePath);
      });

    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  useEffect(() => {
    if (!hasLoadedState || loadedWorkspacePath !== workspacePath || !workspacePath || !window.electronAPI?.invoke) return;

    const payload = {
      collabTree: {
        expandedFolders: Array.from(expandedFolders),
        userTouched: userTouchedExpansion,
      },
    };

    window.electronAPI.invoke('workspace:update-state', workspacePath, payload).catch((error) => {
      console.warn('[CollabSidebar] Failed to persist tree state:', error);
    });
  }, [expandedFolders, hasLoadedState, loadedWorkspacePath, userTouchedExpansion, workspacePath]);

  useEffect(() => {
    if (!activeDocument) return;
    const path = getCollabDocumentPath(activeDocument);
    const parents: string[] = [];
    let current = getCollabParentPath(path);
    while (current) {
      parents.unshift(current);
      current = getCollabParentPath(current);
    }

    if (parents.length === 0) return;

    setExpandedFolders((currentFolders) => {
      const next = new Set(currentFolders);
      let changed = false;
      for (const folderPath of parents) {
        if (!next.has(folderPath)) {
          next.add(folderPath);
          changed = true;
        }
      }
      return changed ? next : currentFolders;
    });
  }, [activeDocument]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: CollabTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    if (node.type === 'folder') {
      setSelectedFolderPath(node.path);
      setSelectedFolderId(node.folderId ?? null);
    }
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const handleCopyLink = useCallback(async (document: SharedDocument) => {
    if (!teamOrgId) {
      errorNotificationService.showWarning(
        'No team configured',
        'This workspace is not connected to a team, so no shareable link is available.',
        { duration: 4000 }
      );
      return;
    }
    const url = buildSharedDocumentDeepLink(document.documentId, teamOrgId);
    try {
      await navigator.clipboard.writeText(url);
      errorNotificationService.showInfo(
        'Link copied',
        'Paste it anywhere to open this document in Nimbalyst.',
        { duration: 3000 }
      );
    } catch (err) {
      console.error('[CollabSidebar] Failed to copy link:', err);
      errorNotificationService.showError(
        'Copy failed',
        'Could not write the link to the clipboard.'
      );
    }
  }, [teamOrgId]);

  const handleDelete = useCallback(() => {
    if (!contextMenu) return;

    if (contextMenu.node.type === 'document') {
      if (!canMutateMetadata('move this document to Trash')) return;
      const { document } = contextMenu.node;
      trashSharedDocument(document.documentId);
      setContextMenu(null);
      return;
    }

    // Folder: recursive delete with a descendant-count confirmation.
    const folderId = contextMenu.node.folderId;
    if (!folderId) { setContextMenu(null); return; }
    if (!canMutateMetadata('delete this folder')) return;

    const subtreeFolderIds = new Set(collectFolderSubtree(sharedFolders, folderId));
    const folderCount = subtreeFolderIds.size - 1; // exclude the folder itself
    const docCount = allSharedDocuments.filter(
      d => d.parentFolderId && subtreeFolderIds.has(d.parentFolderId)
    ).length;

    const parts: string[] = [];
    if (docCount > 0) parts.push(`${docCount} document${docCount === 1 ? '' : 's'}`);
    if (folderCount > 0) parts.push(`${folderCount} subfolder${folderCount === 1 ? '' : 's'}`);
    const detail = parts.length > 0 ? ` and its ${parts.join(' and ')}` : '';
    if (window.confirm(`Delete shared folder "${contextMenu.node.name}"${detail}? This cannot be undone.`)) {
      removeSharedFolder(folderId);
      posthog?.capture('collab_folder_deleted', { documentCount: docCount, subfolderCount: folderCount });
      if (selectedFolderId === folderId) {
        setSelectedFolderId(null);
        setSelectedFolderPath(null);
      }
    }
    setContextMenu(null);
  }, [canMutateMetadata, contextMenu, sharedFolders, allSharedDocuments, selectedFolderId, posthog]);

  const handleCopyFolderLink = useCallback(async (folderId: string) => {
    if (!teamOrgId) {
      errorNotificationService.showWarning(
        'No team configured',
        'This workspace is not connected to a team, so no shareable link is available.',
        { duration: 4000 }
      );
      return;
    }
    const url = buildSharedFolderDeepLink(folderId, teamOrgId);
    try {
      await navigator.clipboard.writeText(url);
      posthog?.capture('collab_folder_link_copied');
      errorNotificationService.showInfo(
        'Folder link copied',
        'Paste it anywhere to open this folder in Nimbalyst.',
        { duration: 3000 }
      );
    } catch (err) {
      console.error('[CollabSidebar] Failed to copy folder link:', err);
      errorNotificationService.showError('Copy failed', 'Could not write the link to the clipboard.');
    }
  }, [teamOrgId]);

  const handleRenameFolder = useCallback(async (nextName: string) => {
    if (!folderToRename) return;
    if (!canMutateMetadata('rename this folder')) return;
    const name = nextName.trim();
    if (!name || name === folderToRename.name) {
      setFolderToRename(null);
      setContextMenu(null);
      return;
    }
    await renameSharedFolder(folderToRename.folderId, name);
    posthog?.capture('collab_folder_renamed');
    setFolderToRename(null);
    setContextMenu(null);
  }, [canMutateMetadata, folderToRename, posthog]);

  const handleRenameLegacyFolder = useCallback(async (nextName: string) => {
    if (!legacyFolderToRename) return;
    if (!canMutateMetadata('rename this folder')) return;
    const name = nextName.trim();
    if (!name || name === legacyFolderToRename.name) {
      setLegacyFolderToRename(null);
      setContextMenu(null);
      return;
    }
    await renameLegacyCollabFolder(legacyFolderToRename.path, name);
    posthog?.capture('collab_folder_renamed', { legacy: true });
    setLegacyFolderToRename(null);
    setContextMenu(null);
  }, [canMutateMetadata, legacyFolderToRename, posthog]);

  const toggleFolder = useCallback((folderPath: string) => {
    setUserTouchedExpansion(true);
    setExpandedFolders((currentFolders) => {
      const next = new Set(currentFolders);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  }, []);

  // Auto-expand any folder that contains a shared document on initial load,
  // so a fresh visit to Collab mode doesn't hide docs behind collapsed
  // parents. Only applies until the user manually toggles a folder, at
  // which point persisted expansion state takes over.
  useEffect(() => {
    if (!hasLoadedState || loadedWorkspacePath !== workspacePath) return;
    if (userTouchedExpansion) return;
    if (sharedDocuments.length === 0) return;

    const docFolderPaths = new Set<string>();
    for (const document of sharedDocuments) {
      const path = getCollabDocumentPath(document);
      let parent = getCollabParentPath(path);
      while (parent) {
        docFolderPaths.add(parent);
        parent = getCollabParentPath(parent);
      }
    }
    if (docFolderPaths.size === 0) return;

    setExpandedFolders((currentFolders) => {
      let changed = false;
      const next = new Set(currentFolders);
      for (const folderPath of docFolderPaths) {
        if (!next.has(folderPath)) {
          next.add(folderPath);
          changed = true;
        }
      }
      return changed ? next : currentFolders;
    });
  }, [hasLoadedState, loadedWorkspacePath, workspacePath, sharedDocuments, userTouchedExpansion]);

  // The folderId a create action should nest under (null = root): the
  // right-clicked folder, else the currently selected folder.
  // Folder deep link (nimbalyst://folder/...): once the target folder has
  // synced, expand its ancestor chain and select it, then clear the signal.
  useEffect(() => {
    if (!pendingCollabFolder) return;
    const target = folderById.get(pendingCollabFolder.folderId);
    if (!target) return; // wait for the folder to arrive via sync

    const ancestorPaths: string[] = [];
    const guard = new Set<string>();
    let current: SharedFolder | undefined = target;
    while (current && !guard.has(current.folderId)) {
      guard.add(current.folderId);
      const p = folderPathById.get(current.folderId);
      if (p) ancestorPaths.push(p);
      current = current.parentFolderId ? folderById.get(current.parentFolderId) : undefined;
    }

    setExpandedFolders((currentFolders) => {
      const next = new Set(currentFolders);
      for (const p of ancestorPaths) next.add(p);
      return next;
    });
    setUserTouchedExpansion(true);
    setSelectedFolderId(target.folderId);
    setSelectedFolderPath(folderPathById.get(target.folderId) ?? null);
    setPendingCollabFolder(null);
  }, [pendingCollabFolder, folderById, folderPathById, setPendingCollabFolder]);

  const getCreationBaseFolderId = useCallback((): string | null => {
    const contextFolderId = contextMenu?.node.type === 'folder'
      ? (contextMenu.node.folderId ?? null)
      : undefined;
    return resolveCollabCreateTargetFolderId(contextFolderId, selectedFolderId);
  }, [contextMenu, selectedFolderId]);

  const openCreateFolderDialog = useCallback(() => {
    setCreateTargetFolderId(getCreationBaseFolderId());
    setIsCreateFolderOpen(true);
    setContextMenu(null);
  }, [getCreationBaseFolderId]);

  const openCreateDocumentMenu = useCallback((reference: HTMLElement) => {
    setCreateTargetFolderId(getCreationBaseFolderId());
    const rect = reference.getBoundingClientRect();
    newDocumentMenu.refs.setPositionReference(virtualElement(rect.left, rect.bottom));
    newDocumentMenu.setIsOpen(true);
    setContextMenu(null);
  }, [getCreationBaseFolderId, newDocumentMenu.refs, newDocumentMenu.setIsOpen]);

  const selectCreateDocumentType = useCallback((descriptor: CollaborativeDocumentTypeDescriptor) => {
    if (!descriptor.capabilities.sharedCreate) return;
    newDocumentMenu.setIsOpen(false);
    setCreateDocumentDescriptor(descriptor);
  }, [newDocumentMenu.setIsOpen]);

  const handleCreateFolder = useCallback(async (folderName: string) => {
    if (!canMutateMetadata('create folders')) return;
    const name = folderName.trim();
    if (!name) return;

    const parentId = createTargetFolderId;
    const parentPath = parentId ? (folderPathById.get(parentId) ?? '') : '';
    const nextPath = joinCollabPath(parentPath, name);
    if (existingPaths.has(nextPath)) {
      window.alert(`A document or folder named "${nextPath}" already exists.`);
      return;
    }

    const folderId = await createSharedFolder(name, parentId);
    posthog?.capture('collab_folder_created', { nested: parentId !== null });
    setExpandedFolders((currentFolders) => {
      const next = new Set(currentFolders);
      next.add(nextPath);
      if (parentPath) next.add(parentPath);
      return next;
    });
    setSelectedFolderPath(nextPath);
    setSelectedFolderId(folderId);
    setIsCreateFolderOpen(false);
    setContextMenu(null);
  }, [canMutateMetadata, createTargetFolderId, existingPaths, folderPathById, posthog]);

  const handleCreateDocument = useCallback(async (documentName: string) => {
    if (!canMutateMetadata('create documents')) return;
    const descriptor = createDocumentDescriptor;
    if (!descriptor) return;
    const parentId = createTargetFolderId;
    const parentPath = parentId ? (folderPathById.get(parentId) ?? '') : '';
    try {
      await createCollaborativeDocument({
        descriptor,
        requestedName: documentName,
        parentFolderId: parentId,
        sourceContent: descriptor.creation?.defaultContent ?? '',
      });
    } catch (error) {
      errorNotificationService.showError(
        'Could not create shared document',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    if (parentPath) {
      setExpandedFolders((currentFolders) => {
        const next = new Set(currentFolders);
        next.add(parentPath);
        return next;
      });
    }

    setSelectedFolderPath(parentPath || null);
    setSelectedFolderId(parentId);
    setCreateDocumentDescriptor(null);
    setContextMenu(null);
  }, [canMutateMetadata, createDocumentDescriptor, createTargetFolderId, folderPathById]);

  const handleRenameDocument = useCallback(async (documentName: string) => {
    if (!documentToRename) return;
    if (!canMutateMetadata('rename this document')) return;

    const name = getCollabNodeName(documentName.trim()) || documentName.trim();
    if (!name) { setDocumentToRename(null); setContextMenu(null); return; }

    // Dual-write: rebuild the full-path title from the doc's parent folder so
    // un-upgraded clients keep the doc under the right folder.
    const parentId = documentToRename.parentFolderId ?? null;
    const parentPath = parentId ? (folderPathById.get(parentId) ?? '') : '';
    const nextPath = joinCollabPath(parentPath, name);
    const currentPath = getCollabDocumentPath(documentToRename);
    if (!nextPath || nextPath === currentPath) {
      setDocumentToRename(null);
      setContextMenu(null);
      return;
    }
    if (existingPaths.has(nextPath)) {
      window.alert(`A document or folder named "${nextPath}" already exists.`);
      return;
    }

    await updateSharedDocumentTitle(documentToRename.documentId, nextPath);
    setDocumentToRename(null);
    setContextMenu(null);
  }, [canMutateMetadata, documentToRename, existingPaths, folderPathById]);

  const moveDraggedDocument = useCallback(async (targetFolderId: string | null, targetFolderPath: string | null) => {
    if (!draggedDocument) return;
    if (!canMutateMetadata('move this document')) {
      setDropTargetPath(null);
      setDraggedDocument(null);
      return;
    }

    const nextPath = joinCollabPath(targetFolderPath, draggedDocument.name);
    if (!nextPath || nextPath === draggedDocument.sourcePath) {
      setDropTargetPath(null);
      setDraggedDocument(null);
      return;
    }
    if (existingPaths.has(nextPath) && nextPath !== draggedDocument.sourcePath) {
      window.alert(`A document or folder named "${nextPath}" already exists.`);
      setDropTargetPath(null);
      setDraggedDocument(null);
      return;
    }

    // First-class reparent + dual-write title (single doc → one title write).
    moveSharedDocument(draggedDocument.documentId, targetFolderId);
    await updateSharedDocumentTitle(draggedDocument.documentId, nextPath);

    if (targetFolderPath) {
      setExpandedFolders((currentFolders) => {
        const next = new Set(currentFolders);
        next.add(targetFolderPath);
        return next;
      });
      setSelectedFolderPath(targetFolderPath);
      setSelectedFolderId(targetFolderId);
    } else {
      setSelectedFolderPath(null);
      setSelectedFolderId(null);
    }

    setDropTargetPath(null);
    setDraggedDocument(null);
  }, [canMutateMetadata, draggedDocument, existingPaths]);

  const canDropDocument = useCallback((targetFolderPath: string | null) => {
    if (!draggedDocument) return false;

    const nextPath = joinCollabPath(targetFolderPath, draggedDocument.name);
    if (!nextPath || nextPath === draggedDocument.sourcePath) {
      return false;
    }

    return !existingPaths.has(nextPath) || nextPath === draggedDocument.sourcePath;
  }, [draggedDocument, existingPaths]);

  // Folder reparent by drag. Rejects a drop into the folder's own subtree
  // (mirrors the server cycle guard) and a no-op re-drop onto its own parent.
  const canDropFolder = useCallback((targetFolderId: string | null): boolean => {
    if (!draggedFolder) return false;
    if (targetFolderId === draggedFolder.folderId) return false;
    const dragged = folderById.get(draggedFolder.folderId);
    if (dragged && (dragged.parentFolderId ?? null) === targetFolderId) return false;
    if (targetFolderId) {
      const subtree = new Set(collectFolderSubtree(sharedFolders, draggedFolder.folderId));
      if (subtree.has(targetFolderId)) return false;
    }
    return true;
  }, [draggedFolder, folderById, sharedFolders]);

  const moveDraggedFolder = useCallback((targetFolderId: string | null, targetFolderPath: string | null) => {
    if (!draggedFolder) return;
    if (!canDropFolder(targetFolderId)) {
      setDropTargetPath(null);
      setDraggedFolder(null);
      return;
    }
    if (!canMutateMetadata('move this folder')) {
      setDropTargetPath(null);
      setDraggedFolder(null);
      return;
    }
    moveSharedFolder(draggedFolder.folderId, targetFolderId);
    posthog?.capture('collab_folder_moved', { toRoot: targetFolderId === null });
    if (targetFolderPath) {
      setExpandedFolders((currentFolders) => new Set(currentFolders).add(targetFolderPath));
    }
    setDropTargetPath(null);
    setDraggedFolder(null);
  }, [draggedFolder, canDropFolder, canMutateMetadata, posthog]);

  const renderTree = useCallback((nodes: CollabTreeNode[], depth = 0): React.ReactNode => {
    return nodes.map((node) => {
      const indent = depth * 16 + 8;

      if (node.type === 'folder') {
        const isExpanded = hasActiveSearch || expandedFolders.has(node.path);
        const isSelected = selectedFolderPath === node.path;
        const isDropTarget = dropTargetPath === node.path;

        return (
          <div key={node.id}>
            <button
              className={`w-full flex items-center text-left file-tree-directory${isSelected ? ' selected' : ''}${isDropTarget ? ' drag-over' : ''}`}
              style={{ paddingLeft: indent }}
              draggable={!!node.folderId}
              onDragStart={(event) => {
                if (!node.folderId) return;
                event.stopPropagation();
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', node.folderId);
                setDraggedFolder({ folderId: node.folderId, name: node.name });
              }}
              onDragEnd={() => {
                setDraggedFolder(null);
                setDropTargetPath(null);
              }}
              onClick={() => {
                if (!hasActiveSearch) {
                  toggleFolder(node.path);
                }
                setSelectedFolderPath(node.path);
                setSelectedFolderId(node.folderId ?? null);
              }}
              onContextMenu={(event) => handleContextMenu(event, node)}
              onDragOver={(event) => {
                const accepts = draggedFolder
                  ? canDropFolder(node.folderId ?? null)
                  : canDropDocument(node.path);
                if (!accepts) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                if (dropTargetPath !== node.path) {
                  setDropTargetPath(node.path);
                }
              }}
              onDragLeave={(event) => {
                event.stopPropagation();
                const relatedTarget = event.relatedTarget as Node | null;
                if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
                  return;
                }
                if (dropTargetPath === node.path) {
                  setDropTargetPath(null);
                }
              }}
              onDrop={(event) => {
                if (draggedFolder) {
                  if (!canDropFolder(node.folderId ?? null)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  moveDraggedFolder(node.folderId ?? null, node.path);
                  return;
                }
                if (!canDropDocument(node.path)) return;
                event.preventDefault();
                event.stopPropagation();
                void moveDraggedDocument(node.folderId ?? null, node.path);
              }}
              title={node.path}
            >
              <span className="file-tree-chevron">
                <MaterialSymbol
                  icon={isExpanded ? 'keyboard_arrow_down' : 'keyboard_arrow_right'}
                  size={16}
                />
              </span>
              <span className="file-tree-icon">
                <MaterialSymbol icon={isExpanded ? 'folder_open' : 'folder'} size={18} />
              </span>
              <span className="file-tree-name">{node.name}</span>
            </button>
            {isExpanded ? renderTree(node.children, depth + 1) : null}
          </div>
        );
      }

      const isActive = node.document.documentId === activeDocumentId;
      const isLocked = node.document.decryptFailed === true;

      if (isLocked) {
        const lockedTitle =
          'This document\'s title is encrypted with a key your account does not currently have. ' +
          'Ask a team admin to refresh / rewrap your key envelope, then reopen the workspace.';
        return (
          <button
            key={node.id}
            type="button"
            disabled
            data-testid="collab-sidebar-locked-doc"
            className="w-full flex items-center text-left file-tree-file opacity-60 cursor-not-allowed"
            style={{ paddingLeft: indent }}
            title={lockedTitle}
          >
            <span className="file-tree-spacer" />
            <span className="file-tree-icon">
              <MaterialSymbol icon="lock" size={16} />
            </span>
            <span className="file-tree-name italic text-[var(--nim-text-faint)]">
              Encrypted document (key unavailable)
            </span>
          </button>
        );
      }

      const isFavorite = favoriteSet.has(node.document.documentId);
      const typePresentation = resolveSharedDocumentTypePresentation(
        node.document,
        documentTypeCatalog,
      );

      return (
        <button
          key={node.id}
          className={`group w-full flex items-center text-left file-tree-file${isActive ? ' active' : ''}`}
          style={{ paddingLeft: indent }}
          onClick={() => {
            setSelectedFolderPath(getCollabParentPath(node.path));
            onDocumentSelect(node.document);
          }}
          onContextMenu={(event) => handleContextMenu(event, node)}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', node.document.documentId);
            setDraggedDocument({
              documentId: node.document.documentId,
              sourcePath: node.path,
              name: node.name,
            });
          }}
          onDragEnd={() => {
            setDraggedDocument(null);
            setDropTargetPath(null);
          }}
          title={node.path}
        >
          <span className="file-tree-spacer" />
          <span className="file-tree-icon">
            <MaterialSymbol icon={typePresentation.icon} size={16} />
          </span>
          <span className="file-tree-name">{node.name}</span>
          <span
            role="button"
            tabIndex={-1}
            aria-label={isFavorite ? 'Unfavorite' : 'Favorite'}
            aria-pressed={isFavorite}
            title={isFavorite ? 'Unfavorite' : 'Favorite'}
            className={`collab-fav-star ml-auto mr-0.5 flex items-center justify-center cursor-pointer transition-opacity ${
              isFavorite
                ? 'text-[var(--nim-warning)] opacity-100'
                : 'text-[var(--nim-text-faint)] opacity-0 group-hover:opacity-70 hover:!opacity-100'
            }`}
            onClick={(event) => {
              event.stopPropagation();
              toggleFavoriteDoc(node.document.documentId);
            }}
          >
            <MaterialSymbol icon="star" size={14} fill={isFavorite} />
          </span>
          {showUnreadBubbles && (
            <DocUnreadDot documentId={node.document.documentId} className="mr-1" />
          )}
        </button>
      );
    });
  }, [
    activeDocumentId,
    canDropDocument,
    canDropFolder,
    draggedFolder,
    dropTargetPath,
    expandedFolders,
    handleContextMenu,
    moveDraggedDocument,
    moveDraggedFolder,
    onDocumentSelect,
    selectedFolderPath,
    hasActiveSearch,
    toggleFolder,
    favoriteSet,
    showUnreadBubbles,
    catalogRevision,
    documentTypeCatalog,
  ]);

  const selectedFolderLabel = selectedFolderPath ? getCollabNodeName(selectedFolderPath) : 'Shared Docs';
  const contextDocument = contextMenu?.node.type === 'document' ? contextMenu.node.document : null;
  const contextLocalOrigin = useCollabLocalOrigin(
    workspacePath,
    contextDocument?.documentId,
    contextDocument?.documentType,
  );

  return (
    <div
      className="collab-sidebar w-full h-full flex flex-col bg-nim-secondary border-r border-nim overflow-hidden"
      data-testid="collab-sidebar"
    >
      {/* Header -- matches WorkspaceSummaryHeader used by EditorMode */}
      <WorkspaceSummaryHeader
        workspacePath={workspacePath}
        subtitle={<TeamSyncStatusLabel status={teamSyncStatus} />}
        actionsClassName="gap-1"
        actions={
          <>
            {onShowHome && (
              <button
                type="button"
                className={`workspace-action-button bg-transparent border-none p-1.5 cursor-pointer rounded flex items-center justify-center transition-all duration-200 relative hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] ${
                  homeActive ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-faint)]'
                }`}
                title="Discovery home"
                aria-label="Discovery home"
                onClick={() => {
                  onShowHome();
                  setContextMenu(null);
                }}
              >
                <MaterialSymbol icon="grid_view" size={16} />
              </button>
            )}
            <button
              ref={newDocumentMenu.refs.setReference}
              {...newDocumentMenu.getReferenceProps()}
              type="button"
              className="workspace-action-button bg-transparent border-none p-1.5 cursor-pointer rounded text-[var(--nim-text-faint)] flex items-center justify-center transition-all duration-200 relative hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              title="New document"
              onClick={event => openCreateDocumentMenu(event.currentTarget)}
            >
              <MaterialSymbol icon="note_add" size={16} />
            </button>
            <button
              type="button"
              className="workspace-action-button bg-transparent border-none p-1.5 cursor-pointer rounded text-[var(--nim-text-faint)] flex items-center justify-center transition-all duration-200 relative hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              title="New folder"
              onClick={openCreateFolderDialog}
            >
              <MaterialSymbol icon="create_new_folder" size={16} />
            </button>
            <button
              ref={overflowMenu.refs.setReference}
              {...overflowMenu.getReferenceProps()}
              type="button"
              className="workspace-action-button bg-transparent border-none p-1.5 cursor-pointer rounded text-[var(--nim-text-faint)] flex items-center justify-center transition-all duration-200 relative hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              title="Shared document options"
              aria-label="Shared document options"
              onClick={() => {
                setOverflowOpen((open) => !open);
                setContextMenu(null);
              }}
            >
              <MaterialSymbol icon="more_horiz" size={16} />
            </button>
          </>
        }
      />

      {/* Segmented filter: All / Favorites / Updated */}
      <div className="collab-tree-filter px-3 py-2 border-b border-[var(--nim-border)] shrink-0">
        <div className="flex bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md p-0.5">
          {([
            { key: 'all', label: 'All', icon: null },
            { key: 'favorites', label: 'Favorites', icon: 'star' },
            { key: 'updated', label: 'Updated', icon: 'circle' },
          ] as { key: CollabTreeFilter; label: string; icon: string | null }[]).map((seg) => {
            const active = treeFilter === seg.key;
            return (
              <button
                key={seg.key}
                type="button"
                className={`flex-1 flex items-center justify-center gap-1 text-[11.5px] py-1 px-1.5 rounded transition-colors ${
                  active
                    ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)]'
                    : 'text-[var(--nim-text-faint)] hover:text-[var(--nim-text-muted)]'
                }`}
                aria-pressed={active}
                onClick={() => setTreeFilter(seg.key)}
              >
                {seg.icon && (
                  <MaterialSymbol
                    icon={seg.icon}
                    size={13}
                    fill={seg.key === 'favorites' && active}
                    className={active && seg.key !== 'all' ? 'text-[var(--nim-warning)]' : undefined}
                  />
                )}
                {seg.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="session-history-search px-3 py-2 border-b border-[var(--nim-border)] shrink-0 relative">
          <input
            type="text"
            className="session-history-search-input nim-input w-full pl-3 pr-9 py-2 text-[13px] text-[var(--nim-text)] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded outline-none transition-colors duration-150 placeholder:text-[var(--nim-text-faint)] focus:border-[var(--nim-primary)] focus:bg-[var(--nim-bg)]"
            placeholder="Search shared documents..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            aria-label="Search shared documents"
          />
          {hasActiveSearch && (
            <button
              type="button"
              className="session-history-search-clear absolute right-5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded text-[var(--nim-text-muted)] bg-transparent border-none cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              onClick={() => setSearchQuery('')}
              aria-label="Clear shared document search"
              title="Clear search"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          )}
      </div>

      {/* Document tree */}
      <div
        className={`flex-1 overflow-y-auto px-1.5 py-2 transition-colors ${dropTargetPath === '__root__' ? 'bg-nim-hover' : ''}`}
        onDragOver={(event) => {
          const accepts = draggedFolder ? canDropFolder(null) : canDropDocument(null);
          if (!accepts) return;
          const target = event.target as HTMLElement;
          if (target.closest('.file-tree-directory, .file-tree-file')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          if (dropTargetPath !== '__root__') {
            setDropTargetPath('__root__');
          }
        }}
        onDragLeave={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('.file-tree-directory, .file-tree-file')) return;
          const relatedTarget = event.relatedTarget as Node | null;
          if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
            return;
          }
          if (dropTargetPath === '__root__') {
            setDropTargetPath(null);
          }
        }}
        onDrop={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('.file-tree-directory, .file-tree-file')) return;
          if (draggedFolder) {
            if (!canDropFolder(null)) return;
            event.preventDefault();
            moveDraggedFolder(null, null);
            return;
          }
          if (!canDropDocument(null)) return;
          event.preventDefault();
          void moveDraggedDocument(null, null);
        }}
      >
        {(() => {
          // Loading: still resolving workspace state, or team sync is mid-
          // handshake. Render a skeleton instead of an empty/folders-only
          // tree so users don't think their docs disappeared.
          const isResolvingSync =
            teamSyncStatus === 'connecting' || teamSyncStatus === 'syncing';
          if (!hasLoadedState || isResolvingSync) {
            return (
              <div className="px-2 py-4 text-center" data-testid="collab-sidebar-loading">
                <MaterialSymbol
                  icon="cloud_sync"
                  size={32}
                  className="text-nim-faint mb-2 animate-pulse"
                />
                <p className="text-xs text-nim-faint m-0">
                  Loading shared documents...
                </p>
              </div>
            );
          }
          if (tree.length === 0) {
            return (
              <div className="px-2 py-4 text-center">
                <MaterialSymbol icon="cloud_sync" size={32} className="text-nim-faint mb-2" />
                <p className="text-xs text-nim-faint m-0">
                  {workspaceHasTeam
                    ? 'No shared documents yet.'
                    : 'No team connected to this workspace.'}
                </p>
                {workspaceHasTeam && (
                  <p className="text-xs text-nim-faint mt-1 m-0">
                    Create one here or share a local file to collaborate.
                  </p>
                )}
              </div>
            );
          }
          if (filteredTree.length === 0 && hasActiveSearch) {
            return (
              <div className="px-2 py-4 text-center">
                <MaterialSymbol icon="search_off" size={32} className="text-nim-faint mb-2" />
                <p className="text-xs text-nim-faint m-0">
                  No shared documents match "{trimmedSearchQuery}".
                </p>
                <p className="text-xs text-nim-faint mt-1 m-0">
                  Try a different file name or folder path.
                </p>
              </div>
            );
          }
          if (filteredTree.length === 0 && treeFilter === 'favorites') {
            return (
              <div className="px-2 py-4 text-center">
                <MaterialSymbol icon="star" size={32} className="text-nim-faint mb-2" />
                <p className="text-xs text-nim-faint m-0">No favorites yet.</p>
                <p className="text-xs text-nim-faint mt-1 m-0">
                  Star a document to pin it here.
                </p>
              </div>
            );
          }
          if (filteredTree.length === 0 && treeFilter === 'updated') {
            return (
              <div className="px-2 py-4 text-center">
                <MaterialSymbol icon="mark_email_read" size={32} className="text-nim-faint mb-2" />
                <p className="text-xs text-nim-faint m-0">You're all caught up.</p>
                <p className="text-xs text-nim-faint mt-1 m-0">
                  No documents changed since you last viewed them.
                </p>
              </div>
            );
          }
          return <div>{renderTree(filteredTree)}</div>;
        })()}
      </div>

      {/* Header overflow menu: unread-bubble visibility + mark all read */}
      {overflowMenu.isOpen && (
        <FloatingPortal>
          <div
            ref={overflowMenu.refs.setFloating}
            style={overflowMenu.floatingStyles}
            {...overflowMenu.getFloatingProps()}
            className="min-w-[224px] rounded-md z-[10000] text-[13px] p-1 bg-nim-secondary border border-nim text-nim backdrop-blur-[10px] shadow-lg"
          >
            <button
              type="button"
              className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover"
              onClick={() => setShowUnreadBubbles(!showUnreadBubbles)}
            >
              <MaterialSymbol icon="notifications" size={18} />
              <span className="flex-1">Show unread bubbles</span>
              <MaterialSymbol
                icon={showUnreadBubbles ? 'toggle_on' : 'toggle_off'}
                size={20}
                className={showUnreadBubbles ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-faint)]'}
              />
            </button>
            <button
              type="button"
              className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!teamOrgId || changedDocIds.size === 0}
              onClick={handleMarkAllRead}
            >
              <MaterialSymbol icon="done_all" size={18} />
              <span>Mark all as read</span>
            </button>
          </div>
        </FloatingPortal>
      )}

      {newDocumentMenu.isOpen && (
        <FloatingPortal>
          <div
            ref={newDocumentMenu.refs.setFloating}
            style={newDocumentMenu.floatingStyles}
            {...newDocumentMenu.getFloatingProps()}
            className="z-[10000]"
          >
            <CollabNewDocumentMenu
              items={sharedNewDocumentMenuItems}
              onSelect={selectCreateDocumentType}
            />
          </div>
        </FloatingPortal>
      )}

      {/* Context menu */}
      {contextMenu && (
        <FloatingPortal>
          <div
            ref={contextMenuFloating.refs.setFloating}
            style={contextMenuFloating.floatingStyles}
            {...contextMenuFloating.getFloatingProps()}
            className="min-w-[160px] rounded-md z-[10000] text-[13px] p-1 bg-nim-secondary border border-nim text-nim backdrop-blur-[10px] shadow-lg"
          >
          {contextMenu.node.type === 'folder' ? (
            <>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover"
                onClick={event => openCreateDocumentMenu(event.currentTarget)}
              >
                <MaterialSymbol icon="note_add" size={18} />
                <span>New Document</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover"
                onClick={openCreateFolderDialog}
              >
                <MaterialSymbol icon="create_new_folder" size={18} />
                <span>New Folder</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => {
                  if (contextMenu.node.type !== 'folder') return;
                  const { folderId } = contextMenu.node;
                  if (folderId) {
                    // First-class folder: rename the folder row directly.
                    const folder = folderById.get(folderId);
                    if (folder) setFolderToRename(folder);
                  } else {
                    // Legacy path-in-title folder (pre-migration): rewrite the
                    // folder segment across its descendant document titles.
                    setLegacyFolderToRename({ path: contextMenu.node.path, name: contextMenu.node.name });
                  }
                  setContextMenu(null);
                }}
              >
                <MaterialSymbol icon="edit" size={18} />
                <span>Rename</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!teamOrgId || !contextMenu.node.folderId}
                title={teamOrgId ? undefined : 'No team is connected to this workspace'}
                onClick={() => {
                  const folderId = contextMenu.node.type === 'folder' ? contextMenu.node.folderId : undefined;
                  setContextMenu(null);
                  if (folderId) void handleCopyFolderLink(folderId);
                }}
              >
                <MaterialSymbol icon="link" size={18} />
                <span>Copy Link</span>
              </button>
              <div className="my-1 border-t border-[var(--nim-border)]" />
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-[var(--nim-danger)] hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!contextMenu.node.folderId}
                onClick={handleDelete}
              >
                <MaterialSymbol icon="delete" size={18} />
                <span>Delete</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover"
                onClick={() => {
                  if (!contextDocument) return;
                  onDocumentSelect(contextDocument);
                  setContextMenu(null);
                }}
              >
                <MaterialSymbol icon="open_in_new" size={18} />
                <span>Open</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover"
                onClick={() => {
                  if (!contextDocument) return;
                  handleToggleFavorite(contextDocument);
                  setContextMenu(null);
                }}
              >
                <MaterialSymbol
                  icon="star"
                  size={18}
                  fill={contextDocument ? favoriteSet.has(contextDocument.documentId) : false}
                />
                <span>
                  {contextDocument && favoriteSet.has(contextDocument.documentId)
                    ? 'Unfavorite'
                    : 'Favorite'}
                </span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={
                  !teamOrgId ||
                  !contextDocument ||
                  !changedDocIds.has(contextDocument.documentId)
                }
                onClick={() => {
                  if (!contextDocument) return;
                  handleMarkDocRead(contextDocument);
                  setContextMenu(null);
                }}
              >
                <MaterialSymbol icon="mark_email_read" size={18} />
                <span>Mark as read</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!teamOrgId}
                title={teamOrgId ? undefined : 'No team is connected to this workspace'}
                onClick={() => {
                  if (!contextDocument) return;
                  setContextMenu(null);
                  void handleCopyLink(contextDocument);
                }}
              >
                <MaterialSymbol icon="link" size={18} />
                <span>Copy Link</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!teamOrgId}
                title={teamOrgId ? undefined : 'No team is connected to this workspace'}
                onClick={() => {
                  if (!contextDocument || !teamOrgId) return;
                  setContextMenu(null);
                  // Open the tab if it isn't already; the CollaborativeTabEditor
                  // publishes a history controller on mount. The dialog itself
                  // grace-waits for the controller to register.
                  onDocumentSelect(contextDocument);
                  setHistoryDialogFile(buildCollabUri(teamOrgId, contextDocument.documentId));
                }}
              >
                <MaterialSymbol icon="history" size={18} />
                <span>View History</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover"
                onClick={() => {
                  if (!contextDocument) return;
                  setDocumentToRename(contextDocument);
                  setContextMenu(null);
                }}
              >
                <MaterialSymbol icon="edit" size={18} />
                <span>Rename</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!contextLocalOrigin.hasResolvedBinding || contextLocalOrigin.busyAction !== null}
                onClick={() => {
                  setContextMenu(null);
                  void contextLocalOrigin.openLocalSource();
                }}
              >
                <MaterialSymbol icon="draft" size={18} />
                <span>Open Local Source</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!contextLocalOrigin.binding || contextLocalOrigin.busyAction !== null}
                onClick={() => {
                  setContextMenu(null);
                  void contextLocalOrigin.reuploadFromLocalSource();
                }}
              >
                <MaterialSymbol icon="upload" size={18} />
                <span>Re-upload From Local</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={contextLocalOrigin.busyAction !== null}
                onClick={() => {
                  setContextMenu(null);
                  void contextLocalOrigin.relinkLocalSource();
                }}
              >
                <MaterialSymbol icon="link" size={18} />
                <span>{contextLocalOrigin.binding ? 'Relink Local Source...' : 'Link Local Source...'}</span>
              </button>
              {contextLocalOrigin.binding && (
                <button
                  type="button"
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={contextLocalOrigin.busyAction !== null}
                  onClick={() => {
                    setContextMenu(null);
                    void contextLocalOrigin.clearLocalSource();
                  }}
                >
                  <MaterialSymbol icon="link_off" size={18} />
                  <span>Clear Local Source</span>
                </button>
              )}
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim-error hover:bg-nim-hover"
                onClick={handleDelete}
              >
                <MaterialSymbol icon="delete" size={18} />
                <span>Move to Trash</span>
              </button>
            </>
          )}
          </div>
        </FloatingPortal>
      )}

      <CollabCreateItemDialog
        isOpen={createDocumentDescriptor !== null}
        kind="document"
        documentDescriptor={createDocumentDescriptor ?? undefined}
        folders={sharedFolders}
        targetFolderId={createTargetFolderId}
        onTargetFolderChange={setCreateTargetFolderId}
        onConfirm={handleCreateDocument}
        onCancel={() => {
          setCreateDocumentDescriptor(null);
          setContextMenu(null);
        }}
      />

      <CollabCreateItemDialog
        isOpen={isCreateFolderOpen}
        kind="folder"
        folders={sharedFolders}
        targetFolderId={createTargetFolderId}
        onTargetFolderChange={setCreateTargetFolderId}
        onConfirm={handleCreateFolder}
        onCancel={() => {
          setIsCreateFolderOpen(false);
          setContextMenu(null);
        }}
      />

      <InputModal
        isOpen={documentToRename !== null}
        title="Rename Shared Document"
        placeholder="Document name"
        defaultValue={documentToRename ? getCollabNodeName(getCollabDocumentPath(documentToRename)) : ''}
        confirmLabel="Rename"
        onConfirm={handleRenameDocument}
        onCancel={() => {
          setDocumentToRename(null);
          setContextMenu(null);
        }}
      />

      <InputModal
        isOpen={folderToRename !== null}
        title="Rename Shared Folder"
        placeholder="Folder name"
        defaultValue={folderToRename?.name ?? ''}
        confirmLabel="Rename"
        onConfirm={handleRenameFolder}
        onCancel={() => {
          setFolderToRename(null);
          setContextMenu(null);
        }}
      />

      <InputModal
        isOpen={legacyFolderToRename !== null}
        title="Rename Shared Folder"
        placeholder="Folder name"
        defaultValue={legacyFolderToRename?.name ?? ''}
        confirmLabel="Rename"
        onConfirm={handleRenameLegacyFolder}
        onCancel={() => {
          setLegacyFolderToRename(null);
          setContextMenu(null);
        }}
      />
    </div>
  );
};
