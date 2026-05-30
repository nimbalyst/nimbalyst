import type { SharedDocument } from '../../store/atoms/collabDocuments';

export interface CollabTreeFolderNode {
  id: string;
  type: 'folder';
  path: string;
  name: string;
  children: CollabTreeNode[];
}

export interface CollabTreeDocumentNode {
  id: string;
  type: 'document';
  path: string;
  name: string;
  document: SharedDocument;
}

export type CollabTreeNode = CollabTreeFolderNode | CollabTreeDocumentNode;

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
