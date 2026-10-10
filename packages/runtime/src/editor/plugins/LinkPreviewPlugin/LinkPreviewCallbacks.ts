/**
 * Host slot for fetching a web page's preview metadata. The runtime never
 * fetches a page itself: in Electron the main process does it (no cookies,
 * size and time capped, cached); a host that registers nothing gets cards
 * that show the URL and site name only.
 */

export interface LinkPreviewMetadata {
  /** The URL that was requested. */
  url: string;
  /** Where the request ended after redirects. */
  finalUrl?: string;
  title?: string;
  description?: string;
  siteName?: string;
  /**
   * A `data:image/...` URL the host fetched through its protected path. The
   * card never loads a URL a page chose, so it shows no page image.
   */
  favicon?: string;
}

export interface LinkPreviewCallbacks {
  fetchLinkPreview?: (url: string) => Promise<LinkPreviewMetadata | null>;
}

let callbacks: LinkPreviewCallbacks = {};

export function getLinkPreviewCallbacks(): LinkPreviewCallbacks {
  return callbacks;
}

export function setLinkPreviewCallbacks(next: LinkPreviewCallbacks): void {
  callbacks = next;
}
