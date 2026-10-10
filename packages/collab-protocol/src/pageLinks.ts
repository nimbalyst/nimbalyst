/**
 * The team's page links index: links between pages found in team page bodies
 * and typed-page bodies, so a page can list what links to it (incoming
 * relations) without every teammate's body on hand. The server extracts them
 * when a body changes and keeps them in the TeamRoom; the web console's Links
 * section reads them.
 *
 * A link is `[label](<target> "rel=<predicate> ...")`, where the target is a
 * console link to a typed page (`.../page/item/<KEY>`, older
 * `.../trackers/item/<KEY>`) or a page (`.../document/<id>`), or an older
 * `nimbalyst://KEY`. A console link names its team project and an issue key
 * is unique only within one, so a link counts as a relation only between pages
 * of the same project: the server answers a query for one project and leaves
 * out links whose target is in another. A `nimbalyst://KEY` link means the
 * source page's own project. Links to Personal pages (`/app/...`) are not team
 * links and are not indexed.
 *
 * `findPageLinks` is the one reader of that syntax on the server; it follows
 * the desktop's `trackerBodyLinks.ts`, which reads typed-page bodies locally,
 * and adds page targets. Pure and dependency-free.
 */

import { CONSOLE_LINK_ORIGIN, parseConsoleLink, type ConsoleTeamScope } from './consoleLinks.js';

/** A page whose body links are indexed. */
export type PageLinkSource =
  /** A page in the team's doc index. */
  | { kind: 'page'; documentId: string }
  /** A typed page's body (`tracker-content/<itemId>`). */
  | { kind: 'item'; itemId: string };

/** What a link points at, as written. */
export type PageLinkTarget =
  /** A typed page by issue key, or by item id when it has none. */
  | { kind: 'item'; ref: string }
  | { kind: 'page'; documentId: string };

/** One (target, relation) in one page body. */
export interface PageLinkEntry {
  source: PageLinkSource;
  /** Team project of the source page; its links are relations within this project. */
  projectId: string;
  /** Title of a source page from the doc index; null for a typed page (the client has its item) or when unreadable. */
  title: string | null;
  target: PageLinkTarget;
  /** Predicate id from `rel=`; null for a plain link. */
  rel: string | null;
  /** The sentence the first such link sits in, as the reader sees it. */
  sentence: string;
  /** How many times the body links this target with this relation. */
  count: number;
}

/**
 * Client -> TeamRoom: the links out of one page and/or into one page, within
 * one team project. A typed page is named by every ref a link may use for it
 * (its item id and its issue key).
 */
export interface TeamPageLinksQueryMessage {
  type: 'pageLinksQuery';
  /** Echoed on the response so a client can run several queries at once. */
  requestId: string;
  /** The team project the page belongs to. */
  projectId: string;
  /** Links out of this page. */
  from?: PageLinkSource;
  /** Links into the page these targets name. */
  to?: PageLinkTarget[];
}

/** TeamRoom -> the asking connection only. */
export interface TeamPageLinksResponseMessage {
  type: 'pageLinksResponse';
  requestId: string;
  outgoing: PageLinkEntry[];
  incoming: PageLinkEntry[];
  /** `partial` until the server has indexed every page once. */
  status: 'ready' | 'partial';
}

/**
 * TeamRoom -> every synced connection: some page's links changed, so an open
 * Links section asks again. Carries nothing, so it says nothing about pages a
 * member cannot read.
 */
export interface TeamPageLinksChangedMessage {
  type: 'pageLinksChanged';
}

// ---------------------------------------------------------------------------
// Reading links from markdown
// ---------------------------------------------------------------------------

/** A link found in a body: where it points, in which scope, and the sentence around it. */
export interface FoundPageLink {
  target: PageLinkTarget;
  /** `'home'`: the source page's own project (`nimbalyst://KEY`). */
  scope: ConsoleTeamScope | 'home';
  rel: string | null;
  sentence: string;
}

/**
 * Same as `TRACKER_REFERENCE_KEY_PATTERN` in the runtime's
 * `trackerReferenceHref.ts` and the desktop's `trackerBodyLinks.ts`: any run
 * of characters that is not a slash, closing paren, whitespace or quote,
 * excluding a bare reserved host.
 */
const RESERVED_LINK_HOSTS = ['action', 'auth', 'console', 'doc', 'folder', 'install', 'tracker'];
const KEY_PATTERN = `(?!(?:${RESERVED_LINK_HOSTS.join('|')})(?=[)\\s]|$))[^)\\s/"]+`;
/** Candidate console links to a typed page or a page; `parseConsoleLink` decides. */
const CONSOLE_PATTERN = `${CONSOLE_LINK_ORIGIN.replace(/\./g, '\\.')}/org/[^/\\s()"?#]+/project/[^/\\s()"?#]+/(?:(?:page|trackers)/item|document)/[^/\\s()"?#]+(?:[?#][^\\s()"]*)?`;
/**
 * `[label](<console link or nimbalyst://KEY>)` with an optional `"k=v k=v"`
 * title. The lookbehind skips a backslash-escaped `\[`, which renders as text.
 */
const LINK_RE = new RegExp(`(?<!\\\\)\\[([^\\]]*)\\]\\((?:nimbalyst://(${KEY_PATTERN})|(${CONSOLE_PATTERN}))(?:\\s+"([^"]*)")?\\)`, 'g');
const LINK_HINT_RE = /nimbalyst:\/\/|console\.nimbalyst\.com\//;
/** Inline code spans: a run of backticks closed by a run of the same length. */
const INLINE_CODE_RE = /(`+)[\s\S]*?\1/g;
/** Fence opener/closer: up to 3 spaces of indent, then 3+ backticks or tildes. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/** Any other markdown link, rendered as its label inside a sentence. */
const OTHER_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const PREDICATE_ID_RE = /^[a-z0-9-]+$/;
const SENTENCE_MAX = 300;

function relOf(title: string | undefined): string | null {
  if (!title) return null;
  for (const token of title.trim().split(/\s+/)) {
    if (!token.startsWith('rel=')) continue;
    const value = token.slice(4);
    return PREDICATE_ID_RE.test(value) ? value : null;
  }
  return null;
}

function consoleTarget(href: string): { target: PageLinkTarget; scope: ConsoleTeamScope } | null {
  const parsed = parseConsoleLink(href);
  if (!parsed || !('scope' in parsed) || parsed.scope === 'local') return null;
  if (parsed.kind === 'item') return { target: { kind: 'item', ref: parsed.itemRef }, scope: parsed.scope };
  if (parsed.kind === 'page') return { target: { kind: 'page', documentId: parsed.pageId }, scope: parsed.scope };
  return null;
}

function stripLineMarker(line: string): string {
  return line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)*/, '');
}

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > SENTENCE_MAX ? `${collapsed.slice(0, SENTENCE_MAX - 1).trimEnd()}…` : collapsed;
}

function sentenceAt(text: string, at: number): string {
  let start = 0;
  const boundary = /[.!?](?=\s)/g;
  for (let m = boundary.exec(text); m && m.index < at; m = boundary.exec(text)) {
    start = m.index + 1;
  }
  boundary.lastIndex = at;
  const end = boundary.exec(text);
  return clip(text.slice(start, end ? end.index + 1 : text.length));
}

/**
 * Every page link in a body, in order, with the sentence it sits in as the
 * reader sees it (every link renders as its label; a link with an empty label
 * as its key or id). Links in code are examples, not links.
 */
export function findPageLinks(markdown: string): FoundPageLink[] {
  const links: FoundPageLink[] = [];
  if (!markdown || !LINK_HINT_RE.test(markdown)) return links;
  let fence: string | null = null;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const fenceMatch = rawLine.match(FENCE_RE);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    if (!LINK_HINT_RE.test(rawLine)) continue;
    // Match against a copy with code spans blanked (same length, so offsets
    // hold); render the sentence from the original text.
    const line = stripLineMarker(rawLine);
    const matchable = line.replace(INLINE_CODE_RE, (span) => ' '.repeat(span.length));
    let rendered = '';
    let cursor = 0;
    const found: Array<Omit<FoundPageLink, 'sentence'> & { at: number }> = [];
    LINK_RE.lastIndex = 0;
    for (let m = LINK_RE.exec(matchable); m; m = LINK_RE.exec(matchable)) {
      const resolved = m[2] !== undefined
        ? { target: { kind: 'item', ref: m[2] } as PageLinkTarget, scope: 'home' as const }
        : consoleTarget(m[3]!);
      if (!resolved) continue;
      rendered += line.slice(cursor, m.index).replace(OTHER_LINK_RE, '$1');
      found.push({ ...resolved, rel: relOf(m[4]), at: rendered.length });
      const fallback = resolved.target.kind === 'item' ? resolved.target.ref : resolved.target.documentId;
      rendered += line.slice(m.index + 1, m.index + 1 + m[1]!.length).trim() || fallback;
      cursor = m.index + m[0].length;
    }
    rendered += line.slice(cursor).replace(OTHER_LINK_RE, '$1');
    for (const { at, ...link } of found) links.push({ ...link, sentence: sentenceAt(rendered, at) });
  }
  return links;
}
