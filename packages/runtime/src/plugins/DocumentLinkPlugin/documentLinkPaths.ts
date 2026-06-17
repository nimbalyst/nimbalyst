export interface ImportedDocumentReference {
  documentId: string;
  name: string;
  path: string;
}

export function normalizeDocumentLinkHref(rawHref: string): string {
  return rawHref.replace(/\\/g, '/').trim();
}

function isAbsolutePath(filePath: string): boolean {
  return (
    filePath.startsWith('/') ||
    /^[A-Za-z]:\//.test(filePath) ||
    filePath.startsWith('//')
  );
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

function getDirectoryName(filePath: string): string {
  const normalized = normalizePath(filePath);
  const { root, rest } = splitRoot(normalized);
  const segments = rest.split('/').filter(Boolean);

  if (segments.length <= 1) {
    return root || '';
  }

  const directorySegments = segments.slice(0, -1);
  if (root === '//') {
    return `//${directorySegments.join('/')}`;
  }
  if (root) {
    return `${root}${directorySegments.join('/')}`;
  }
  return directorySegments.join('/');
}

function joinAndNormalize(basePath: string, relativePath: string): string {
  const normalizedBase = normalizePath(basePath).replace(/\/+$/, '');
  return normalizePath(
    normalizedBase ? `${normalizedBase}/${relativePath}` : relativePath,
  );
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

export function resolveDocumentLinkLookupPath(
  storedPath: string,
  currentDocumentPath: string | null,
  workspacePath: string | null,
): string {
  const normalizedPath = normalizeDocumentLinkHref(storedPath);
  if (!normalizedPath) {
    return '';
  }

  if (isAbsolutePath(normalizedPath)) {
    if (!workspacePath) {
      return normalizePath(normalizedPath);
    }
    return (
      toWorkspaceRelativePath(normalizedPath, workspacePath) ??
      normalizePath(normalizedPath)
    );
  }

  const isExplicitlyDocumentRelative =
    normalizedPath.startsWith('./') || normalizedPath.startsWith('../');
  if (isExplicitlyDocumentRelative) {
    if (!currentDocumentPath) {
      return normalizedPath;
    }

    const absoluteTarget = joinAndNormalize(
      getDirectoryName(currentDocumentPath),
      normalizedPath,
    );

    if (!workspacePath) {
      return absoluteTarget;
    }

    return (
      toWorkspaceRelativePath(absoluteTarget, workspacePath) ?? absoluteTarget
    );
  }

  return normalizePath(normalizedPath);
}
