/**
 * Routing for links inside the editor that point at workspace files rather
 * than the web. Lexical's stock link handling (`ClickableLinkPlugin`, the
 * floating link editor) hands every href to `window.open`, which in Electron
 * resolves relative paths against the renderer origin and spawns a blank
 * child window (NIM-1487). Anything that looks like a file path must instead
 * be routed through the host's document-opening flow.
 *
 * The opener is registered by the host shell (electron renderer registers one
 * backed by its document service); on hosts that never register an opener
 * (e.g. mobile surfaces without tabs) `openWorkspaceFileLink` returns false
 * and callers fall back to their previous behavior.
 */

const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;

/**
 * True when a raw href (as authored in the document, NOT the DOM-resolved
 * absolute URL) points at a file rather than an external resource: relative
 * paths (`./x`, `../x`, `docs/x.md`), absolute POSIX paths, and Windows
 * drive-letter paths. Scheme'd URLs (`https:`, `mailto:`, `collab-asset:`,
 * `nimbalyst:`…), in-page anchors, and protocol-relative URLs are external.
 */
export function isWorkspaceFileHref(rawHref: string | null | undefined): boolean {
  if (!rawHref) {
    return false;
  }
  const href = rawHref.trim();
  if (!href || href.startsWith('#') || href.startsWith('//')) {
    return false;
  }
  if (WINDOWS_PATH_PATTERN.test(href)) {
    return true;
  }
  return !SCHEME_PATTERN.test(href);
}

export type WorkspaceFileLinkOpener = (
  rawHref: string,
  currentDocumentPath: string | null,
) => void;

let workspaceFileLinkOpener: WorkspaceFileLinkOpener | null = null;

export function setWorkspaceFileLinkOpener(opener: WorkspaceFileLinkOpener | null): void {
  workspaceFileLinkOpener = opener;
}

/**
 * Route a file-ish href to the registered opener. Returns false when no
 * opener is registered, in which case the caller should keep its default
 * behavior.
 */
export function openWorkspaceFileLink(
  rawHref: string,
  currentDocumentPath: string | null | undefined,
): boolean {
  if (!workspaceFileLinkOpener) {
    return false;
  }
  workspaceFileLinkOpener(rawHref, currentDocumentPath ?? null);
  return true;
}

/**
 * A host's chance to open a web link itself before it goes to `window.open`.
 * The web console uses it so a link to one of its own pages navigates the
 * current tab, as a page link does on the desktop. `newTab` is true for a
 * Cmd/Ctrl or middle click. Returns true when the host opened the link.
 */
export type HostLinkOpener = (url: string, options: { newTab: boolean }) => boolean;

let hostLinkOpener: HostLinkOpener | null = null;

/** Installs the host's opener; the returned function removes it. */
export function setHostLinkOpener(opener: HostLinkOpener): () => void {
  hostLinkOpener = opener;
  return () => {
    if (hostLinkOpener === opener) hostLinkOpener = null;
  };
}

export function openLinkWithHost(url: string, options: { newTab: boolean }): boolean {
  return hostLinkOpener?.(url, options) ?? false;
}
