import * as path from 'path';

export const OPEN_FILE_DEEP_LINK_HOST = 'open';

export interface OpenFileDeepLinkTarget {
  path: string;
  line?: number;
  workspacePath?: string;
}

const LINE_RE = /^[1-9]\d*$/;

/**
 * Parse `nimbalyst://open?path=/abs/file[&line=N][&workspace=/abs/ws]`.
 *
 * Null-returning like parseFeedbackRequestDeepLink — main logs one warning per
 * invalid link. Strict by design: this host is mintable by any web page, so
 * anything short of an absolute, NUL-free path (and a positive integer line /
 * absolute workspace, when given) rejects the whole link instead of degrading.
 * Filesystem checks (exists, regular file, known workspace) stay with the
 * caller in main — this module is pure URL grammar.
 */
export function parseOpenFileDeepLink(rawUrl: string): OpenFileDeepLinkTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  // `nimbalyst://open?…` parses as host 'open' with an empty pathname;
  // `nimbalyst:///open?…` as an empty host with pathname '/open'. Accept both,
  // reject anything with extra path segments or a fragment.
  const hostForm =
    parsed.host === OPEN_FILE_DEEP_LINK_HOST &&
    (parsed.pathname === '' || parsed.pathname === '/');
  const pathnameForm =
    parsed.host === '' && parsed.pathname === `/${OPEN_FILE_DEEP_LINK_HOST}`;
  if (parsed.protocol !== 'nimbalyst:' || (!hostForm && !pathnameForm) || parsed.hash) {
    return null;
  }

  const filePath = parsed.searchParams.get('path');
  if (!filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    return null;
  }

  const target: OpenFileDeepLinkTarget = { path: filePath };

  const line = parsed.searchParams.get('line');
  if (line !== null) {
    if (!LINE_RE.test(line)) {
      return null;
    }
    target.line = Number(line);
  }

  const workspace = parsed.searchParams.get('workspace');
  if (workspace !== null) {
    if (workspace.includes('\0') || !path.isAbsolute(workspace)) {
      return null;
    }
    target.workspacePath = workspace;
  }

  return target;
}
