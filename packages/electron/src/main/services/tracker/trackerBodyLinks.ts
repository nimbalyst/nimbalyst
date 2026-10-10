/**
 * Body links as relationship edges.
 *
 * A typed page's body carries links of the form
 * `[label](https://console.nimbalyst.com/org/<org>/project/<p>/page/item/KEY "view=card rel=built-on")`
 * (older links `.../trackers/item/KEY`, or `/app/item/KEY` for a local item), and older bodies the Phase 3 form
 * `[label](nimbalyst://KEY "...")`; both are read. Each distinct
 * (target, relation) becomes one row in the local relationship index with
 * `source_field_id = 'body:<rel>'` (or `'body:link'` for a link with no `rel=`),
 * so the Links section can list a page's relations and the linked page can list
 * them under the inverse name. Pure: the index store resolves keys and persists.
 *
 * A console link names its team project, and an issue key is only unique
 * within one: given the workspace's own team project (`homeScope`), a link to
 * another project's NIM-123 is skipped rather than resolved to this project's
 * NIM-123. With no known team project every team link is skipped. It stays a
 * link in the body, opened through the console.
 */
import { CONSOLE_LINK_ORIGIN, parseConsoleLink, type ConsoleTeamScope } from '@nimbalyst/collab-protocol';
import type { RelationshipEdge } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

/** Prefix that marks a body-derived row; field-derived rows never start with it. */
export const BODY_LINK_FIELD_PREFIX = 'body:';

/**
 * Re-declared from `TrackerLinkPlugin/trackerReferenceHref.ts`
 * (`TRACKER_REFERENCE_KEY_PATTERN`), which the runtime package does not export
 * to main. Keep the two in sync: any run of characters that is not a slash,
 * closing paren, whitespace or quote, excluding a bare reserved host.
 */
const RESERVED_LINK_HOSTS = ['action', 'auth', 'console', 'doc', 'folder', 'install', 'tracker'];
const KEY_PATTERN = `(?!(?:${RESERVED_LINK_HOSTS.join('|')})(?=[)\\s]|$))[^)\\s/"]+`;

/**
 * Candidate console item links; `parseConsoleLink` decides. Mirrors
 * `TRACKER_REFERENCE_CONSOLE_HREF_PATTERN` in `trackerReferenceHref.ts`.
 */
const CONSOLE_ITEM_PATTERN = `${CONSOLE_LINK_ORIGIN.replace(/\./g, '\\.')}/(?:org/[^/\\s()"?#]+/project/[^/\\s()"?#]+/(?:page|trackers)/item|app/item)/[^/\\s()"?#]+(?:[?#][^\\s()"]*)?`;

/**
 * `[label](<console item link or nimbalyst://KEY>)` with an optional
 * `"k=v k=v"` title. The lookbehind skips a backslash-escaped `\[`, which
 * markdown renders as text.
 */
const LINK_RE = new RegExp(`(?<!\\\\)\\[([^\\]]*)\\]\\((?:nimbalyst://(${KEY_PATTERN})|(${CONSOLE_ITEM_PATTERN}))(?:\\s+"([^"]*)")?\\)`, 'g');
const LINK_HINT_RE = /nimbalyst:\/\/|console\.nimbalyst\.com\//;

export interface BodyLinkScopeOptions {
  /**
   * The workspace's team project; null or undefined when it has none or it is
   * not known yet (signed out, offline). Without one, only `nimbalyst://KEY`
   * and `/app/item/` links are read as this workspace's.
   */
  homeScope?: ConsoleTeamScope | null;
}

/**
 * Each workspace's team project, recorded when its tracker room is set up:
 * the room its team items live in, so the project their keys belong to.
 */
const homeScopes = new Map<string, ConsoleTeamScope>();

export function setBodyLinkHomeScope(workspace: string, scope: ConsoleTeamScope): void {
  homeScopes.set(workspace, scope);
}

/** Undefined until the workspace's room is set up (offline, signed out, no team yet). */
export function bodyLinkHomeScope(workspace: string): ConsoleTeamScope | undefined {
  return homeScopes.get(workspace);
}

/** The item key a console link names, or null when it is not an item link or names another team project. */
function consoleItemKey(href: string, { homeScope }: BodyLinkScopeOptions): string | null {
  const target = parseConsoleLink(href);
  if (target?.kind !== 'item') return null;
  // With no known team project, a team link cannot be shown to be this workspace's.
  if (target.scope !== 'local' && (!homeScope || homeScope.orgId !== target.scope.orgId || homeScope.projectId !== target.scope.projectId)) {
    return null;
  }
  return target.itemRef;
}
/** Inline code spans: a run of backticks closed by a run of the same length. */
const INLINE_CODE_RE = /(`+)[\s\S]*?\1/g;
/** Fence opener/closer: up to 3 spaces of indent, then 3+ backticks or tildes. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/** Any other markdown link, rendered as its label inside a sentence. */
const OTHER_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const PREDICATE_ID_RE = /^[a-z0-9-]+$/;
const SENTENCE_MAX = 300;

export interface ParsedBodyLink {
  key: string;
  /** Predicate id from `rel=`, or null for a plain link. */
  rel: string | null;
  sentence: string;
}

/** Tracker bodies are stored as a markdown string or `{ markdown }`. */
export function bodyMarkdownOf(content: unknown): string {
  if (typeof content === 'string') {
    // SQLite hands back the JSON text of the column; PGLite the decoded value.
    const trimmed = content.trim();
    if (trimmed.startsWith('"') || trimmed.startsWith('{')) {
      try { return bodyMarkdownOf(JSON.parse(trimmed)); } catch { /* plain markdown */ }
    }
    return content;
  }
  const markdown = (content as { markdown?: unknown } | null)?.markdown;
  return typeof markdown === 'string' ? markdown : '';
}

function relOf(title: string | undefined): string | null {
  if (!title) return null;
  for (const token of title.trim().split(/\s+/)) {
    if (!token.startsWith('rel=')) continue;
    const value = token.slice(4);
    return PREDICATE_ID_RE.test(value) ? value : null;
  }
  return null;
}

function stripLineMarker(line: string): string {
  return line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)*/, '');
}

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > SENTENCE_MAX ? `${collapsed.slice(0, SENTENCE_MAX - 1).trimEnd()}…` : collapsed;
}

/**
 * Every tracker link in the body, in order, with the sentence it sits in, as
 * the reader sees it: every link renders as its label (a tracker link with an
 * empty label as its KEY).
 */
export function parseBodyLinks(markdown: string, options: BodyLinkScopeOptions = {}): ParsedBodyLink[] {
  const links: ParsedBodyLink[] = [];
  if (!markdown || !LINK_HINT_RE.test(markdown)) return links;
  // A link written as an example (fenced block, inline code) is not a relation.
  let fence: string | null = null;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const fenceMatch = rawLine.match(FENCE_RE);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    if (!LINK_HINT_RE.test(rawLine)) continue;
    // Match against a copy with code spans blanked (same length, so offsets
    // hold); render the sentence from the original text.
    const line = stripLineMarker(rawLine);
    const matchable = line.replace(INLINE_CODE_RE, (span) => ' '.repeat(span.length));
    // Render the line, recording where each tracker link lands so the sentence
    // split runs on rendered text (a title attribute cannot fake a boundary).
    let rendered = '';
    let cursor = 0;
    const found: Array<{ key: string; rel: string | null; at: number }> = [];
    LINK_RE.lastIndex = 0;
    for (let m = LINK_RE.exec(matchable); m; m = LINK_RE.exec(matchable)) {
      const key = m[2] ?? consoleItemKey(m[3], options);
      // Not ours (another project's link): it reads as its label, like any other link.
      if (!key) continue;
      rendered += line.slice(cursor, m.index).replace(OTHER_LINK_RE, '$1');
      found.push({ key, rel: relOf(m[4]), at: rendered.length });
      // The reader sees the label; a link with none shows its key.
      rendered += line.slice(m.index + 1, m.index + 1 + m[1].length).trim() || key;
      cursor = m.index + m[0].length;
    }
    rendered += line.slice(cursor).replace(OTHER_LINK_RE, '$1');
    for (const link of found) {
      links.push({ key: link.key, rel: link.rel, sentence: sentenceAt(rendered, link.at) });
    }
  }
  return links;
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

export interface ResolvedLinkTarget {
  itemId: string;
  type: string;
}

/**
 * One edge per (target, relation). `resolve` maps a KEY (issue key or raw item
 * id) to an item in the same workspace; unresolvable keys and self links
 * produce nothing. The sentence is the first occurrence's.
 */
export function deriveBodyLinkEdges(
  sourceItemId: string,
  markdown: string,
  resolve: (key: string) => ResolvedLinkTarget | null | undefined,
  options: BodyLinkScopeOptions = {},
): RelationshipEdge[] {
  const byEdge = new Map<string, RelationshipEdge & { metadata: { sentence: string; count: number } }>();
  for (const link of parseBodyLinks(markdown, options)) {
    const target = resolve(link.key);
    if (!target || target.itemId === sourceItemId) continue;
    const sourceFieldId = `${BODY_LINK_FIELD_PREFIX}${link.rel ?? 'link'}`;
    const id = `${sourceFieldId}|${target.itemId}`;
    const existing = byEdge.get(id);
    if (existing) {
      existing.metadata.count += 1;
      continue;
    }
    byEdge.set(id, {
      sourceItemId,
      sourceFieldId,
      relationshipTypeKey: link.rel ?? 'link',
      predicate: link.rel,
      targetItemId: target.itemId,
      targetTrackerType: target.type,
      metadata: { sentence: link.sentence, count: 1 },
    });
  }
  return [...byEdge.values()];
}

/** Distinct keys a body references, for a single resolution query. */
export function bodyLinkKeys(markdown: string, options: BodyLinkScopeOptions = {}): string[] {
  return [...new Set(parseBodyLinks(markdown, options).map((link) => link.key))];
}
