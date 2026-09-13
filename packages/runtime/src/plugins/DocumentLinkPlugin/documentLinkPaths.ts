import { dirname, isAbsolute, join } from 'pathe';
import { getEmbedFilePathCandidates } from '../../editor/plugins/EmbedPlugin/embedFilePaths';
import { parseCollabUri } from '@nimbalyst/collab-protocol';

export interface ImportedDocumentReference {
  documentId: string;
  name: string;
  path: string;
}

export function normalizeDocumentLinkHref(rawHref: string): string {
  return rawHref.replace(/\\/g, '/').trim();
}

function splitRoot(path: string): { root: string; rest: string } {
  if (/^[A-Za-z]:\//.test(path)) {
    return {
      root: path.slice(0, 3),
      rest: path.slice(3),
    };
  }

  if (path.startsWith('//')) {
    return {
      root: '//',
      rest: path.slice(2),
    };
  }

  if (path.startsWith('/')) {
    return {
      root: '/',
      rest: path.slice(1),
    };
  }

  return {
    root: '',
    rest: path,
  };
}

function normalizePath(path: string): string {
  const normalized = normalizeDocumentLinkHref(path);
  const { root, rest } = splitRoot(normalized);
  const segments = rest.split('/').filter(Boolean);
  const resolved: string[] = [];

  for (const segment of segments) {
    if (segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop();
      } else if (!root) {
        resolved.push(segment);
      }
      continue;
    }

    resolved.push(segment);
  }

  if (root === '//') {
    return resolved.length > 0 ? `//${resolved.join('/')}` : '//';
  }

  if (root) {
    return resolved.length > 0 ? `${root}${resolved.join('/')}` : root;
  }

  return resolved.join('/');
}

function toWorkspaceRelativePath(
  absolutePath: string,
  workspacePath: string,
): string | null {
  const normalizedAbsolute = normalizePath(absolutePath);
  const normalizedWorkspace = normalizePath(workspacePath).replace(/\/+$/, '');

  if (normalizedAbsolute === normalizedWorkspace) {
    return '';
  }

  const workspacePrefix = `${normalizedWorkspace}/`;
  if (normalizedAbsolute.startsWith(workspacePrefix)) {
    return normalizedAbsolute.slice(workspacePrefix.length);
  }

  return null;
}

export function buildImportedDocumentReference(
  label: string,
  rawHref: string,
): ImportedDocumentReference {
  const normalizedPath = normalizeDocumentLinkHref(rawHref);
  const fileName = normalizedPath.split('/').filter(Boolean).pop() || label;

  return {
    documentId: '',
    name: label || fileName,
    path: normalizedPath,
  };
}

export function exportDocumentLinkHref(storedPath: string): string {
  return normalizeDocumentLinkHref(storedPath);
}

/**
 * A collaborative-document reference target. Inside a collab document the `@`
 * typeahead stores a shareable deep link (`nimbalyst://doc/{id}?orgId={org}`)
 * or the internal collab URI (`collab://org:{org}:doc:{id}`) as the reference
 * path instead of a workspace-relative file path. These must be opened through
 * the collab opener, not the local document service.
 */
export function isCollabReferenceHref(href: string | null | undefined): boolean {
  if (!href) {
    return false;
  }
  const trimmed = href.trim();
  return trimmed.startsWith('nimbalyst://doc/') || trimmed.startsWith('collab://');
}

/**
 * Extract the documentId from a collab reference target. Supports both the
 * `nimbalyst://doc/{id}?orgId={org}` deep link and the internal
 * `collab://org:{org}:doc:{id}` URI. Returns null when the href is not a
 * recognizable collab reference.
 */
export function parseCollabReferenceDocumentId(href: string | null | undefined): string | null {
  if (!href) {
    return null;
  }
  const trimmed = href.trim();
  const deepLinkMatch = trimmed.match(/^nimbalyst:\/\/doc\/([^/?#]+)/);
  if (deepLinkMatch) {
    return decodeURIComponent(deepLinkMatch[1]);
  }
  try {
    return parseCollabUri(trimmed).documentId;
  } catch {
    return null;
  }
}

/** Resolve links with the same path policy as their embedded presentation. */
export function resolveDocumentLinkLookupPaths(
  storedPath: string,
  currentDocumentPath: string | null,
  workspacePath: string | null,
): string[] {
  let documentPath = currentDocumentPath ? normalizeDocumentLinkHref(currentDocumentPath) : null;
  if (documentPath && !isAbsolute(documentPath) && workspacePath && !/^[a-z][a-z0-9+.-]*:/i.test(documentPath)) {
    documentPath = join(workspacePath, documentPath);
  }
  return getEmbedFilePathCandidates(storedPath, documentPath ? dirname(documentPath) : null, workspacePath)
    .map(path => workspacePath ? toWorkspaceRelativePath(path, workspacePath) ?? path : path);
}
