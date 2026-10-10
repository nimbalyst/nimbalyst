/**
 * The host's half of a transclusion: reading a page's markdown live, and
 * opening the page. The runtime editor knows the link; only the host knows how
 * a page id becomes content (the desktop's shared-document caches, the
 * Personal pages store, a typed page's body). Without a host the block says
 * transclusion is unavailable here and still links to the page.
 *
 * One slot per process, set at startup like `setEmbedPluginCallbacks`.
 */

import type { ParsedTransclusionHref } from './transclusionLink';

export type TransclusionSourceState =
  | { status: 'loading' }
  /** `markdown` is the whole page; the block cuts the section itself. */
  | { status: 'ready'; markdown: string; title: string | null }
  /** The page does not exist here: deleted, trashed, or never synced to this device. */
  | { status: 'missing'; message?: string }
  /** The page exists but this user cannot read it (another team, no membership). */
  | { status: 'no-access'; message?: string }
  /** Anything else: offline, room unreachable, undecodable content. */
  | { status: 'error'; message: string };

export interface TransclusionHost {
  /**
   * Subscribe to the page's content. Call `onChange` with every new state,
   * including the first; return the unsubscribe. Called once per mounted
   * block, so the host should share one read per page across blocks.
   */
  subscribe(link: ParsedTransclusionHref, onChange: (state: TransclusionSourceState) => void): () => void;
  /** Navigate to the page (and its section, when the link has an anchor). */
  open(link: ParsedTransclusionHref, options: { href: string; newTab: boolean }): void;
}

/**
 * Orders a page's async reads so only the newest one may emit. `next()` starts
 * a read (or marks a synchronous outcome such as a deletion) and returns
 * `isCurrent`; a completion, ready or error, whose read was superseded must be
 * dropped, or a slow older read overwrites newer content.
 */
export function createReadSequencer(): { next(): () => boolean } {
  let generation = 0;
  return {
    next() {
      const mine = ++generation;
      return () => mine === generation;
    },
  };
}

let host: TransclusionHost | null = null;

export function setTransclusionHost(next: TransclusionHost | null): void {
  host = next;
}

export function getTransclusionHost(): TransclusionHost | null {
  return host;
}
