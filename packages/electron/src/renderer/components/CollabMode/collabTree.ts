import type { SharedDocument, SharedFolder } from '../../store/atoms/collabDocuments';

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
}

export type CollabTreeNode = CollabTreeFolderNode | CollabTreeDocumentNode;

export interface CollabFolderOption {
  folderId: string | null;
  name: string;
  depth: number;
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

export function buildCollabTree(
  documents: SharedDocument[],
  customFolders: string[]
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

  const sortNodes = (nodes: CollabTreeNode[]): CollabTreeNode[] => {
    nodes.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'folder' ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });

    for (const node of nodes) {
      if (node.type === 'folder') {
        sortNodes(node.children);
      }
    }

    return nodes;
  };

  return sortNodes(roots);
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

  const sortNodes = (nodes: CollabTreeNode[]): CollabTreeNode[] => {
    nodes.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'folder' ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
    for (const node of nodes) {
      if (node.type === 'folder') sortNodes(node.children);
    }
    return nodes;
  };

  return sortNodes(roots);
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
): CollabTreeNode[] {
  if (folders.length === 0) {
    const hasPathInTitle = documents.some(
      doc => !doc.parentFolderId && getCollabParentPath(getCollabDocumentPath(doc)) !== null,
    );
    if (hasPathInTitle) {
      return buildCollabTree(documents, []);
    }
  }
  return buildCollabTreeFromFolders(documents, folders);
}

/**
 * Drop folder nodes that contain no documents (directly or transitively). Used
 * by the Favorites/Updated segments so an empty folder doesn't linger once its
 * only matching docs are filtered out. Folders with document descendants are
 * kept (with their empty sub-branches pruned).
 */
export function pruneEmptyFolders(nodes: CollabTreeNode[]): CollabTreeNode[] {
  const prune = (node: CollabTreeNode): CollabTreeNode | null => {
    if (node.type === 'document') return node;
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
    if (node.type === 'document') {
      return nodeMatchesQuery(node) ? node : null;
    }

    if (nodeMatchesQuery(node)) {
      return node;
    }

    const filteredChildren = node.children
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
