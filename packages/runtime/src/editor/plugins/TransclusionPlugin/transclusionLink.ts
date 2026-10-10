/**
 * The markdown contract for a transclusion: a link alone in its paragraph
 * whose title carries the bare `transclude` token, pointing at a page in any
 * of the forms Pages writes or still reads:
 *
 *   [Auth model](https://console.nimbalyst.com/org/o/project/p/document/D#jwt-scopes "transclude")
 *   [Notes](https://console.nimbalyst.com/app/page/P "transclude")
 *   [NIM-12](https://console.nimbalyst.com/org/o/project/p/page/item/NIM-12 "transclude")
 *   [Auth model](nimbalyst://doc/D?orgId=o#jwt-scopes "transclude")
 *   [Auth model](collab://org:o:doc:D "transclude")
 *
 * The fragment names a heading anchor (the GitHub-style slug
 * `HeadingAnchorExtension` puts on headings); without one the whole page is
 * shown. Other title tokens (`k=v`) are kept verbatim and ignored.
 *
 * Pure and React-free: the reference transformers, the headless node set and
 * the renderer all read it.
 */

import { parseConsoleLink, type ConsoleLinkScope } from '@nimbalyst/collab-protocol';

import { parseCollabReferenceDocumentId } from '../../../plugins/DocumentLinkPlugin/documentLinkPaths';

export const TRANSCLUDE_TOKEN = 'transclude';

/** Nested transclusions render this many levels deep, then stop. */
export const MAX_TRANSCLUSION_DEPTH = 3;

const TRANSCLUDE_TOKEN_REGEX = /(?:^|\s)transclude(?:\s|$)/;

/** True when a link title marks the link as a transclusion. */
export function isTranscludeTitle(title: string | null | undefined): boolean {
  return !!title && TRANSCLUDE_TOKEN_REGEX.test(title);
}

/** The title with every `transclude` token removed; the other tokens keep their order and spacing. */
export function withoutTranscludeToken(title: string): string {
  return title.split(/\s+/).filter((token) => token && token !== TRANSCLUDE_TOKEN).join(' ');
}

export type TransclusionTarget =
  /** A team page (`scope` is the team) or a Personal page (`scope: 'local'`). */
  | { kind: 'page'; scope: ConsoleLinkScope; pageId: string }
  /** A typed page; `itemRef` is the issue key or item id. */
  | { kind: 'item'; scope: ConsoleLinkScope; itemRef: string }
  /** A shared document addressed by a `nimbalyst://doc` or `collab://` link. */
  | { kind: 'collabDoc'; documentId: string; orgId: string | null };

export interface ParsedTransclusionHref {
  target: TransclusionTarget;
  /** The heading anchor after `#`, decoded; null for the whole page. */
  anchor: string | null;
  /** The href without its fragment: what "open" navigates to. */
  pageHref: string;
}

/** `decodeURIComponent`, or null for a malformed escape (`%ZZ`), which throws. */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function splitFragment(href: string): { base: string; anchor: string | null } {
  const hash = href.indexOf('#');
  if (hash < 0) return { base: href, anchor: null };
  const raw = href.slice(hash + 1);
  // Keep the raw fragment on a malformed escape; it is still a usable slug.
  return { base: href.slice(0, hash), anchor: (safeDecode(raw) ?? raw) || null };
}

/** The org in the link, null when absent; undefined when the link is malformed. */
function collabOrgId(href: string): string | null | undefined {
  const query = href.match(/[?&]orgId=([^&#]+)/);
  if (query) return safeDecode(query[1]!) ?? undefined;
  return href.match(/^collab:\/\/org:([^:]+):/)?.[1] ?? null;
}

function collabDocumentId(href: string): string | null {
  try {
    return parseCollabReferenceDocumentId(href);
  } catch {
    // Its `nimbalyst://doc/<id>` branch decodes without a guard.
    return null;
  }
}

/**
 * The page a transclusion link points at, or null when the href names no page
 * or is malformed. Never throws: it runs inside the editor's link transform,
 * where a throw aborts the whole document import.
 */
export function parseTransclusionHref(href: string | null | undefined): ParsedTransclusionHref | null {
  if (!href) return null;
  const { base, anchor } = splitFragment(href.trim());
  const consoleTarget = parseConsoleLink(base);
  if (consoleTarget?.kind === 'page') {
    return { target: { kind: 'page', scope: consoleTarget.scope, pageId: consoleTarget.pageId }, anchor, pageHref: base };
  }
  if (consoleTarget?.kind === 'item') {
    return { target: { kind: 'item', scope: consoleTarget.scope, itemRef: consoleTarget.itemRef }, anchor, pageHref: base };
  }
  if (consoleTarget) return null;
  const documentId = collabDocumentId(base);
  const orgId = collabOrgId(base);
  if (documentId && orgId !== undefined) {
    return { target: { kind: 'collabDoc', documentId, orgId }, anchor, pageHref: base };
  }
  return null;
}

/**
 * A stable identity for the page a target names, used to detect cycles. A team
 * page's console link and its `nimbalyst://doc` link name the same document.
 */
export function transclusionTargetKey(target: TransclusionTarget): string {
  switch (target.kind) {
    case 'page':
      return target.scope === 'local' ? `personal:${target.pageId}` : `doc:${target.pageId}`;
    case 'collabDoc':
      return `doc:${target.documentId}`;
    case 'item':
      return `item:${target.itemRef}`;
  }
}

export type TransclusionGuard = 'ok' | 'cycle' | 'too-deep';

/**
 * Whether a transclusion of `key` may render. `ancestorKeys` are the pages
 * already on screen above it (the host page when known, then each enclosing
 * transclusion); `depth` is how many transclusions enclose it.
 */
export function checkTransclusionNesting(
  ancestorKeys: readonly string[],
  depth: number,
  key: string,
  maxDepth: number = MAX_TRANSCLUSION_DEPTH,
): TransclusionGuard {
  if (ancestorKeys.includes(key)) return 'cycle';
  return depth >= maxDepth ? 'too-deep' : 'ok';
}
