import {
  TYPE_PAGE_DOCUMENT_PREFIX,
  type SharedDocument,
  type SharedFolder,
  type SharedItemPlacement,
  type SharedTypePlacement,
} from './types';

export { TYPE_PAGE_DOCUMENT_PREFIX } from './types';

export interface CollabTreeFolderNode {
  id: string;
  type: 'folder';
  path: string;
  name: string;
  children: CollabTreeNode[];
  /**
   * First-class folder id, present when the tree was built from real folder
   * nodes (`buildCollabTreeFromFolders`). Absent for the legacy path-in-title
   * builder (`buildCollabTree`). Folder operations (rename/move/delete/link)
   * key off this id.
   */
  folderId?: string;
  /** The underlying folder node (first-class builder only). */
  folder?: SharedFolder;
}

export interface CollabTreeDocumentNode {
  id: string;
  type: 'document';
  path: string;
  name: string;
  document: SharedDocument;
  /** Child pages, types and placed items; only in a page tree. */
  children?: CollabTreeNode[];
}

/**
 * A tracker type placed in the tree. Its children are the type's items, after
 * any placed subtypes (types that `extends` it).
 */
export interface CollabTreeTypeNode {
  id: string;
  type: 'type';
  typeId: string;
  path: string;
  name: string;
  /** Number of items of this type (in a page tree, and of every type that extends it). */
  count: number;
  placement: SharedTypePlacement;
  /** Why the type's file did not load; the type is shown so the user can fix it. */
  error?: string;
  children: Array<CollabTreeTypeNode | CollabTreeItemNode>;
}

export interface CollabTreeItemNode {
  id: string;
  type: 'item';
  itemId: string;
  typeId: string;
  path: string;
  name: string;
  /** Singular type name shown faintly beside the row (page tree only). */
  typeLabel?: string;
  /** Why the item's type did not load (see `CollabTreeTypeNode.error`). */
  typeError?: string;
  /** True when the item has a tree placement of its own. */
  placed?: boolean;
  /** A placed item's placement order among its siblings. */
  sortOrder?: number;
  /** Child pages, types and typed pages; only in a page tree. */
  children?: CollabTreeNode[];
}

export type CollabTreeNode =
  | CollabTreeFolderNode
  | CollabTreeDocumentNode
  | CollabTreeTypeNode
  | CollabTreeItemNode;

/**
 * Host-supplied answers about tracker types and items. The tree stays pure: it
 * never reads a registry or a store itself.
 */
export interface CollabTypeTreeResolver {
  /** Display name of a type, or null when the type is unknown here. */
  typeName(typeId: string): string | null;
  /** Singular display name ("Module" for "Modules"); falls back to `typeName`. */
  typeLabel?(typeId: string): string | null;
  /** The type this one `extends`, if any. */
  typeExtends?(typeId: string): string | null;
  /** Why a type's file did not load; null for a type that loaded. */
  typeError?(typeId: string): string | null;
  /** Items of a type, in display order. */
  itemsOfType(typeId: string): Array<{ itemId: string; title: string; sortKey?: string | number }>;
  /** One item by id, for an item placed outside its type; null when unknown here. */
  item?(itemId: string): { itemId: string; title: string; typeId: string } | null;
  /**
   * Types a user may place, for the "Place type..." menu. `creatable: false`
   * marks a type that holds no new pages, which "Set type" does not offer.
   */
  listedTypes?(): Array<{ typeId: string; name: string; icon?: string; creatable?: boolean }>;
}

export interface CollabTypePlacementInput {
  placements: SharedTypePlacement[];
  resolver: CollabTypeTreeResolver;
}

export interface CollabFolderOption {
  folderId: string | null;
  name: string;
  depth: number;
}

/** Every folder id in the subtree rooted at `folderId`, including the root. */
export function collectFolderSubtree(folders: SharedFolder[], folderId: string): string[] {
  const childrenByParent = new Map<string | null, SharedFolder[]>();
  for (const folder of folders) {
    const parentId = folder.parentFolderId ?? null;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(folder);
    childrenByParent.set(parentId, children);
  }
  const result: string[] = [];
  const queue = [folderId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);
    for (const child of childrenByParent.get(id) ?? []) queue.push(child.folderId);
  }
  return result;
}

/** True when `candidateId` is `ancestorId` or is nested below it. */
export function isDescendantFolder(
  folders: SharedFolder[],
  candidateId: string,
  ancestorId: string,
): boolean {
  const byId = new Map(folders.map((folder) => [folder.folderId, folder]));
  let current: string | null | undefined = candidateId;
  const visited = new Set<string>();
  while (current) {
    if (current === ancestorId) return true;
    if (visited.has(current)) break;
    visited.add(current);
    current = byId.get(current)?.parentFolderId ?? null;
  }
  return false;
}

const compareFolderNames = (left: SharedFolder, right: SharedFolder): number => {
  const byName = left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  return byName || left.folderId.localeCompare(right.folderId);
};

/**
 * Build the Root-first location list used by the collab create dialog.
 * Missing parents are treated as root. A final visited-set pass keeps every
 * folder selectable even if corrupt data contains a parent cycle.
 */
export function flattenCollabFolderOptions(folders: SharedFolder[]): CollabFolderOption[] {
  const foldersById = new Map(folders.map(folder => [folder.folderId, folder]));
  const childrenByParentId = new Map<string | null, SharedFolder[]>();

  for (const folder of foldersById.values()) {
    const parentId = folder.parentFolderId ?? null;
    const effectiveParentId = parentId !== folder.folderId && foldersById.has(parentId ?? '')
      ? parentId
      : null;
    const siblings = childrenByParentId.get(effectiveParentId) ?? [];
    siblings.push(folder);
    childrenByParentId.set(effectiveParentId, siblings);
  }

  for (const siblings of childrenByParentId.values()) {
    siblings.sort(compareFolderNames);
  }

  const options: CollabFolderOption[] = [{ folderId: null, name: 'Root', depth: 0 }];
  const visited = new Set<string>();
  const appendFolder = (folder: SharedFolder, depth: number) => {
    if (visited.has(folder.folderId)) return;
    visited.add(folder.folderId);
    options.push({ folderId: folder.folderId, name: folder.name, depth });
    for (const child of childrenByParentId.get(folder.folderId) ?? []) {
      appendFolder(child, depth + 1);
    }
  };

  for (const rootFolder of childrenByParentId.get(null) ?? []) {
    appendFolder(rootFolder, 0);
  }

  for (const remainingFolder of [...foldersById.values()].sort(compareFolderNames)) {
    appendFolder(remainingFolder, 0);
  }

  return options;
}

/**
 * Resolve the create target when opening the dialog. `undefined` means there
 * is no folder context menu, while `null` is an explicit Root target (used by
 * legacy folder rows that have no first-class folder id).
 */
export function resolveCollabCreateTargetFolderId(
  contextFolderId: string | null | undefined,
  selectedFolderId: string | null | undefined,
): string | null {
  return contextFolderId === undefined ? (selectedFolderId ?? null) : contextFolderId;
}

export function normalizeCollabPath(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
    .join('/');
}

export function getCollabParentPath(path: string): string | null {
  const normalized = normalizeCollabPath(path);
  if (!normalized || !normalized.includes('/')) {
    return null;
  }

  const parts = normalized.split('/');
  parts.pop();
  return parts.join('/') || null;
}

export function getCollabNodeName(path: string): string {
  const normalized = normalizeCollabPath(path);
  if (!normalized) return '';
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

export function joinCollabPath(parentPath: string | null | undefined, name: string): string {
  const parent = normalizeCollabPath(parentPath);
  const child = normalizeCollabPath(name);
  if (!parent) return child;
  if (!child) return parent;
  return `${parent}/${child}`;
}

export function renameCollabDocumentPath(path: string, name: string): string {
  return joinCollabPath(getCollabParentPath(path), name);
}

export function getCollabDocumentPath(document: SharedDocument): string {
  return normalizeCollabPath(document.title || document.documentId);
}

export const UNRESOLVED_SHARED_DOCUMENT_NAME = 'Shared document';

/**
 * Resolve the user-facing path for a shared document without ever exposing its
 * transport id. First-class folder rows are authoritative; legacy documents
 * may still carry their path in `title`, so the title is retained when there
 * is no first-class parent.
 */
export function getSharedDocumentDisplayPath(
  document: Pick<SharedDocument, 'documentId' | 'title' | 'parentFolderId'>,
  folders: SharedFolder[],
): string {
  const normalizedTitle = normalizeCollabPath(document.title);
  const leafName = normalizedTitle && normalizedTitle !== document.documentId
    ? getCollabNodeName(normalizedTitle)
    : UNRESOLVED_SHARED_DOCUMENT_NAME;

  if (!document.parentFolderId) {
    return normalizedTitle && normalizedTitle !== document.documentId
      ? normalizedTitle
      : leafName;
  }

  const foldersById = new Map(folders.map(folder => [folder.folderId, folder]));
  const segments: string[] = [];
  const visited = new Set<string>();
  let current = foldersById.get(document.parentFolderId);
  if (!current && normalizedTitle.includes('/')) return normalizedTitle;
  while (current && !visited.has(current.folderId)) {
    visited.add(current.folderId);
    if (current.name.trim()) segments.unshift(current.name.trim());
    current = current.parentFolderId ? foldersById.get(current.parentFolderId) : undefined;
  }
  segments.push(leafName);
  return normalizeCollabPath(segments.join('/')) || UNRESOLVED_SHARED_DOCUMENT_NAME;
}

export function getSharedDocumentDisplayName(
  titleOrPath: string | null | undefined,
  documentId: string,
): string {
  const normalized = normalizeCollabPath(titleOrPath);
  if (!normalized || normalized === documentId) return UNRESOLVED_SHARED_DOCUMENT_NAME;
  return getCollabNodeName(normalized) || UNRESOLVED_SHARED_DOCUMENT_NAME;
}

export function reconcileSharedDocumentDisplayName(
  currentDisplayName: string | null | undefined,
  titleOrPath: string | null | undefined,
  documentId: string,
): string {
  const resolvedName = getSharedDocumentDisplayName(titleOrPath, documentId);
  if (resolvedName !== UNRESOLVED_SHARED_DOCUMENT_NAME) return resolvedName;

  const normalizedCurrent = normalizeCollabPath(currentDisplayName);
  if (!normalizedCurrent || normalizedCurrent === documentId) {
    return UNRESOLVED_SHARED_DOCUMENT_NAME;
  }
  return getCollabNodeName(normalizedCurrent) || UNRESOLVED_SHARED_DOCUMENT_NAME;
}

/**
 * Prefer fresh index metadata once it is complete, but never let a partial
 * sync replace a useful path restored with the tab's collaboration config.
 */
export function getSharedDocumentDisplayPathWithFallback(
  document: Pick<SharedDocument, 'documentId' | 'title' | 'parentFolderId'>,
  folders: SharedFolder[],
  fallbackPath: string | null | undefined,
): string {
  const normalizedFallback = normalizeCollabPath(fallbackPath);
  const safeFallback = normalizedFallback && normalizedFallback !== document.documentId
    ? normalizedFallback
    : UNRESOLVED_SHARED_DOCUMENT_NAME;
  const normalizedTitle = normalizeCollabPath(document.title);

  if (!normalizedTitle || normalizedTitle === document.documentId) return safeFallback;

  const parentIsPending = Boolean(
    document.parentFolderId
    && !folders.some(folder => folder.folderId === document.parentFolderId),
  );
  if (parentIsPending && !normalizedTitle.includes('/') && safeFallback !== UNRESOLVED_SHARED_DOCUMENT_NAME) {
    return safeFallback;
  }

  return getSharedDocumentDisplayPath(document, folders);
}

const TREE_NODE_RANK: Record<CollabTreeNode['type'], number> = {
  folder: 0,
  type: 1,
  document: 2,
  item: 3,
};

const treeNodeRank = (node: CollabTreeNode): number => TREE_NODE_RANK[node.type];

/** @internal Shared with `collabPageTree.ts`. */
export const compareTypeNodes = (left: CollabTreeTypeNode, right: CollabTreeTypeNode): number =>
  (left.placement.sortOrder - right.placement.sortOrder)
  || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  || left.typeId.localeCompare(right.typeId);

/**
 * Folders, then placed types (by sortOrder), then documents (by name), then
 * placed typed pages (by sortOrder): the order of a group nobody reordered.
 * @internal Shared with `collabPageTree.ts`.
 */
export function compareTreeNodes(left: CollabTreeNode, right: CollabTreeNode): number {
  const rank = treeNodeRank(left) - treeNodeRank(right);
  if (rank !== 0) return rank;
  if (left.type === 'type' && right.type === 'type') return compareTypeNodes(left, right);
  if (left.type === 'item' && right.type === 'item') {
    const order = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
    if (order !== 0) return order;
  }
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/** @internal Shared with `collabPageTree.ts`. */
export function sortTreeNodes(nodes: CollabTreeNode[]): CollabTreeNode[] {
  nodes.sort(compareTreeNodes);
  // A type node's children keep their built order: subtypes, then items in
  // the resolver's order.
  for (const node of nodes) {
    if (node.type === 'folder') sortTreeNodes(node.children);
    else if (node.type === 'document' && node.children) sortTreeNodes(node.children);
  }
  return nodes;
}

/**
 * Build type nodes from placements and attach them under their folder (or
 * root). A type whose `extends` chain reaches another placed type nests inside
 * that type's node instead. Placements the resolver cannot name are skipped.
 */
export type CollabTreeContainer = { path: string; children: CollabTreeNode[] };

/**
 * One node per resolvable placement, and the placed base each one nests in
 * (null when it sits by its own placement). A corrupt `extends` cycle between
 * placed types is broken by placing the node normally.
 * @internal Shared with `collabPageTree.ts`.
 */
export function createTypeNodes(
  placements: SharedTypePlacement[],
  resolver: CollabTypeTreeResolver,
): { nodes: Map<string, CollabTreeTypeNode>; parentType: Map<string, string | null> } {
  const nodes = new Map<string, CollabTreeTypeNode>();
  for (const placement of placements) {
    if (nodes.has(placement.typeId)) continue;
    const name = resolver.typeName(placement.typeId);
    if (!name) continue;
    const error = resolver.typeError?.(placement.typeId);
    nodes.set(placement.typeId, {
      id: `type:${placement.typeId}`,
      type: 'type',
      typeId: placement.typeId,
      path: '',
      name,
      count: resolver.itemsOfType(placement.typeId).length,
      placement,
      children: [],
      ...(error ? { error } : {}),
    });
  }

  const nearestPlacedBase = (typeId: string): string | null => {
    const seen = new Set([typeId]);
    let current = resolver.typeExtends?.(typeId) ?? null;
    while (current && !seen.has(current)) {
      if (nodes.has(current)) return current;
      seen.add(current);
      current = resolver.typeExtends?.(current) ?? null;
    }
    return null;
  };
  const parentType = new Map<string, string | null>();
  for (const typeId of nodes.keys()) parentType.set(typeId, nearestPlacedBase(typeId));
  // Corrupt `extends` cycles between placed types would hide every node in
  // the cycle; break them by placing the node normally.
  for (const typeId of nodes.keys()) {
    const seen = new Set<string>([typeId]);
    let current = parentType.get(typeId) ?? null;
    while (current) {
      if (seen.has(current)) {
        parentType.set(typeId, null);
        break;
      }
      seen.add(current);
      current = parentType.get(current) ?? null;
    }
  }
  return { nodes, parentType };
}

/** @internal Shared with `collabPageTree.ts`. */
export function attachTypeNodes(
  roots: CollabTreeNode[],
  folderNodeById: (folderId: string) => CollabTreeContainer | undefined,
  input: CollabTypePlacementInput | undefined,
): void {
  if (!input || input.placements.length === 0) return;
  const { resolver } = input;
  const { nodes, parentType } = createTypeNodes(input.placements, resolver);

  const subtypes = new Map<string, CollabTreeTypeNode[]>();
  for (const node of nodes.values()) {
    const base = parentType.get(node.typeId);
    if (base) {
      const list = subtypes.get(base) ?? [];
      list.push(node);
      subtypes.set(base, list);
      continue;
    }
    const folderId = node.placement.parentFolderId;
    const folder = folderId ? folderNodeById(folderId) : undefined;
    if (folder) folder.children.push(node);
    else roots.push(node);
  }

  const finalize = (node: CollabTreeTypeNode, parentPath: string) => {
    node.path = joinCollabPath(parentPath, node.name);
    const nested = (subtypes.get(node.typeId) ?? []).sort(compareTypeNodes);
    for (const child of nested) finalize(child, node.path);
    const items: CollabTreeItemNode[] = resolver.itemsOfType(node.typeId).map((item) => {
      const name = item.title || item.itemId;
      return {
        id: `item:${item.itemId}`,
        type: 'item',
        itemId: item.itemId,
        typeId: node.typeId,
        path: joinCollabPath(node.path, name),
        name,
        ...(node.error ? { typeError: node.error } : {}),
      };
    });
    node.children = [...nested, ...items];
  };
  for (const node of nodes.values()) {
    if (parentType.get(node.typeId)) continue;
    const folderId = node.placement.parentFolderId;
    const folder = folderId ? folderNodeById(folderId) : undefined;
    finalize(node, folder ? folder.path : '');
  }
}

export function buildCollabTree(
  documents: SharedDocument[],
  customFolders: string[],
  typePlacements?: CollabTypePlacementInput,
): CollabTreeNode[] {
  const folderMap = new Map<string, CollabTreeFolderNode>();
  const roots: CollabTreeNode[] = [];

  const pushToParent = (node: CollabTreeNode, parentPath: string | null) => {
    if (!parentPath) {
      roots.push(node);
      return;
    }

    const parent = ensureFolder(parentPath);
    parent.children.push(node);
  };

  const ensureFolder = (folderPath: string): CollabTreeFolderNode => {
    const normalizedPath = normalizeCollabPath(folderPath);
    const existing = folderMap.get(normalizedPath);
    if (existing) {
      return existing;
    }

    const folder: CollabTreeFolderNode = {
      id: `folder:${normalizedPath}`,
      type: 'folder',
      path: normalizedPath,
      name: getCollabNodeName(normalizedPath),
      children: [],
    };
    folderMap.set(normalizedPath, folder);
    pushToParent(folder, getCollabParentPath(normalizedPath));
    return folder;
  };

  for (const folderPath of customFolders) {
    const normalized = normalizeCollabPath(folderPath);
    if (!normalized) continue;
    ensureFolder(normalized);
  }

  for (const document of documents) {
    const documentPath = getCollabDocumentPath(document);
    if (!documentPath) continue;

    const parentPath = getCollabParentPath(documentPath);
    if (parentPath) {
      ensureFolder(parentPath);
    }

    const documentNode: CollabTreeDocumentNode = {
      id: `document:${document.documentId}`,
      type: 'document',
      path: documentPath,
      name: getCollabNodeName(documentPath),
      document,
    };
    pushToParent(documentNode, parentPath);
  }

  // Legacy folders have no folder id, so every placed type sits at root.
  attachTypeNodes(roots, () => undefined, typePlacements);

  return sortTreeNodes(roots);
}

/**
 * Build the collab tree from FIRST-CLASS folder nodes + each document's
 * `parentFolderId`, instead of splitting titles on '/'. Folder identity is the
 * stable `folderId`; `path` is a derived breadcrumb (parent path + name) kept
 * for search and display. A document's display name is the leaf of its title —
 * during the dual-write transition a title may still be a full path, so the
 * leaf is taken defensively (`getCollabNodeName`).
 *
 * Documents (or folders) whose `parentFolderId` points at a missing folder are
 * placed at root so nothing disappears if a parent is briefly out of sync.
 */
export function buildCollabTreeFromFolders(
  documents: SharedDocument[],
  folders: SharedFolder[],
  typePlacements?: CollabTypePlacementInput,
): CollabTreeNode[] {
  const foldersById = new Map(folders.map(f => [f.folderId, f]));
  const nodesById = new Map<string, CollabTreeFolderNode>();
  const roots: CollabTreeNode[] = [];

  // Derive a folder's breadcrumb path by walking its ancestor chain.
  const pathCache = new Map<string, string>();
  const folderPath = (folderId: string): string => {
    const cached = pathCache.get(folderId);
    if (cached !== undefined) return cached;
    const folder = foldersById.get(folderId);
    if (!folder) return '';
    const guard = new Set<string>();
    const segments: string[] = [];
    let current: SharedFolder | undefined = folder;
    while (current && !guard.has(current.folderId)) {
      guard.add(current.folderId);
      segments.unshift(current.name);
      current = current.parentFolderId ? foldersById.get(current.parentFolderId) : undefined;
    }
    const path = normalizeCollabPath(segments.join('/'));
    pathCache.set(folderId, path);
    return path;
  };

  // Materialize every folder node first so documents can attach to them.
  for (const folder of folders) {
    nodesById.set(folder.folderId, {
      id: `folder:${folder.folderId}`,
      type: 'folder',
      path: folderPath(folder.folderId),
      name: folder.name,
      children: [],
      folderId: folder.folderId,
      folder,
    });
  }

  // Parent folders into their parents (or root).
  for (const folder of folders) {
    const node = nodesById.get(folder.folderId)!;
    const parent = folder.parentFolderId ? nodesById.get(folder.parentFolderId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Attach documents.
  for (const document of documents) {
    const parentId = document.parentFolderId ?? null;
    const parent = parentId ? nodesById.get(parentId) : undefined;
    const leaf = getCollabNodeName(document.title) || document.title || document.documentId;
    const parentPath = parent ? parent.path : '';
    const documentNode: CollabTreeDocumentNode = {
      id: `document:${document.documentId}`,
      type: 'document',
      path: joinCollabPath(parentPath, leaf),
      name: leaf,
      document,
    };
    if (parent) parent.children.push(documentNode);
    else roots.push(documentNode);
  }

  attachTypeNodes(roots, (folderId) => nodesById.get(folderId), typePlacements);

  return sortTreeNodes(roots);
}

/**
 * Compute the document title rewrites needed to rename a LEGACY (path-in-title)
 * folder. Legacy folders have no first-class `folderId`; their identity is the
 * breadcrumb path, and their structure lives in each descendant document's
 * full-path title. Renaming such a folder swaps the folder's segment in every
 * descendant doc's title (dual-write friendly: un-upgraded clients keep the
 * structure, and it works whether or not first-class migration has run).
 *
 * Returns one `{ documentId, newTitle }` per affected document. Empty when the
 * new name is blank or unchanged.
 */
export function computeLegacyFolderRenameUpdates(
  documents: SharedDocument[],
  folderPath: string,
  newName: string,
): { documentId: string; newTitle: string }[] {
  const normalizedFolder = normalizeCollabPath(folderPath);
  const normalizedName = normalizeCollabPath(newName);
  if (!normalizedFolder || !normalizedName) return [];
  const parent = getCollabParentPath(normalizedFolder);
  const newFolderPath = joinCollabPath(parent, normalizedName);
  if (!newFolderPath || newFolderPath === normalizedFolder) return [];

  const prefix = `${normalizedFolder}/`;
  const updates: { documentId: string; newTitle: string }[] = [];
  for (const document of documents) {
    const path = getCollabDocumentPath(document);
    if (path.startsWith(prefix)) {
      updates.push({
        documentId: document.documentId,
        newTitle: newFolderPath + path.slice(normalizedFolder.length),
      });
    }
  }
  return updates;
}

/**
 * Choose the right tree builder so folders NEVER visually disappear during the
 * legacy -> first-class folder transition.
 *
 * The first-class builder (`buildCollabTreeFromFolders`) places any document
 * whose `parentFolderId` is null at ROOT. Legacy documents encode their folder
 * structure in the TITLE (`Specs/API Spec`) and still have a null
 * `parentFolderId` until the client-driven migration populates `folder_nodes`
 * on the server AND those rows round-trip back into `sharedFolders`. Until then,
 * building exclusively from first-class rows collapses every foldered doc to a
 * flat root list and the user's folders vanish.
 *
 * Fallback rule: if there are NO first-class folder rows yet but some document
 * still encodes a folder path in its title, render with the legacy path-in-title
 * builder. Otherwise use the first-class builder (which also handles the "no
 * folders, all root-level docs" case correctly). Once migration completes and
 * folder rows exist, we always use the first-class builder — so its
 * context-menu / drag / deep-link behavior (keyed off `folderId`) is preserved.
 */
export function buildCollabTreeAdaptive(
  documents: SharedDocument[],
  folders: SharedFolder[],
  typePlacements?: CollabTypePlacementInput,
): CollabTreeNode[] {
  if (folders.length === 0) {
    const hasPathInTitle = documents.some(
      doc => !doc.parentFolderId && getCollabParentPath(getCollabDocumentPath(doc)) !== null,
    );
    if (hasPathInTitle) {
      return buildCollabTree(documents, [], typePlacements);
    }
  }
  return buildCollabTreeFromFolders(documents, folders, typePlacements);
}

/**
 * Drop folder nodes that contain no documents (directly or transitively). Used
 * by the Favorites/Updated segments so an empty folder doesn't linger once its
 * only matching docs are filtered out. Folders with document descendants are
 * kept (with their empty sub-branches pruned).
 */
export function pruneEmptyFolders(nodes: CollabTreeNode[]): CollabTreeNode[] {
  const prune = (node: CollabTreeNode): CollabTreeNode | null => {
    // Type nodes are content in their own right, even with no items yet.
    if (node.type !== 'folder') return node;
    const children = node.children
      .map(prune)
      .filter((c): c is CollabTreeNode => c !== null);
    if (children.length === 0) return null;
    return { ...node, children };
  };
  return nodes.map(prune).filter((n): n is CollabTreeNode => n !== null);
}

export function filterCollabTree(nodes: CollabTreeNode[], query: string): CollabTreeNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return nodes;
  }

  const nodeMatchesQuery = (node: CollabTreeNode): boolean => {
    return node.path.toLocaleLowerCase().includes(normalizedQuery)
      || node.name.toLocaleLowerCase().includes(normalizedQuery);
  };

  const filterNode = (node: CollabTreeNode): CollabTreeNode | null => {
    if ((node.type === 'item' || node.type === 'document') && !node.children?.length) {
      return nodeMatchesQuery(node) ? node : null;
    }

    if (nodeMatchesQuery(node)) {
      return node;
    }

    if (node.type === 'type') {
      const filteredChildren = node.children
        .map(filterNode)
        .filter((child): child is CollabTreeTypeNode | CollabTreeItemNode =>
          child !== null && (child.type === 'type' || child.type === 'item'));
      return filteredChildren.length === 0 ? null : { ...node, children: filteredChildren };
    }

    const filteredChildren = (node.children ?? [])
      .map(filterNode)
      .filter((child): child is CollabTreeNode => child !== null);

    if (filteredChildren.length === 0) {
      return null;
    }

    return {
      ...node,
      children: filteredChildren,
    };
  };

  return nodes
    .map(filterNode)
    .filter((node): node is CollabTreeNode => node !== null);
}

/**
 * A page's name wherever it shows (tree rows, tabs, crumbs, pickers). New
 * pages store the bare name; an older title may still carry its folder path
 * and, for markdown, ".md" ("Specs/Architecture.md" reads "Architecture").
 * Display only: nothing rewrites stored titles. Other document types keep
 * their extension.
 */
export function pageDisplayName(title: string, documentType: string | undefined): string {
  const name = getCollabNodeName(title) || title;
  return documentType === 'markdown' && /.\.md$/i.test(name) ? name.slice(0, -3) : name;
}

export const isTypePageDocumentId = (documentId: string): boolean =>
  documentId.startsWith(TYPE_PAGE_DOCUMENT_PREFIX);

/**
 * Every page as a folder-shaped row, for a page tree. Paths, crumbs, pickers
 * and the create flow resolve a parent through the folder list; in a page tree
 * any page can be a parent, so each one stands in as a folder with its own id.
 * Type-page documents are excluded: the type node stands for them.
 */
export function projectPagesAsFolders(documents: SharedDocument[]): SharedFolder[] {
  return documents
    .filter((document) => document.trashedAt == null && !isTypePageDocumentId(document.documentId))
    .map((document) => ({
      folderId: document.documentId,
      parentFolderId: document.parentFolderId ?? null,
      ...(document.parentKind === 'item' ? { parentKind: 'item' as const } : {}),
      name: pageDisplayName(document.title, document.documentType) || UNRESOLVED_SHARED_DOCUMENT_NAME,
      sortOrder: 0,
      createdBy: document.createdBy,
      createdAt: document.createdAt,
      // Not `updatedAt`: a body edit is not a change to the page as a parent.
      updatedAt: document.createdAt,
      ...(document.decryptFailed ? { decryptFailed: true } : {}),
    }));
}

/** A page and every page below it, root first. Tolerates parent cycles. */
export function collectPageSubtree(documents: SharedDocument[], pageId: string): string[] {
  return collectFolderSubtree(projectPagesAsFolders(documents), pageId);
}

export interface CollabPageRemovalPlan {
  /** The page, its descendant pages and the prose of types placed among them. */
  removedIds: string[];
  /** Everything removed except the page itself, for the confirmation. */
  childCount: number;
  /**
   * Type-page prose sitting in the subtree whose type is placed outside it:
   * moved to the type's parent (or root) before the removal, never deleted.
   */
  relocate: Array<{ documentId: string; parentId: string | null }>;
}

/**
 * What removing a page takes with it. A `type-page:<typeId>` document belongs
 * to its type, not to the page it happens to sit under: it goes with the
 * subtree only when the type itself is placed inside it.
 */
export function planPageRemoval(
  documents: SharedDocument[],
  typePlacements: SharedTypePlacement[],
  pageId: string,
): CollabPageRemovalPlan {
  // Trashed pages count too: the store removes every descendant document.
  const all = documents.map((document) => ({ ...document, trashedAt: null }));
  const pages = new Set(collectPageSubtree(all, pageId));
  const existingPages = new Set(projectPagesAsFolders(all).map((page) => page.folderId));
  const removedIds = [...pages];
  const relocate: CollabPageRemovalPlan['relocate'] = [];
  for (const document of all) {
    if (!isTypePageDocumentId(document.documentId)) continue;
    if (!document.parentFolderId || !pages.has(document.parentFolderId)) continue;
    const typeId = document.documentId.slice(TYPE_PAGE_DOCUMENT_PREFIX.length);
    const placementParent = typePlacements.find((placement) => placement.typeId === typeId)?.parentFolderId ?? null;
    if (placementParent && pages.has(placementParent)) {
      removedIds.push(document.documentId);
    } else {
      const parentId = placementParent && existingPages.has(placementParent) ? placementParent : null;
      relocate.push({ documentId: document.documentId, parentId });
    }
  }
  return { removedIds, childCount: removedIds.length - 1, relocate };
}
