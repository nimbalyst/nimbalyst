import { SharedDocumentLink } from './SharedDocumentLink';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { collabOpenOptions, isPersonalCollabScope, type CollabDocumentTypeDescriptor } from '@nimbalyst/collab-client/core';
import { atom, useAtomValue } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import './collabSidebarTree.css';
import { InputModal } from './primitives/InputModal';
import { confirmDestructive } from './primitives/confirmDestructive';
import { ScopeSummaryHeader } from './primitives/ScopeSummaryHeader';
import { CollabCreateItemDialog } from './CollabCreateItemDialog';
import {
  buildSharedNewDocumentMenuItems,
  CollabNewDocumentMenu,
} from './CollabNewDocumentMenu';
import {
  type SharedDocument,
  type SharedFolder,
  type SharedParentKind,
  buildCollabTreeAdaptive,
  collectFolderSubtree,
  collectPageSubtree,
  planPageRemoval,
  getSharedDocumentDisplayPath,
  pruneEmptyFolders,
  getCollabDocumentPath,
  getCollabNodeName,
  getCollabParentPath,
  joinCollabPath,
  normalizeCollabPath,
  pageDisplayName,
  resolveCollabCreateTargetFolderId,
  type CollabTreeItemNode,
  type CollabTreeNode,
  type CollabTreeTypeNode,
  type CollabPageMoveOptions,
  type CollabTypeTreeResolver,
} from '@nimbalyst/collab-client/docs';
import type { PageTreeDestination, PageTreeDropPlan, PageTreeWrite } from '../docs/collabPageTree';
import {
  CollabPlaceTypeMenu,
  CollabTreeActiveContext,
  CollabTypeItemRow,
  CollabTypeTreeBranch,
  getPlaceableTypes,
  UNDER_TYPE,
  type CollabPageMoveTarget,
  type CollabRowDrop,
} from './CollabTypeTreeRows';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../ui-primitives/useFloatingMenu';
import { CollabSectionMenu, CollabTreeEmptyState, type CollabSectionMenuItem } from './CollabSectionRoot';
import { CollabSidebarTrashEntry } from './CollabTrash';
import { revealKeysFor } from './collabTreeReveal';
import { usePageActionRequest, type CollabPageActionRequest } from './usePageActionRequest';

const CYCLE_WARNING = 'A page cannot move inside one of its own child pages.';

const NO_ROW_DROP: CollabRowDrop = { onDragOver: () => undefined, onDragLeave: () => undefined, onDrop: () => undefined, className: '' };

// For sessions built without the page-tree atoms (test doubles, older hosts).
const NO_ITEM_PLACEMENTS = atom([]);
const NOT_A_PAGE_TREE = atom(false);

// Lazy: the page-tree menu and move picker stay out of the docs-ui eager
// bundle. The menu module is preloaded once a tree turns out to be a page tree.
const loadPageMenu = () => import('./CollabPageMenu');
// The page tree builder too: only a page-tree scope needs it.
const loadPageTreeBuilder = () => import('../docs/collabPageTree');
type PageTreeBuilder = Awaited<ReturnType<typeof loadPageTreeBuilder>>;
const CollabPageMenuHead = React.lazy(() => loadPageMenu().then((m) => ({ default: m.CollabPageMenuHead })));
const CollabPageDeleteEntry = React.lazy(() => loadPageMenu().then((m) => ({ default: m.CollabPageDeleteEntry })));
const CollabItemMenu = React.lazy(() => loadPageMenu().then((m) => ({ default: m.CollabItemMenu })));
const CollabPageHistoryEntry = React.lazy(() => loadPageMenu().then((m) => ({ default: m.CollabPageHistoryEntry })));
import { CollabMenuButton } from './primitives/CollabMenuButton';
const CollabPageMoveDialog = React.lazy(() => import('./CollabPageMoveDialog'));
import { DocUnreadDot } from './DocUnreadDot';
import { bucketItemCount, trackDocumentAction } from './analytics';
import { useCollabDocsUI, type CollabTreeFilter } from './CollabDocsUIProvider';
import {
  applySharedDocumentRenameSuffix,
  getSharedDocumentRenameParts,
  resolveSharedDocumentTypePresentation,
} from './documentPresentation';
import {
  COLLAB_DOCUMENT_DRAG_TYPE,
  type CollabDocumentDragPayload,
} from './documentDrag';

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

const TeamSyncStatusLabel: React.FC<{ status: TeamSyncStatus; personal?: boolean }> = ({ status, personal }) => {
  const { label, dotClass } = personal
    ? { label: 'On this device', dotClass: 'bg-gray-500' }
    : STATUS_CONFIG[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      <span>{label}</span>
    </span>
  );
};

function useUnavailableLocalOrigin() {
  return {
    available: false,
    binding: null,
    busyAction: null,
    hasResolvedBinding: true,
    openLocalSource: async () => false,
    relinkLocalSource: async () => false,
    clearLocalSource: async () => false,
    reuploadFromLocalSource: async () => false,
  };
}

export interface CollabSidebarProps {
  activeDocumentId?: string | null;
  /** The open typed page (item id) or type page (type id), highlighted like the open page. */
  activeItemId?: string | null;
  activeTypeId?: string | null;
  /** Fixed rows above the tree (the section's Home, Search and Types: `PagesSectionEntries`). */
  sectionEntries?: React.ReactNode;
  /** Host-owned scope label and path chrome; sidebar actions remain shared. */
  scopeName?: React.ReactNode;
  scopePath?: React.ReactNode;
  headerActions?: React.ReactNode;
  /** Host entries appended to the section's right-click menu. */
  extraSectionMenuItems?: readonly CollabSectionMenuItem[];
  /**
   * Hosts where a folder is an addressable surface (the browser console routes
   * `/docs/folder/:folderId`). Desktop leaves this unset, so a folder click
   * stays a pure expand/select there.
   */
  onSelectFolder?: (folderId: string | null) => void;
  /**
   * Publishes this tree's create menu to a host outside it (the desktop title
   * bar's create control). The list is built here because the catalog filtering
   * that decides which types are shareable at all lives here; a second copy in
   * the host would drift from it.
   */
  registerCreateMenu?: (menu: CollabSidebarCreateMenu | null) => void;
  /**
   * Names placed tracker types and lists their items. Hosts without tracker
   * data omit it, and the tree then shows no type nodes.
   */
  typeResolver?: CollabTypeTreeResolver;
  /**
   * Archive a typed page (the tracker's own archive, which keeps its comments
   * and sessions). Typed pages never go to Wiki Trash; hosts without tracker
   * writes omit it and the row offers no Archive.
   */
  onArchiveItem?: (itemId: string) => Promise<void>;
  /**
   * Shows this tree as one section of a stacked sidebar ("Team", "Personal"):
   * a compact section header replaces the scope summary header.
   */
  sectionTitle?: string;
  /**
   * Section only: with `onToggleCollapsed` the title row becomes a toggle, and
   * a collapsed section renders that row alone (no filters, search or tree).
   */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /**
   * Page tree only: turn a plain page into a typed page in place. Without it
   * the menu's "Set type" entry is shown disabled.
   */
  onSetPageType?: (document: SharedDocument) => void;
  /** A page action from outside the tree (the page's header menu); `onPageActionHandled` clears it. */
  pageActionRequest?: CollabPageActionRequest | null;
  onPageActionHandled?: () => void;
}

export interface CollabSidebarCreateMenu {
  items: Array<{ id: string; label: string; icon: string; onSelect: () => void }>;
  /** Folder the new document lands in, or null for the space root. */
  destination: string | null;
  /** Default action: a shared Markdown doc. */
  onPrimary: () => void;
  /** Extension the default action produces, shown beside it. */
  primaryTrailing?: string;
  onNewFolder: () => void;
  /** True when this tree has pages instead of folders (no "New folder"). */
  pageTree?: boolean;
}

export const CollabSidebar: React.FC<CollabSidebarProps> = ({
  activeDocumentId,
  activeItemId = null,
  activeTypeId = null,
  sectionEntries,
  scopeName,
  scopePath,
  headerActions,
  extraSectionMenuItems,
  onSelectFolder,
  registerCreateMenu,
  typeResolver,
  onArchiveItem,
  sectionTitle,
  collapsed = false,
  onToggleCollapsed,
  onSetPageType,
  pageActionRequest,
  onPageActionHandled,
}) => {
  const { scope, host, session, controller } = useCollabDocsUI();
  // Per session, not the active scope: a Personal section is never active.
  const typePlacements = useAtomValue(session.atoms.typePlacements);
  const itemPlacements = useAtomValue(session.atoms.itemPlacements ?? NO_ITEM_PLACEMENTS);
  // One page tree: documents nest in documents and `sharedFolders` holds the
  // pages themselves (see `projectPagesAsFolders`), so the folder paths and
  // pickers below resolve pages without a second code path.
  const pageTree = useAtomValue(session.atoms.pageTree ?? NOT_A_PAGE_TREE);
  const [pageTreeBuilder, setPageTreeBuilder] = useState<PageTreeBuilder | null>(null);
  useEffect(() => {
    if (!pageTree || pageTreeBuilder) return undefined;
    let live = true;
    void loadPageMenu();
    loadPageTreeBuilder()
      .then((builder) => { if (live) setPageTreeBuilder(builder); })
      .catch((error) => host.reportError?.(error, 'Failed to load the page tree'));
    return () => { live = false; };
  }, [host, pageTree, pageTreeBuilder]);
  const personal = isPersonalCollabScope(scope);
  // No resolver (a host without tracker data): no type nodes.
  const typeTreeInput = useMemo(
    () => (typeResolver ? { placements: typePlacements, resolver: typeResolver } : undefined),
    [typePlacements, typeResolver],
  );
  const placedTypeIds = useMemo(
    () => new Set(typePlacements.map((placement) => placement.typeId)),
    [typePlacements],
  );
  const placeableTypes = useMemo(
    () => getPlaceableTypes(typeResolver, placedTypeIds),
    [typeResolver, placedTypeIds],
  );
  const [placeTypeMenu, setPlaceTypeMenu] = useState<{
    x: number;
    y: number;
    parentFolderId: string | null;
    /** 'item' when the type goes under a typed page. */
    parentKind?: 'page' | 'item';
  } | null>(null);
  // Empty tree space or the section header: New page / Place type at the root.
  const [sectionMenu, setSectionMenu] = useState<{ x: number; y: number } | null>(null);
  // "New page inside" a typed page: it is not in the folder list the create
  // dialog picks from, so it is offered there as one extra location.
  // Whether `createTargetFolderId` is a page or a typed page (page tree only).
  const [createTargetKind, setCreateTargetKind] = useState<SharedParentKind>('page');
  const [draggedType, setDraggedType] = useState<string | null>(null);
  const [draggedItem, setDraggedItem] = useState<CollabTreeItemNode | null>(null);
  const [moveTarget, setMoveTarget] = useState<
    | { kind: 'page'; document: SharedDocument }
    | { kind: 'item'; node: CollabTreeItemNode }
    | { kind: 'type'; node: CollabTreeTypeNode }
    | null
  >(null);
  // Edge (before/after) drop marker for page-tree rows; a middle drop uses `dropTargetPath`.
  const [dropIndicator, setDropIndicator] = useState<{ nodeId: string; zone: 'before' | 'after' } | null>(null);
  const documentTypesRevision = useSyncExternalStore(
    (listener) => host.documents?.onDocumentTypesChanged?.(listener) ?? (() => undefined),
    () => host.documents?.documentTypes() ?? [],
    () => host.documents?.documentTypes() ?? [],
  );
  const documentTypeDescriptors = host.documents?.documentTypes() ?? [];
  const sharedDocuments = useAtomValue(session.atoms.sharedDocuments);
  const allSharedDocuments = useAtomValue(session.atoms.allSharedDocuments);
  const sharedFolders = useAtomValue(session.atoms.sharedFolders);
  const teamSyncStatus = useAtomValue(session.atoms.syncStatus);
  const teamOrgId = scope.orgId;
  // A Personal scope needs no team; it is available as soon as it exists.
  const scopeAvailable = useAtomValue(session.atoms.hasTeam) || personal;

  // Discovery: favorites, tree filter, and unread-bubble visibility.
  const treeFilter = useAtomValue(session.atoms.treeFilter);
  const showUnreadBubbles = useAtomValue(session.atoms.showUnreadBubbles);
  const favorites = useAtomValue(session.atoms.favorites);
  const changedDocIds = useAtomValue(session.atoms.changedDocumentIds);
  const { personalState: personalStateAvailable, readReceipts: readReceiptsAvailable } =
    session.uiCapabilities;
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const effectiveTreeFilter: CollabTreeFilter =
    treeFilter === 'favorites' && personalStateAvailable
      ? 'favorites'
      : treeFilter === 'updated' && readReceiptsAvailable
        ? 'updated'
        : 'all';
  const treeSegments = useMemo(() => [
    { key: 'all' as const, label: 'All', icon: null },
    ...(personalStateAvailable
      ? [{ key: 'favorites' as const, label: 'Favorites', icon: 'star' }]
      : []),
    ...(readReceiptsAvailable
      ? [{ key: 'updated' as const, label: 'Updated', icon: 'circle' }]
      : []),
  ], [personalStateAvailable, readReceiptsAvailable]);
  const [overflowOpen, setOverflowOpen] = useState(false);

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
  const [createDocumentDescriptor, setCreateDocumentDescriptor] = useState<CollabDocumentTypeDescriptor | null>(null);
  const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
  const [createTargetFolderId, setCreateTargetFolderId] = useState<string | null>(null);
  const [documentToRename, setDocumentToRename] = useState<SharedDocument | null>(null);
  const documentRenameParts = documentToRename
    ? getSharedDocumentRenameParts(documentToRename, documentTypeDescriptors)
    : { baseName: '', suffix: '' };
  const [hasLoadedState, setHasLoadedState] = useState(false);
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const pendingCollabFolder = useAtomValue(session.atoms.pendingFolder);
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

  const showWarning = useCallback((title: string, message: string) => {
    host.notify?.({ level: 'warning', title, message, duration: 5000 });
  }, [host]);
  const reportTypePlacementError = useCallback((error: unknown) => {
    showWarning('Could not update the tree', error instanceof Error ? error.message : String(error));
  }, [showWarning]);

  // Full tree (all docs + first-class folders) — used for path-collision checks
  // and auto-expand, independent of the active filter.
  const tree = useMemo(
    () => {
      if (!pageTree) return buildCollabTreeAdaptive(sharedDocuments, sharedFolders, typeTreeInput);
      return pageTreeBuilder?.buildCollabPageTree(sharedDocuments, {
        resolver: typeResolver,
        typePlacements,
        itemPlacements,
      }) ?? [];
    },
    [itemPlacements, pageTree, pageTreeBuilder, sharedDocuments, sharedFolders, typePlacements, typeResolver, typeTreeInput]
  );

  // Placed subtypes shown inside their base type (see `attachTypeNodes`).
  const nestedTypeIds = useMemo(() => {
    const ids = new Set<string>();
    const walk = (nodes: CollabTreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'type') node.children.forEach((child) => { if (child.type === 'type') ids.add(child.typeId); });
        if ('children' in node && node.children) walk(node.children);
      }
    };
    walk(tree);
    return ids;
  }, [tree]);

  // Docs visible under the active segmented filter (All / Favorites / Updated).
  const visibleDocuments = useMemo(() => {
    if (effectiveTreeFilter === 'favorites') {
      return sharedDocuments.filter((d) => favoriteSet.has(d.documentId));
    }
    if (effectiveTreeFilter === 'updated') {
      return sharedDocuments.filter((d) => changedDocIds.has(d.documentId));
    }
    return sharedDocuments;
  }, [sharedDocuments, effectiveTreeFilter, favoriteSet, changedDocIds]);

  // Rendered tree — filtered docs; drop empty folders in filtered views so the
  // Favorites/Updated segments show only folders that still contain a match.
  const displayTree = useMemo(
    () => {
      // Favorites and Updated are document filters; placed types only show in All.
      if (effectiveTreeFilter !== 'all') {
        return pageTree
          ? pageTreeBuilder?.buildCollabPageTree(visibleDocuments) ?? []
          : pruneEmptyFolders(buildCollabTreeAdaptive(visibleDocuments, sharedFolders));
      }
      return pageTree ? tree : buildCollabTreeAdaptive(visibleDocuments, sharedFolders, typeTreeInput);
    },
    [visibleDocuments, sharedFolders, effectiveTreeFilter, typeTreeInput, pageTree, pageTreeBuilder, tree]
  );

  const existingPaths = useMemo(() => {
    const paths = new Set<string>();

    const collect = (nodes: CollabTreeNode[]) => {
      for (const node of nodes) {
        // Type and item nodes never collide with document or folder names.
        if (node.type === 'type' || node.type === 'item') continue;
        paths.add(node.path);
        if (node.type === 'folder' || node.type === 'document') {
          collect(node.children ?? []);
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
  const activeRow = useMemo(() => ({ itemId: activeItemId, typeId: activeTypeId }), [activeItemId, activeTypeId]);

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

  // The breadcrumb path a document's row sits at, which is also the expansion
  // key of each ancestor row.
  // The expansion key of a document's ancestors. A folder tree keeps reading
  // the title, so first-class folders start collapsed as they always have.
  const treePathOf = useCallback(
    (document: SharedDocument) => (pageTree
      ? getSharedDocumentDisplayPath(document, sharedFolders)
      : getCollabDocumentPath(document)),
    [pageTree, sharedFolders],
  );
  // Where a document sits, for rename and move comparisons: from its parents,
  // since a bare title names only the leaf.
  const locationOf = useCallback(
    (document: SharedDocument) => getSharedDocumentDisplayPath(document, sharedFolders),
    [sharedFolders],
  );



  const canMutateMetadata = useCallback((actionLabel: string) => {
    if (teamSyncStatus === 'connected') {
      return true;
    }

    showWarning(
      'Shared documents are offline',
      `Cannot ${actionLabel} while shared document sync is ${teamSyncStatus}. Reconnect to the team before changing shared document metadata.`,
    );
    return false;
  }, [showWarning, teamSyncStatus]);

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
    () => buildSharedNewDocumentMenuItems(documentTypeDescriptors),
    // The subscription value changes whenever the host registry changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentTypesRevision],
  );
  const markdownDescriptor = sharedNewDocumentMenuItems.find(({ descriptor }) => descriptor.documentType === 'markdown')?.descriptor;
  // A new markdown page under `parentId` (null = this section's root).
  const startNewPage = (parentId: string | null, parentKind: SharedParentKind = 'page') => {
    setCreateTargetKind(parentKind);
    setCreateTargetFolderId(parentId);
    if (markdownDescriptor) setCreateDocumentDescriptor(markdownDescriptor);
    setContextMenu(null);
    setSectionMenu(null);
    // The create dialog renders with the tree, so a collapsed section opens.
    if (collapsed) onToggleCollapsed?.();
  };

  const handleMarkAllRead = useCallback(() => {
    setOverflowOpen(false);
    if (teamOrgId) {
      void session.markAllDocumentsViewed();
    }
  }, [session, teamOrgId]);

  const handleToggleFavorite = useCallback((document: SharedDocument) => {
    const wasFavorite = favoriteSet.has(document.documentId);
    session.toggleFavorite(document.documentId);
    trackDocumentAction(host, {
      action: wasFavorite ? 'favorite_disabled' : 'favorite_enabled',
      documentType: document.documentType,
      entryPoint: 'sidebar',
    });
  }, [favoriteSet, host, session]);

  const handleMarkDocRead = useCallback((document: SharedDocument) => {
    if (!teamOrgId) return;
    void session.markDocumentViewed(document.documentId, document.updatedAt ?? null);
    trackDocumentAction(host, {
      action: 'marked_read',
      documentType: document.documentType,
      entryPoint: 'sidebar',
    });
  }, [host, session, teamOrgId]);

  useEffect(() => {
    setHasLoadedState(false);
    setLoadedScopeKey(null);
    setContextMenu(null);
    setDocumentToRename(null);
    setFolderToRename(null);
    setLegacyFolderToRename(null);
    setSelectedFolderPath(null);
    setSelectedFolderId(null);
    setExpandedFolders(new Set());
    setUserTouchedExpansion(false);

    if (!host.documents?.loadTreeState) {
      setHasLoadedState(true);
      setLoadedScopeKey(scope.scopeKey);
      return;
    }

    let cancelled = false;
    host.documents.loadTreeState(scope.scopeKey)
      .then((state) => {
        if (cancelled) return;

        const nextExpanded = Array.isArray(state?.expandedFolders)
          ? state.expandedFolders.map((folder: string) => normalizeCollabPath(folder)).filter(Boolean)
          : [];

        setExpandedFolders(new Set(nextExpanded));
        // Treat persisted tree state as a user customization so we don't
        // override the user's collapse decisions with the auto-expand fallback.
        setUserTouchedExpansion(
          state?.userTouched === true || nextExpanded.length > 0
        );
        setHasLoadedState(true);
        setLoadedScopeKey(scope.scopeKey);
      })
      .catch(() => {
        if (cancelled) return;
        setHasLoadedState(true);
        setLoadedScopeKey(scope.scopeKey);
      });

    return () => {
      cancelled = true;
    };
  }, [host.documents, scope.scopeKey]);

  useEffect(() => {
    if (!hasLoadedState || loadedScopeKey !== scope.scopeKey || !host.documents?.saveTreeState) return;
    host.documents.saveTreeState(scope.scopeKey, {
      expandedFolders: Array.from(expandedFolders),
      userTouched: userTouchedExpansion,
    }).catch((error) => {
      console.warn('[CollabSidebar] Failed to persist tree state:', error);
    });
  }, [expandedFolders, hasLoadedState, host.documents, loadedScopeKey, userTouchedExpansion, scope.scopeKey]);

  useEffect(() => {
    if (!activeDocument) return;
    const path = treePathOf(activeDocument);
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
  }, [activeDocument, treePathOf]);

  // The same for the open typed page or type, once per target: the tree
  // re-renders on every item edit, and a row the user closes stays closed.
  const revealedRowRef = useRef<string | null>(null);
  useEffect(() => {
    const targetKey = activeItemId ? `item:${activeItemId}` : activeTypeId ? `type:${activeTypeId}` : null;
    if (!targetKey || revealedRowRef.current === targetKey) return;
    const keys = revealKeysFor(tree, { itemId: activeItemId, typeId: activeTypeId });
    if (!keys) return;
    revealedRowRef.current = targetKey;
    if (keys.length === 0) return;
    setExpandedFolders((current) => (keys.every((key) => current.has(key)) ? current : new Set([...current, ...keys])));
  }, [activeItemId, activeTypeId, tree]);

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
      host.notify?.({ level: 'warning', title: 'No team configured', message: 'This workspace is not connected to a team, so no shareable link is available.', duration: 4000 });
      return;
    }
    const url = host.artifactUrl?.({
      kind: 'document',
      scope,
      documentId: document.documentId,
      teamProjectId: document.teamProjectId,
    });
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      trackDocumentAction(host, {
        action: 'link_copied',
        documentType: document.documentType,
        entryPoint: 'sidebar',
      });
      host.notify?.({ level: 'info', title: 'Link copied', message: 'Paste it anywhere to open this document.', duration: 3000 });
    } catch (err) {
      console.error('[CollabSidebar] Failed to copy link:', err);
      host.notify?.({ level: 'error', title: 'Copy failed', message: 'Could not write the link to the clipboard.' });
    }
  }, [host, scope, teamOrgId]);

  // Page tree: a page with children goes to Trash with its subtree; a leaf
  // page goes to Trash like any document.
  const trashDocument = useCallback((document: SharedDocument, name: string) => {
    const childCount = pageTree ? planPageRemoval(allSharedDocuments, typePlacements, document.documentId).childCount : 0;
    if (childCount > 0) {
      if (!canMutateMetadata('move this page to Trash')) return;
      const pages = `${childCount} child page${childCount === 1 ? '' : 's'}`;
      // Counts the prose of types placed inside it, which goes too.
      setContextMenu(null);
      void confirmDestructive('Move page to Trash', `Move "${pageDisplayName(name, document.documentType)}" and its ${pages} to Trash? Types and typed pages inside show in their usual place until you restore it.`).then((accepted) => {
        if (!accepted) return;
        session.removePage(document.documentId);
        host.trackEvent?.('collab_folder_deleted', {
          actorType: 'user',
          source: 'sidebar',
          documentCountBucket: bucketItemCount(childCount),
          subfolderCountBucket: bucketItemCount(0),
        });
      });
      return;
    }
    if (!canMutateMetadata('move this document to Trash')) return;
    session.trashDocument(document.documentId);
    trackDocumentAction(host, {
      action: 'trashed',
      documentType: document.documentType,
      entryPoint: 'context_menu',
    });
    setContextMenu(null);
  }, [allSharedDocuments, canMutateMetadata, host, pageTree, session, typePlacements]);

  const handleDelete = useCallback(() => {
    if (!contextMenu) return;

    if (contextMenu.node.type === 'document') {
      trashDocument(contextMenu.node.document, contextMenu.node.name);
      return;
    }

    // Type and item rows have no delete; "Remove from tree" is separate.
    if (contextMenu.node.type !== 'folder') { setContextMenu(null); return; }

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
    setContextMenu(null);
    void confirmDestructive('Delete shared folder', `Delete shared folder "${contextMenu.node.name}"${detail}? This cannot be undone.`).then((accepted) => {
      if (!accepted) return;
      session.removeFolder(folderId);
      host.trackEvent?.('collab_folder_deleted', {
        actorType: 'user',
        source: 'sidebar',
        documentCountBucket: bucketItemCount(docCount),
        subfolderCountBucket: bucketItemCount(folderCount),
      });
      if (selectedFolderId === folderId) {
        setSelectedFolderId(null);
        setSelectedFolderPath(null);
      }
    });
  }, [allSharedDocuments, canMutateMetadata, contextMenu, host, selectedFolderId, session, sharedFolders, trashDocument]);

  // Removes the placement only; the type and its items stay.
  const removeTypeFromTree = useCallback((typeId: string) => {
    if (canMutateMetadata('remove this type from the tree')) session.removeTypePlacement(typeId).catch(reportTypePlacementError);
  }, [canMutateMetadata, reportTypePlacementError, session]);

  usePageActionRequest({
    request: pageActionRequest,
    tree,
    onHandled: onPageActionHandled,
    onMissing: () => showWarning('Page not found', 'This page is not in the sidebar, so the action did not run.'),
    run: (target, action) => {
      // A collapsed section renders its header row alone, without the dialogs
      // (New page opens it itself).
      if (collapsed && (action === 'rename' || action === 'moveTo')) onToggleCollapsed?.();
      if (target.type === 'type') {
        if (action === 'removeFromTree') removeTypeFromTree(target.typeId);
        else if (action === 'moveTo' && nestedTypeIds.has(target.typeId)) showWarning('Cannot move this type', 'It is shown inside the type it extends.');
        else if (action === 'moveTo') setMoveTarget({ kind: 'type', node: target });
        return;
      }
      if (target.type === 'item') {
        if (action === 'newPageInside') startNewPage(target.itemId, 'item');
        else if (action === 'moveTo') setMoveTarget({ kind: 'item', node: target });
        else if (action === 'backUnderType') moveItemTo(target.itemId, { underType: true });
        return;
      }
      const { document } = target;
      if (action === 'newPageInside') startNewPage(document.documentId);
      else if (action === 'rename') setDocumentToRename(document);
      else if (action === 'moveTo') setMoveTarget({ kind: 'page', document });
      else if (action === 'trash') trashDocument(document, target.name);
    },
  });

  const handleCopyFolderLink = useCallback(async (folderId: string) => {
    if (!teamOrgId) {
      host.notify?.({ level: 'warning', title: 'No team configured', message: 'This workspace is not connected to a team, so no shareable link is available.', duration: 4000 });
      return;
    }
    const url = host.artifactUrl?.({ kind: 'folder', scope, folderId });
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      host.trackEvent?.('collab_folder_link_copied', { actorType: 'user', entryPoint: 'sidebar' });
      host.notify?.({ level: 'info', title: 'Folder link copied', message: 'Paste it anywhere to open this folder.', duration: 3000 });
    } catch (err) {
      console.error('[CollabSidebar] Failed to copy folder link:', err);
      host.notify?.({ level: 'error', title: 'Copy failed', message: 'Could not write the link to the clipboard.' });
    }
  }, [host, scope, teamOrgId]);

  const handleRenameFolder = useCallback(async (nextName: string) => {
    if (!folderToRename) return;
    if (!canMutateMetadata('rename this folder')) return;
    const name = nextName.trim();
    if (!name || name === folderToRename.name) {
      setFolderToRename(null);
      setContextMenu(null);
      return;
    }
    await session.renameFolder(folderToRename.folderId, name);
    host.trackEvent?.('collab_folder_renamed', {
      actorType: 'user',
      source: 'sidebar',
    });
    setFolderToRename(null);
    setContextMenu(null);
  }, [canMutateMetadata, folderToRename, host, session]);

  const handleRenameLegacyFolder = useCallback(async (nextName: string) => {
    if (!legacyFolderToRename) return;
    if (!canMutateMetadata('rename this folder')) return;
    const name = nextName.trim();
    if (!name || name === legacyFolderToRename.name) {
      setLegacyFolderToRename(null);
      setContextMenu(null);
      return;
    }
    await session.renameLegacyFolder(legacyFolderToRename.path, name);
    host.trackEvent?.('collab_folder_renamed', {
      actorType: 'user',
      source: 'legacy_folder',
    });
    setLegacyFolderToRename(null);
    setContextMenu(null);
  }, [canMutateMetadata, host, legacyFolderToRename, session]);

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
    if (!hasLoadedState || loadedScopeKey !== scope.scopeKey) return;
    if (userTouchedExpansion) return;
    if (sharedDocuments.length === 0) return;

    const docFolderPaths = new Set<string>();
    for (const document of sharedDocuments) {
      const path = treePathOf(document);
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
  }, [hasLoadedState, loadedScopeKey, scope.scopeKey, sharedDocuments, treePathOf, userTouchedExpansion]);

  // The folderId a create action should nest under (null = root): the
  // right-clicked folder, else the currently selected folder.
  // Folder deep link (nimbalyst://folder/...): once the target folder has
  // synced, expand its ancestor chain and select it, then clear the signal.
  useEffect(() => {
    if (
      !pendingCollabFolder
      || pendingCollabFolder.scopeKey !== scope.scopeKey
      || pendingCollabFolder.orgId !== scope.orgId
    ) return;
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
    session.clearPendingFolder();
  }, [folderById, folderPathById, pendingCollabFolder, scope, session]);

  // Where a new item goes: the row the menu was opened on, else in a page
  // tree the open page or typed page, else the selected folder.
  const applyCreationBaseTarget = useCallback(() => {
    if (pageTree && contextMenu?.node.type === 'item') {
      setCreateTargetFolderId(contextMenu.node.itemId);
      setCreateTargetKind('item');
      return;
    }
    const contextFolderId = contextMenu?.node.type === 'folder'
      ? (contextMenu.node.folderId ?? null)
      : pageTree && contextMenu?.node.type === 'document'
        ? contextMenu.node.document.documentId
        : undefined;
    if (pageTree && contextFolderId === undefined && (activeItemId || activeDocumentId)) {
      setCreateTargetFolderId(activeItemId ?? activeDocumentId ?? null);
      setCreateTargetKind(activeItemId ? 'item' : 'page');
      return;
    }
    setCreateTargetFolderId(resolveCollabCreateTargetFolderId(contextFolderId, selectedFolderId));
    setCreateTargetKind('page');
  }, [activeDocumentId, activeItemId, contextMenu, pageTree, selectedFolderId]);

  const openCreateFolderDialog = useCallback(() => {
    applyCreationBaseTarget();
    setIsCreateFolderOpen(true);
    setContextMenu(null);
  }, [applyCreationBaseTarget]);

  const openCreateDocumentMenu = useCallback((reference: HTMLElement) => {
    applyCreationBaseTarget();
    newDocumentMenu.refs.setReference(reference);
    newDocumentMenu.setIsOpen(true);
    setContextMenu(null);
  }, [applyCreationBaseTarget, newDocumentMenu.refs, newDocumentMenu.setIsOpen]);

  // Handlers via ref, effect keyed on a content signature. Depending on the
  // callbacks directly republishes on every render, and the host turns that
  // into a re-render, which loops.
  const createHandlersRef = useRef({ applyCreationBaseTarget, openCreateFolderDialog });
  createHandlersRef.current = { applyCreationBaseTarget, openCreateFolderDialog };

  const sharedTypeSignature = sharedNewDocumentMenuItems
    .map(({ descriptor }) => `${descriptor.documentType}:${descriptor.defaultExtension}`)
    .join('|');

  useEffect(() => {
    if (!registerCreateMenu) return undefined;

    const markdown = sharedNewDocumentMenuItems.find(
      ({ descriptor }) => descriptor.documentType === 'markdown'
    );

    registerCreateMenu({
      destination: selectedFolderPath,
      primaryTrailing: markdown?.descriptor.defaultExtension,
      onPrimary: () => {
        createHandlersRef.current.applyCreationBaseTarget();
        if (markdown) setCreateDocumentDescriptor(markdown.descriptor);
      },
      onNewFolder: () => createHandlersRef.current.openCreateFolderDialog(),
      pageTree,
      // Markdown is the primary action, so it is not repeated in the list.
      items: sharedNewDocumentMenuItems
        .filter(({ descriptor }) => descriptor.documentType !== 'markdown')
        .map(({ descriptor }) => ({
          id: `${descriptor.documentType}:${descriptor.defaultExtension}`,
          label: descriptor.displayName,
          icon: descriptor.icon,
          trailing: descriptor.defaultExtension,
          onSelect: () => {
            createHandlersRef.current.applyCreationBaseTarget();
            setCreateDocumentDescriptor(descriptor);
          },
        })),
    });
    return () => registerCreateMenu(null);
    // sharedNewDocumentMenuItems is read through its signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerCreateMenu, sharedTypeSignature, selectedFolderPath, pageTree]);

  const selectCreateDocumentType = useCallback((descriptor: CollabDocumentTypeDescriptor) => {
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
      showWarning('Name already in use', `A document or folder named "${nextPath}" already exists.`);
      return;
    }

    const folderId = await session.createFolder(name, parentId);
    host.trackEvent?.('collab_folder_created', {
      actorType: 'user',
      source: 'sidebar',
      nested: parentId !== null,
    });
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
  }, [canMutateMetadata, createTargetFolderId, existingPaths, folderPathById, host, session, showWarning]);

  const changeCreateTarget = useCallback((parentId: string | null, parentKind: SharedParentKind = 'page') => {
    setCreateTargetFolderId(parentId);
    setCreateTargetKind(parentKind);
  }, []);

  const handleCreateDocument = useCallback(async (documentName: string) => {
    if (!canMutateMetadata('create documents')) return;
    const descriptor = createDocumentDescriptor;
    if (!descriptor) return;
    const parentId = createTargetFolderId;
    const insideItem = parentId !== null && createTargetKind === 'item';
    const parentPath = insideItem ? `item:${parentId}` : parentId ? (folderPathById.get(parentId) ?? '') : '';
    try {
      await session.createDocument({
        scope,
        descriptor,
        requestedName: documentName,
        parentFolderId: parentId,
        ...(insideItem ? { parentKind: 'item' as const } : {}),
        sourceContent: descriptor.creation?.defaultContent ?? '',
      });
    } catch (error) {
      host.reportError?.(error, 'Could not create shared document');
      return;
    }

    if (parentPath) {
      setExpandedFolders((currentFolders) => {
        const next = new Set(currentFolders);
        next.add(parentPath);
        return next;
      });
    }

    setSelectedFolderPath(insideItem ? null : parentPath || null);
    setSelectedFolderId(insideItem ? null : parentId);
    setCreateDocumentDescriptor(null);
    setCreateTargetKind('page');
    setContextMenu(null);
  }, [canMutateMetadata, createDocumentDescriptor, createTargetFolderId, createTargetKind, folderPathById, host, scope, session]);

  const handleRenameDocument = useCallback(async (documentName: string) => {
    if (!documentToRename) return;
    if (!canMutateMetadata('rename this document')) return;

    const requestedName = getCollabNodeName(documentName.trim()) || documentName.trim();
    const name = applySharedDocumentRenameSuffix(requestedName, documentRenameParts.suffix);
    if (!name) { setDocumentToRename(null); setContextMenu(null); return; }

    if (pageTree) {
      // A page stores its bare name; a markdown page has no ".md".
      const bare = pageDisplayName(name, documentToRename.documentType);
      if (bare === documentToRename.title) {
        setDocumentToRename(null);
        setContextMenu(null);
        return;
      }
      if (pageTreeBuilder?.pageNameConflict(tree, documentToRename, documentToRename.parentFolderId ?? null, documentToRename.parentKind, bare)) {
        showWarning('Name already in use', `A page named "${bare}" already exists here.`);
        return;
      }
      await session.updateDocumentTitle(documentToRename.documentId, bare);
      trackDocumentAction(host, { action: 'renamed', documentType: documentToRename.documentType, entryPoint: 'sidebar' });
      setDocumentToRename(null);
      setContextMenu(null);
      return;
    }

    // Dual-write: rebuild the full-path title from the doc's parent folder so
    // un-upgraded clients keep the doc under the right folder.
    const parentId = documentToRename.parentFolderId ?? null;
    const parentPath = parentId ? (folderPathById.get(parentId) ?? '') : '';
    const nextPath = joinCollabPath(parentPath, name);
    const currentPath = locationOf(documentToRename);
    if (!nextPath || nextPath === currentPath) {
      setDocumentToRename(null);
      setContextMenu(null);
      return;
    }
    if (existingPaths.has(nextPath)) {
      showWarning('Name already in use', `A document or folder named "${nextPath}" already exists.`);
      return;
    }

    await session.updateDocumentTitle(documentToRename.documentId, nextPath);
    trackDocumentAction(host, {
      action: 'renamed',
      documentType: documentToRename.documentType,
      entryPoint: 'sidebar',
    });
    setDocumentToRename(null);
    setContextMenu(null);
  }, [canMutateMetadata, documentRenameParts.suffix, documentToRename, existingPaths, folderPathById, host, pageTree, pageTreeBuilder, session, showWarning, locationOf, tree]);

  // Reparent a document. In a page tree only the parent and order change; in
  // a folder tree the title is dual-written as the full path so clients that
  // predate first-class folders keep the tree.
  const relocateDocument = useCallback(async (
    moved: { documentId: string; sourcePath: string; name: string },
    targetFolderId: string | null,
    targetFolderPath: string | null,
    options: CollabPageMoveOptions = {},
  ) => {
    if (!canMutateMetadata('move this document')) return;
    const movedDocument = allSharedDocuments.find((document) => document.documentId === moved.documentId);
    if (pageTree && movedDocument && pageTreeBuilder) {
      // Pages store bare names: a move changes the parent and order, nothing else.
      const result = pageTreeBuilder.movePageInTree(session, tree, movedDocument, targetFolderId, options);
      if (result === 'taken') showWarning('Name already in use', `A page named "${pageDisplayName(movedDocument.title, movedDocument.documentType)}" already exists there.`);
      if (result === 'cycle') showWarning('Cannot move page', CYCLE_WARNING);
      if (result !== 'moved') return;
      trackDocumentAction(host, { action: 'moved', documentType: movedDocument.documentType, entryPoint: 'sidebar' });
      if (targetFolderPath) setExpandedFolders((currentFolders) => new Set(currentFolders).add(targetFolderPath));
      return;
    }
    const nextPath = joinCollabPath(targetFolderPath, moved.name);
    if (!nextPath || nextPath === moved.sourcePath) return;
    if (existingPaths.has(nextPath)) {
      showWarning('Name already in use', `A document or folder named "${nextPath}" already exists.`);
      return;
    }
    session.moveDocument(moved.documentId, targetFolderId);
    await session.updateDocumentTitle(moved.documentId, nextPath);
    trackDocumentAction(host, {
      action: 'moved',
      documentType: movedDocument?.documentType,
      entryPoint: 'sidebar',
    });

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
  }, [allSharedDocuments, canMutateMetadata, existingPaths, host, pageTree, pageTreeBuilder, session, showWarning, tree]);

  const moveDraggedDocument = useCallback(async (targetFolderId: string | null, targetFolderPath: string | null) => {
    const moved = draggedDocument;
    setDropTargetPath(null);
    setDraggedDocument(null);
    if (moved) await relocateDocument(moved, targetFolderId, targetFolderPath);
  }, [draggedDocument, relocateDocument]);

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
    session.moveFolder(draggedFolder.folderId, targetFolderId);
    host.trackEvent?.('collab_folder_moved', {
      actorType: 'user',
      source: 'sidebar',
      toRoot: targetFolderId === null,
    });
    if (targetFolderPath) {
      setExpandedFolders((currentFolders) => new Set(currentFolders).add(targetFolderPath));
    }
    setDropTargetPath(null);
    setDraggedFolder(null);
  }, [canDropFolder, canMutateMetadata, draggedFolder, host, session]);

  // Placed types: one placement per type. Moving or removing a placement never
  // touches the type or its items.
  const canDropType = useCallback((targetFolderId: string | null): boolean => {
    if (!draggedType) return false;
    const placement = typePlacements.find((candidate) => candidate.typeId === draggedType);
    return !!placement && (placement.parentFolderId ?? null) !== targetFolderId;
  }, [draggedType, typePlacements]);

  const moveDraggedType = useCallback((targetFolderId: string | null, targetFolderPath: string | null) => {
    const typeId = draggedType;
    setDropTargetPath(null);
    setDraggedType(null);
    if (!typeId || !canMutateMetadata('move this type')) return;
    session.moveTypePlacement(typeId, targetFolderId).catch(reportTypePlacementError);
    if (targetFolderPath) {
      setExpandedFolders((currentFolders) => new Set(currentFolders).add(targetFolderPath));
    }
  }, [canMutateMetadata, draggedType, reportTypePlacementError, session]);

  const handlePlaceType = useCallback((typeId: string) => {
    const parentFolderId = placeTypeMenu?.parentFolderId ?? null;
    const parentKind = placeTypeMenu?.parentKind;
    setPlaceTypeMenu(null);
    if (!canMutateMetadata('place this type')) return;
    session.placeType(typeId, parentFolderId, parentKind).catch(reportTypePlacementError);
    // Pages expand by path, typed pages by row id.
    const parentPath = parentFolderId
      ? (parentKind === 'item' ? `item:${parentFolderId}` : folderPathById.get(parentFolderId))
      : null;
    setUserTouchedExpansion(true);
    setExpandedFolders((currentFolders) => {
      const next = new Set(currentFolders).add(`type:${typeId}`);
      if (parentPath) next.add(parentPath);
      return next;
    });
  }, [canMutateMetadata, folderPathById, placeTypeMenu, reportTypePlacementError, session]);

  // Page tree: a typed page goes under a page or typed page, at root, or back
  // under its type -- never inside itself (checked on every path).
  const moveItemTo = useCallback((itemId: string, destination: PageTreeDestination) => {
    if (!canMutateMetadata('move this page')) return;
    const outcome = pageTreeBuilder?.moveItemInTree(session, tree, itemId, destination);
    if (outcome === 'cycle') showWarning('Cannot move page', CYCLE_WARNING);
    else void outcome?.then((result) => {
      if (!result.ok) reportTypePlacementError(new Error(result.error));
    });
  }, [canMutateMetadata, pageTreeBuilder, reportTypePlacementError, session, showWarning, tree]);

  const itemPlacementParent = useCallback((itemId: string): CollabPageMoveTarget => {
    const placement = itemPlacements.find((candidate) => candidate.itemId === itemId);
    return placement ? (placement.parentId ?? null) : UNDER_TYPE;
  }, [itemPlacements]);

  // Page tree drops onto a page row (or root, with a null page id).
  const canDropOnPage = useCallback((pageId: string | null, pagePath: string | null): boolean => {
    if (draggedType) return canDropType(pageId);
    if (draggedItem) return itemPlacementParent(draggedItem.itemId) !== pageId;
    if (!draggedDocument) return false;
    if (pageId && collectPageSubtree(sharedDocuments, draggedDocument.documentId).includes(pageId)) return false;
    return canDropDocument(pagePath);
  }, [canDropDocument, canDropType, draggedDocument, draggedItem, draggedType, itemPlacementParent, sharedDocuments]);

  const dropOnPage = useCallback((pageId: string | null, pagePath: string | null) => {
    if (draggedType) {
      moveDraggedType(pageId, pagePath);
      return;
    }
    const item = draggedItem;
    setDraggedItem(null);
    setDropTargetPath(null);
    if (item) {
      moveItemTo(item.itemId, { parentId: pageId, parentKind: 'page' });
      if (pagePath) setExpandedFolders((currentFolders) => new Set(currentFolders).add(pagePath));
      return;
    }
    void moveDraggedDocument(pageId, pagePath);
  }, [draggedItem, draggedType, moveDraggedDocument, moveDraggedType, moveItemTo]);

  const applyTreeWrite = useCallback((write: PageTreeWrite) => {
    pageTreeBuilder?.applyPageTreeWrite(session, write, reportTypePlacementError);
  }, [pageTreeBuilder, reportTypePlacementError, session]);

  const clearRowDrag = useCallback(() => {
    setDraggedType(null);
    setDraggedItem(null);
    setDraggedDocument(null);
    setDropTargetPath(null);
    setDropIndicator(null);
  }, []);

  const onDropPlan = useCallback((plan: PageTreeDropPlan, zone: string, node: CollabTreeNode) => {
    clearRowDrag();
    if (plan.kind === 'unplace-item') {
      moveItemTo(plan.itemId, { underType: true });
      return;
    }
    if (!canMutateMetadata(plan.kind === 'type' ? 'move this type' : 'move this page')) return;
    // Re-spaced siblings first, so the moved row never shares a key with one.
    for (const write of plan.renumber ?? []) applyTreeWrite(write);
    if (plan.kind === 'page') {
      const moved = allSharedDocuments.find((document) => document.documentId === plan.documentId);
      void relocateDocument(
        { documentId: plan.documentId, sourcePath: moved ? locationOf(moved) : '', name: moved?.title ?? '' },
        plan.parentId,
        null,
        { parentKind: plan.parentKind, sortOrder: plan.sortOrder },
      );
    } else {
      applyTreeWrite(plan);
    }
    // Rows expand by path; typed pages by row id.
    if (zone === 'inside') setExpandedFolders((current) => new Set(current).add(node.type === 'item' ? node.id : node.path));
  }, [allSharedDocuments, applyTreeWrite, canMutateMetadata, clearRowDrag, moveItemTo, locationOf, relocateDocument]);

  // Page tree rows as drop targets; the handlers load with the page tree.
  const rowDrop = useCallback((node: CollabTreeNode): CollabRowDrop => (pageTreeBuilder
    ? pageTreeBuilder.pageTreeRowDrop({
      tree,
      dragged: draggedType ? { kind: 'type', typeId: draggedType }
        : draggedItem ? { kind: 'item', itemId: draggedItem.itemId, typeId: draggedItem.typeId }
          : draggedDocument ? { kind: 'page', documentId: draggedDocument.documentId }
            : null,
      documents: allSharedDocuments,
      dropIndicator,
      dropTargetPath,
      setDropIndicator,
      setDropTargetPath,
      onDropPlan,
    }, node)
    : NO_ROW_DROP), [allSharedDocuments, draggedDocument, draggedItem, draggedType, dropIndicator, dropTargetPath, onDropPlan, pageTreeBuilder, tree]);

  // Typed pages hold children too; they render through `renderTree` (via the
  // ref, which is defined below and depends on these actions).
  const renderTreeRef = useRef<(nodes: CollabTreeNode[], depth?: number) => React.ReactNode>(() => null);
  const itemRowActions = useMemo(() => (pageTree ? {
    onContextMenu: (event: React.MouseEvent, node: CollabTreeItemNode) => handleContextMenu(event, node),
    onDragStart: setDraggedItem,
    onDragEnd: clearRowDrag,
    rowDrop,
    isExpanded: (node: CollabTreeItemNode) => expandedFolders.has(node.id),
    onToggle: (node: CollabTreeItemNode) => toggleFolder(node.id),
    renderChildren: (nodes: CollabTreeNode[], childIndent: number) => renderTreeRef.current(nodes, (childIndent - 8) / 16),
  } : undefined), [clearRowDrag, expandedFolders, handleContextMenu, pageTree, rowDrop, toggleFolder]);

  const renderTree = useCallback((nodes: CollabTreeNode[], depth = 0): React.ReactNode => {
    return nodes.map((node) => {
      const indent = depth * 16 + 8;

      // Under a type, the type node renders its items; a placed one is a page.
      if (node.type === 'item') {
        return pageTree ? (
          <CollabTypeItemRow
            key={node.id}
            node={node}
            position={0}
            indent={indent}
            onOpen={(options) => host.openArtifact({ kind: 'tracker', scope, trackerId: node.itemId }, 'sidebar', options)}
            actions={itemRowActions}
          />
        ) : null;
      }

      if (node.type === 'type') {
        return (
          <CollabTypeTreeBranch
            key={node.id}
            node={node}
            indent={indent}
            expanded={expandedFolders.has(node.id)}
            onToggle={() => toggleFolder(node.id)}
            onOpenType={(typeId, options) => host.openArtifact({ kind: 'type', scope, typeId }, 'sidebar', options)}
            onOpenItem={(trackerId, options) => host.openArtifact({ kind: 'tracker', scope, trackerId }, 'sidebar', options)}
            onContextMenu={(event) => handleContextMenu(event, node)}
            onDragStart={setDraggedType}
            onDragEnd={clearRowDrag}
            renderSubtypes={(subtypes) => renderTree(subtypes, depth + 1)}
            itemActions={itemRowActions}
          />
        );
      }

      if (node.type === 'folder') {
        const isExpanded = expandedFolders.has(node.path);
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
                toggleFolder(node.path);
                setSelectedFolderPath(node.path);
                setSelectedFolderId(node.folderId ?? null);
                onSelectFolder?.(node.folderId ?? null);
              }}
              onContextMenu={(event) => handleContextMenu(event, node)}
              onDragOver={(event) => {
                const accepts = draggedType
                  ? !!node.folderId && canDropType(node.folderId)
                  : draggedFolder
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
                if (draggedType) {
                  if (!node.folderId || !canDropType(node.folderId)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  moveDraggedType(node.folderId, node.path);
                  return;
                }
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
      const typePresentation = resolveSharedDocumentTypePresentation(node.document, documentTypeDescriptors);
      // Page tree: a page with children expands like a folder and takes drops.
      const hasChildren = (node.children?.length ?? 0) > 0;
      const isPageExpanded = hasChildren && expandedFolders.has(node.path);
      const { className: dropClassName = '', ...pageDropProps } = pageTree ? rowDrop(node) : {};

      const row = (
        <SharedDocumentLink
          href={host.surface === 'web_console' ? host.artifactUrl?.({ kind: 'document', scope, documentId: node.document.documentId, teamProjectId: node.document.teamProjectId }) : null}
          key={node.id}
          className={`group w-full flex items-center text-left file-tree-file${isActive ? ' active' : ''}${dropClassName}`}
          style={{ paddingLeft: indent }}
          {...pageDropProps}
          onClick={(event) => {
            setSelectedFolderPath(getCollabParentPath(node.path));
            host.openArtifact({
              kind: 'document',
              scope,
              documentId: node.document.documentId,
              teamProjectId: node.document.teamProjectId,
            }, 'sidebar', collabOpenOptions(event));
          }}
          onContextMenu={(event) => handleContextMenu(event, node)}
          draggable
          onDragStart={(event) => {
            // `copyMove`, not `move`: the folder drop targets below still ask
            // for `move` explicitly, while a surface that only *references* a
            // document (a project canvas) asks for `copy` and would otherwise
            // have its drop refused outright.
            event.dataTransfer.effectAllowed = 'copyMove';
            event.dataTransfer.setData('text/plain', node.document.documentId);
            // A second, self-describing payload for anything outside this tree.
            // `text/plain` alone is a bare id: no org to address it in, and no
            // title, so a card built from it would be labelled with a UUID.
            event.dataTransfer.setData(
              COLLAB_DOCUMENT_DRAG_TYPE,
              JSON.stringify({
                orgId: scope.orgId,
                documentId: node.document.documentId,
                title: node.name,
              } satisfies CollabDocumentDragPayload),
            );
            setDraggedDocument({
              documentId: node.document.documentId,
              sourcePath: node.path,
              name: node.name,
            });
          }}
          onDragEnd={clearRowDrag}
          title={node.path}
        >
          {hasChildren ? (
            <span
              className="file-tree-chevron"
              role="button"
              aria-label={isPageExpanded ? 'Collapse' : 'Expand'}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleFolder(node.path);
              }}
            >
              <MaterialSymbol icon={isPageExpanded ? 'keyboard_arrow_down' : 'keyboard_arrow_right'} size={16} />
            </span>
          ) : <span className="file-tree-spacer" />}
          <span className="file-tree-icon">
            {/* A page that holds pages but was never written (a converted folder) reads as a folder. */}
            {hasChildren && node.document.hasContent === false
              ? <MaterialSymbol icon={isPageExpanded ? 'folder_open' : 'folder'} size={18} />
              : <MaterialSymbol icon={typePresentation.icon} size={16} />}
          </span>
          <span className="file-tree-name">{pageTree ? pageDisplayName(node.name, node.document.documentType) : node.name}</span>
          {personalStateAvailable && (
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
                event.preventDefault();
                event.stopPropagation();
                session.toggleFavorite(node.document.documentId);
              }}
            >
              <MaterialSymbol icon="star" size={14} fill={isFavorite} />
            </span>
          )}
          {readReceiptsAvailable && showUnreadBubbles && (
            <DocUnreadDot documentId={node.document.documentId} className="mr-1" />
          )}
        </SharedDocumentLink>
      );
      if (!hasChildren) return row;
      return (
        <div key={node.id}>
          {row}
          {isPageExpanded ? renderTree(node.children ?? [], depth + 1) : null}
        </div>
      );
    });
  }, [
    pageTree,
    itemRowActions,
    rowDrop,
    clearRowDrag,
    activeDocumentId,
    canDropDocument,
    canDropFolder,
    canDropType,
    draggedFolder,
    draggedType,
    moveDraggedType,
    dropTargetPath,
    expandedFolders,
    handleContextMenu,
    moveDraggedDocument,
    moveDraggedFolder,
    selectedFolderPath,
    toggleFolder,
    favoriteSet,
    personalStateAvailable,
    readReceiptsAvailable,
    showUnreadBubbles,
    documentTypesRevision,
    documentTypeDescriptors,
    host,
    session,
    scope,
  ]);
  renderTreeRef.current = renderTree;

  const selectedFolderLabel = selectedFolderPath ? getCollabNodeName(selectedFolderPath) : 'Wiki';
  const contextDocument = contextMenu?.node.type === 'document' ? contextMenu.node.document : null;
  const useLocalOrigin = controller.useLocalOrigin ?? useUnavailableLocalOrigin;
  const contextLocalOrigin = useLocalOrigin(
    scope.scopeKey,
    contextDocument?.documentId,
    contextDocument?.documentType,
  );

  const headerActionButtons = (
    <>
      {headerActions}
      {/* New document / New folder moved to the host's title-bar create
          control, which sits directly over this tree. The folder context
          menu still covers "create here". */}
      {readReceiptsAvailable && (
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
      )}
    </>
  );

  const sectionLabel = sectionTitle ? (
    <>
      <h3 className="collab-sidebar-section-title m-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-muted)]">
        {sectionTitle}
      </h3>
      <span className="text-[11px] text-[var(--nim-text-faint)] whitespace-nowrap">
        <TeamSyncStatusLabel status={teamSyncStatus} personal={personal} />
      </span>
    </>
  ) : null;
  const openSectionMenu = (event: React.MouseEvent) => {
    if (!scopeAvailable) return;
    event.preventDefault();
    setContextMenu(null);
    setSectionMenu({ x: event.clientX, y: event.clientY });
  };
  const sectionMenuElement = sectionMenu && (
    <CollabSectionMenu
      x={sectionMenu.x}
      y={sectionMenu.y}
      onNewPage={() => startNewPage(null)}
      onPlaceType={typeResolver ? () => {
        setSectionMenu(null);
        if (collapsed) onToggleCollapsed?.();
        setPlaceTypeMenu({ ...sectionMenu, parentFolderId: null });
      } : undefined}
      extraItems={extraSectionMenuItems}
      onClose={() => setSectionMenu(null)}
    />
  );
  const sectionHeader = sectionTitle ? (
    <div
      className="collab-sidebar-section-header flex items-center gap-2 px-3 pt-2 pb-1.5 border-b border-[var(--nim-border)] shrink-0"
      data-testid={`collab-sidebar-section-${personal ? 'personal' : 'team'}`}
      onContextMenu={openSectionMenu}
    >
      {onToggleCollapsed ? (
        <button
          type="button"
          className="collab-sidebar-section-toggle flex items-center gap-2 min-w-0 -ml-1 pl-0.5 pr-1 py-0 bg-transparent border-none rounded cursor-pointer hover:bg-[var(--nim-bg-hover)]"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <MaterialSymbol icon={collapsed ? 'chevron_right' : 'expand_more'} size={16} className="text-[var(--nim-text-faint)]" />
          {sectionLabel}
        </button>
      ) : sectionLabel}
      {/* Collapsed drops the actions too: the overflow menu renders with the tree. */}
      {!collapsed && <div className="ml-auto flex items-center gap-1">{headerActionButtons}</div>}
    </div>
  ) : null;

  if (sectionHeader && collapsed) {
    return (
      <div
        className="collab-sidebar collab-sidebar-collapsed w-full flex flex-col bg-nim-secondary border-r border-nim"
        data-testid={personal ? 'collab-sidebar-personal' : 'collab-sidebar'}
      >
        {sectionHeader}
        {sectionMenuElement}
      </div>
    );
  }

  return (
    <div
      className="collab-sidebar w-full h-full flex flex-col bg-nim-secondary border-r border-nim overflow-hidden"
      data-testid={personal ? 'collab-sidebar-personal' : 'collab-sidebar'}
    >
      {sectionHeader ?? (
        <ScopeSummaryHeader
          scopeKey={scope.scopeKey}
          scopeName={scopeName}
          scopePath={scopePath}
          subtitle={<TeamSyncStatusLabel status={teamSyncStatus} personal={personal} />}
          actionsClassName="gap-1"
          actions={headerActionButtons}
        />
      )}

      {treeSegments.length > 1 && (
      <div className="collab-tree-filter px-3 py-2 border-b border-[var(--nim-border)] shrink-0">
        <div className="flex bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md p-0.5">
          {treeSegments.map((seg) => {
            const active = effectiveTreeFilter === seg.key;
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
                onClick={() => store.set(session.atoms.treeFilter, seg.key)}
              >
                {seg.icon && (
                  <MaterialSymbol
                    icon={seg.icon}
                    size={13}
                    fill={seg.key === 'favorites' && active}
                    className={active ? 'text-[var(--nim-warning)]' : undefined}
                  />
                )}
                {seg.label}
              </button>
            );
          })}
        </div>
      </div>
      )}

      {/* Document tree */}
      <div
        className={`collab-sidebar-tree flex-1 overflow-y-auto px-1.5 py-2 transition-colors ${dropTargetPath === '__root__' ? 'bg-nim-hover' : ''}`}
        onContextMenu={(event) => {
          // Empty space in the tree is the section root.
          if ((event.target as HTMLElement).closest('.file-tree-directory, .file-tree-file')) return;
          openSectionMenu(event);
        }}
        onDragOver={(event) => {
          const accepts = pageTree
            ? canDropOnPage(null, null)
            : draggedType
              ? canDropType(null)
              : draggedFolder ? canDropFolder(null) : canDropDocument(null);
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
          if (pageTree) {
            if (!canDropOnPage(null, null)) return;
            event.preventDefault();
            dropOnPage(null, null);
            return;
          }
          if (draggedType) {
            if (!canDropType(null)) return;
            event.preventDefault();
            moveDraggedType(null, null);
            return;
          }
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
        {sectionEntries}
        {(() => {
          // Loading: still resolving workspace state, or team sync is mid-
          // handshake. Render a skeleton instead of an empty/folders-only
          // tree so users don't think their docs disappeared.
          const isResolvingSync =
            teamSyncStatus === 'connecting' || teamSyncStatus === 'syncing';
          if (!hasLoadedState || isResolvingSync || (pageTree && !pageTreeBuilder)) {
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
          const emptyReason = tree.length === 0
            ? 'empty'
            : displayTree.length > 0 || effectiveTreeFilter === 'all' ? null : effectiveTreeFilter;
          if (emptyReason) {
            return (
              <CollabTreeEmptyState
                reason={emptyReason}
                personal={personal}
                scopeAvailable={scopeAvailable}
                onNewPage={markdownDescriptor ? () => startNewPage(null) : undefined}
              />
            );
          }
          return <CollabTreeActiveContext.Provider value={activeRow}><div>{renderTree(displayTree)}</div></CollabTreeActiveContext.Provider>;
        })()}
      </div>
      {scopeAvailable && <CollabSidebarTrashEntry sectionLabel={sectionTitle ?? (personal ? 'Personal' : 'Team')} />}

      {/* Header overflow menu: unread-bubble visibility + mark all read */}
      {readReceiptsAvailable && overflowMenu.isOpen && (
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
              onClick={() => store.set(session.atoms.showUnreadBubbles, !showUnreadBubbles)}
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
          <React.Suspense fallback={null}>
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
              {typeResolver && <button
                type="button"
                className="collab-place-type-action w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!contextMenu.node.folderId}
                onClick={() => {
                  if (contextMenu.node.type !== 'folder' || !contextMenu.node.folderId) return;
                  setPlaceTypeMenu({ x: contextMenu.x, y: contextMenu.y, parentFolderId: contextMenu.node.folderId });
                  setContextMenu(null);
                }}
              >
                <MaterialSymbol icon="table" size={18} />
                <span>Place type...</span>
              </button>}
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
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-[var(--nim-error)] hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!contextMenu.node.folderId}
                onClick={handleDelete}
              >
                <MaterialSymbol icon="delete" size={18} />
                <span>Delete</span>
              </button>
            </>
          ) : contextMenu.node.type === 'type' ? (
            <>
            {pageTree && (
              <CollabMenuButton
                className="collab-type-move-to"
                icon="drive_file_move"
                label="Move to..."
                // A subtype renders inside its placed base wherever it is placed.
                disabled={nestedTypeIds.has(contextMenu.node.typeId)}
                title={nestedTypeIds.has(contextMenu.node.typeId) ? 'Shown inside the type it extends' : undefined}
                onClick={() => {
                  if (contextMenu.node.type === 'type') setMoveTarget({ kind: 'type', node: contextMenu.node });
                  setContextMenu(null);
                }}
              />
            )}
            <button
              type="button"
              className="collab-remove-type-placement w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover"
              onClick={() => {
                if (contextMenu.node.type !== 'type') return;
                setContextMenu(null);
                removeTypeFromTree(contextMenu.node.typeId);
              }}
            >
              <MaterialSymbol icon="playlist_remove" size={18} />
              <span>Remove from tree</span>
            </button>
            {/* The type page's prose has a history of its own. */}
            <CollabPageHistoryEntry
              onClick={() => {
                if (contextMenu.node.type !== 'type') return;
                const { typeId } = contextMenu.node;
                setContextMenu(null);
                host.openArtifact({ kind: 'type', scope, typeId }, 'history');
              }}
            />
            </>
          ) : contextMenu.node.type === 'item' ? (
            <CollabItemMenu
              onNewPageInside={() => {
                if (contextMenu.node.type !== 'item') return;
                startNewPage(contextMenu.node.itemId, 'item');
              }}
              onPlaceType={typeResolver ? () => {
                if (contextMenu.node.type !== 'item') return;
                setPlaceTypeMenu({ x: contextMenu.x, y: contextMenu.y, parentFolderId: contextMenu.node.itemId, parentKind: 'item' });
                setContextMenu(null);
              } : undefined}
              placed={contextMenu.node.placed === true}
              onMoveTo={() => {
                if (contextMenu.node.type === 'item') setMoveTarget({ kind: 'item', node: contextMenu.node });
                setContextMenu(null);
              }}
              onBackUnderType={() => {
                if (contextMenu.node.type === 'item') moveItemTo(contextMenu.node.itemId, { underType: true });
                setContextMenu(null);
              }}
              onHistory={() => {
                if (contextMenu.node.type !== 'item') return;
                const { itemId } = contextMenu.node;
                setContextMenu(null);
                host.openArtifact({ kind: 'tracker', scope, trackerId: itemId }, 'history');
              }}
              onArchive={onArchiveItem ? () => {
                if (contextMenu.node.type !== 'item') return;
                const { itemId, name } = contextMenu.node;
                setContextMenu(null);
                void confirmDestructive(
                  'Archive page',
                  `Archive "${name}"? It leaves the Wiki and its type's table, with its comments and sessions kept. Restore it from its tracker's Archived view.`,
                  'Archive',
                ).then((accepted) => {
                  if (accepted) onArchiveItem(itemId).catch(reportTypePlacementError);
                });
              } : undefined}
            />
          ) : (
            <>
              {pageTree && contextDocument ? (
                <CollabPageMenuHead
                  onNewPageInside={() => startNewPage(contextDocument.documentId)}
                  onSetType={onSetPageType ? () => {
                    setContextMenu(null);
                    onSetPageType(contextDocument);
                  } : undefined}
                  onPlaceType={typeResolver ? () => {
                    setPlaceTypeMenu({ x: contextMenu.x, y: contextMenu.y, parentFolderId: contextDocument.documentId });
                    setContextMenu(null);
                  } : undefined}
                  onRename={() => {
                    setDocumentToRename(contextDocument);
                    setContextMenu(null);
                  }}
                  onMoveTo={() => {
                    setMoveTarget({ kind: 'page', document: contextDocument });
                    setContextMenu(null);
                  }}
                  onCopyLink={() => {
                    setContextMenu(null);
                    void handleCopyLink(contextDocument);
                  }}
                  copyLinkDisabled={!teamOrgId}
                />
              ) : <CollabMenuButton
                icon="open_in_new"
                label="Open"
                onClick={() => {
                  if (!contextDocument) return;
                  host.openArtifact({ kind: 'document', scope, documentId: contextDocument.documentId, teamProjectId: contextDocument.teamProjectId }, 'sidebar');
                  setContextMenu(null);
                }}
              />}
              {personalStateAvailable && contextDocument && <CollabMenuButton
                icon="star"
                fill={favoriteSet.has(contextDocument.documentId)}
                label={favoriteSet.has(contextDocument.documentId) ? 'Unfavorite' : 'Favorite'}
                onClick={() => {
                  handleToggleFavorite(contextDocument);
                  setContextMenu(null);
                }}
              />}
              {readReceiptsAvailable && <CollabMenuButton
                icon="mark_email_read"
                label="Mark as read"
                disabled={!teamOrgId || !contextDocument || !changedDocIds.has(contextDocument.documentId)}
                onClick={() => {
                  if (!contextDocument) return;
                  handleMarkDocRead(contextDocument);
                  setContextMenu(null);
                }}
              />}
              {!pageTree && <CollabMenuButton
                icon="link"
                label="Copy Link"
                disabled={!teamOrgId}
                title={teamOrgId ? undefined : 'No team is connected to this workspace'}
                onClick={() => {
                  if (!contextDocument) return;
                  setContextMenu(null);
                  void handleCopyLink(contextDocument);
                }}
              />}
              <CollabMenuButton
                icon="history"
                label="View History"
                disabled={!teamOrgId}
                title={teamOrgId ? undefined : 'No team is connected to this workspace'}
                onClick={() => {
                  if (!contextDocument || !teamOrgId) return;
                  setContextMenu(null);
                  host.openArtifact({ kind: 'document', scope, documentId: contextDocument.documentId, teamProjectId: contextDocument.teamProjectId }, 'history');
                }}
              />
              {/* Rename is a worker-backed metadata mutation, not a local-file
                  action. It lived inside the local-origin block because desktop
                  renames the mirrored file too, which silently removed Rename
                  from any host that omits the desktop-only controller. */}
              {!pageTree && <CollabMenuButton
                icon="edit"
                label="Rename"
                onClick={() => {
                  if (!contextDocument) return;
                  setDocumentToRename(contextDocument);
                  setContextMenu(null);
                }}
              />}
              {contextLocalOrigin.available ? <>
                <CollabMenuButton
                  icon="draft"
                  label="Open Local Source"
                  disabled={!contextLocalOrigin.hasResolvedBinding || contextLocalOrigin.busyAction !== null}
                  onClick={() => { setContextMenu(null); void contextLocalOrigin.openLocalSource(); }}
                />
                <CollabMenuButton
                  icon="upload"
                  label="Re-upload From Local"
                  disabled={!contextLocalOrigin.binding || contextLocalOrigin.busyAction !== null}
                  onClick={() => { setContextMenu(null); void contextLocalOrigin.reuploadFromLocalSource(); }}
                />
                <CollabMenuButton
                  icon="link"
                  label={contextLocalOrigin.binding ? 'Relink Local Source...' : 'Link Local Source...'}
                  disabled={contextLocalOrigin.busyAction !== null}
                  onClick={() => { setContextMenu(null); void contextLocalOrigin.relinkLocalSource(); }}
                />
                {contextLocalOrigin.binding && <CollabMenuButton
                  icon="link_off"
                  label="Clear Local Source"
                  disabled={contextLocalOrigin.busyAction !== null}
                  onClick={() => { setContextMenu(null); void contextLocalOrigin.clearLocalSource(); }}
                />}
              </> : null}
              {pageTree && contextDocument ? (
                <CollabPageDeleteEntry
                  childCount={planPageRemoval(allSharedDocuments, typePlacements, contextDocument.documentId).childCount}
                  onDelete={handleDelete}
                />
              ) : <CollabMenuButton icon="delete" danger label="Move to Trash" onClick={handleDelete} />}
            </>
          )}
          </React.Suspense>
          </div>
        </FloatingPortal>
      )}

      {moveTarget && (
        <React.Suspense fallback={null}>
          <CollabPageMoveDialog
            name={moveTarget.kind === 'page'
              ? pageDisplayName(moveTarget.document.title, moveTarget.document.documentType)
              : moveTarget.node.name}
            tree={tree}
            movingNodeId={moveTarget.kind === 'page' ? `document:${moveTarget.document.documentId}` : moveTarget.node.id}
            rootLabel={personal ? 'Personal' : 'Team'}
            underTypeLabel={moveTarget.kind === 'item'
              ? `Under ${typeResolver?.typeName(moveTarget.node.typeId) ?? 'its type'}`
              : undefined}
            onConfirm={(destination) => {
              const current = moveTarget;
              setMoveTarget(null);
              if (current.kind === 'item') {
                moveItemTo(current.node.itemId, destination);
                return;
              }
              if ('underType' in destination) return;
              const { parentId, parentKind } = destination;
              if (current.kind === 'type') {
                if (canMutateMetadata('move this type')) session.moveTypePlacement(current.node.typeId, parentId, undefined, parentKind).catch(reportTypePlacementError);
                return;
              }
              const { document } = current;
              void relocateDocument(
                { documentId: document.documentId, sourcePath: locationOf(document), name: document.title },
                parentId,
                null,
                { parentKind },
              );
            }}
            onCancel={() => setMoveTarget(null)}
          />
        </React.Suspense>
      )}

      {sectionMenuElement}
      {placeTypeMenu && (
        <CollabPlaceTypeMenu
          x={placeTypeMenu.x}
          y={placeTypeMenu.y}
          types={placeableTypes}
          onPlace={handlePlaceType}
          onClose={() => setPlaceTypeMenu(null)}
        />
      )}

      <CollabCreateItemDialog
        isOpen={createDocumentDescriptor !== null}
        kind="document"
        documentDescriptor={createDocumentDescriptor ?? undefined}
        folders={sharedFolders}
        tree={pageTree ? tree : undefined}
        documentTypeDescriptors={documentTypeDescriptors}
        rootLabel={pageTree ? (personal ? 'Personal' : 'Team') : undefined}
        targetFolderId={createTargetFolderId}
        targetParentKind={createTargetKind}
        onTargetFolderChange={changeCreateTarget}
        onConfirm={handleCreateDocument}
        onCancel={() => {
          setCreateDocumentDescriptor(null);
          setCreateTargetKind('page');
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
        defaultValue={documentRenameParts.baseName}
        // A markdown page reads without ".md"; the save still re-applies it.
        suffix={pageTree && documentToRename?.documentType === 'markdown' ? undefined : documentRenameParts.suffix}
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
