import { dirname, isAbsolute, join, normalize, relative } from 'pathe';

/** Ordered paths: Markdown semantics first, then the old embed convention. */
export function getEmbedFilePathCandidates(
  href: string,
  documentDir: string | null,
  workspacePath: string | null,
): string[] {
  if (!href) return [];
  let path: string;
  try {
    if (/^file:\/\//i.test(href)) {
      const url = new URL(href);
      path = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname !== 'localhost') path = `//${url.hostname}${path}`;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
      return [normalize(path)];
    }
    path = decodeURIComponent(href.split(/[?#]/, 1)[0]).replace(/\\/g, '/');
  } catch {
    return [];
  }
  if (!path) return [];
  if (/^[a-z]:\//i.test(path) || path.startsWith('//')) return [normalize(path)];
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return [];

  const hostDir = documentDir && isAbsolute(documentDir) ? documentDir : null;
  let candidates: (string | null)[];
  if (path.startsWith('/')) {
    candidates = [workspacePath ? join(workspacePath, path.slice(1)) : null, normalize(path)];
  } else if (path.startsWith('./') || path.startsWith('../')) {
    candidates = [hostDir ? join(hostDir, path) : null];
  } else {
    candidates = [hostDir ? join(hostDir, path) : null, workspacePath ? join(workspacePath, path) : null];
  }
  return [...new Set(candidates.filter((candidate): candidate is string => candidate !== null))];
}

/** Missing files allow compatibility lookup; a failed probe must still reject. */
export async function findExistingEmbedFilePath(
  candidates: readonly string[],
  fileExists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  for (const path of candidates) {
    if (await fileExists(path)) return path;
  }
  return null;
}

/** The picker knows the target, so emit an explicit path with no ambiguity. */
export function createEmbedFileHref(
  workspaceFilePath: string,
  documentPath: string | null,
  workspacePath: string | null,
): string {
  const path = workspaceFilePath.replace(/\\/g, '/');
  const absolutePath = isAbsolute(path) ? path : workspacePath ? join(workspacePath, path) : null;
  let href: string;
  if (absolutePath && documentPath && isAbsolute(documentPath)) {
    const documentRelative = relative(dirname(documentPath), absolutePath);
    // A different Windows drive cannot be represented by a relative path.
    href = isAbsolute(documentRelative) ? `file:///${documentRelative}`
      : documentRelative.startsWith('../') ? documentRelative : `./${documentRelative}`;
  } else {
    href = isAbsolute(path) ? `file://${path.startsWith('/') ? '' : '/'}${path}` : `/${path}`;
  }
  return href.split('/').map((part, index) => index === 0 && part === 'file:' ? part : encodeURIComponent(part)).join('/');
}
