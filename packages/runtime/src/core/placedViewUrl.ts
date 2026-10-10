/**
 * A view placed in a page: a link alone on its line whose URL names what to
 * show and whose title holds how to show it.
 *
 *   [Competitors](https://console.nimbalyst.com/org/<o>/project/<p>/view/type/competitor "cols=title,realtime sort=realtime:desc")
 *   [Decided](https://console.nimbalyst.com/app/view/marks?kind=decided)
 *
 * The URL is a console link (Decision 23) for the page's own scope: a team
 * page names its team project, a Personal page is `local`. Pages written
 * before that carry `nimbalyst://view/...`, which still reads.
 *
 * The definition lives in the page, not in a saved-view record, so a page
 * carries its views when it is copied or shared. The link upgrades into an
 * `EmbeddedFileNode` (a view is not a file, so it needs no registered type),
 * and each host's embed renderer branches on `parsePlacedViewUrl`.
 *
 * Title values never contain whitespace or quotes: the embed title is written
 * inside `"..."`, so anything free-form (axis labels, pinned point names) is
 * percent-encoded with `encodeViewAttrValue`.
 *
 * This module is the only place that knows the URL shape: everything else
 * builds with `createPlacedViewUrl` and reads with `parsePlacedViewUrl`, so
 * the scheme can change here alone.
 *
 * Pure (console links come from collab-protocol): it is on the editor's eager path.
 */

import { buildConsoleLink, parseConsoleLink, type ConsoleLinkScope } from '@nimbalyst/collab-protocol';

export type PlacedViewMarksKind = 'decided' | 'open' | 'all';

export type PlacedViewScope = ConsoleLinkScope;

/** `scope` is set when the link is a console link: the team project it names, or `local`. */
export type PlacedViewTarget =
  | { kind: 'type'; typeId: string; scope?: PlacedViewScope }
  | { kind: 'marks'; marks: PlacedViewMarksKind; scope?: PlacedViewScope };

/** Where every pre-console placed-view URL starts; read, no longer written for a scoped page. */
const VIEW_URL_PREFIX = 'nimbalyst://view/';
const TYPE_VIEW_RE = /^type\/([^/?#\s]+)$/i;
const MARKS_VIEW_RE = /^marks(?:\?kind=(decided|open))?$/i;

/** What a placed-view link shows, or null for any other href. The one parser. */
export function parsePlacedViewUrl(url: string | null | undefined): PlacedViewTarget | null {
  const consoleLink = parseConsoleLink(url);
  if (consoleLink?.kind === 'view') return { ...consoleLink.view, scope: consoleLink.scope };
  if (!url || url.slice(0, VIEW_URL_PREFIX.length).toLowerCase() !== VIEW_URL_PREFIX) return null;
  const rest = url.slice(VIEW_URL_PREFIX.length);
  const type = TYPE_VIEW_RE.exec(rest);
  if (type) {
    try {
      return { kind: 'type', typeId: decodeURIComponent(type[1]) };
    } catch {
      return null;
    }
  }
  const marks = MARKS_VIEW_RE.exec(rest);
  if (marks) return { kind: 'marks', marks: (marks[1]?.toLowerCase() as PlacedViewMarksKind | undefined) ?? 'all' };
  return null;
}

/**
 * The one builder; the markdown helpers go through it. With a scope (the
 * page's own) it writes a console link; without one, the older app link.
 */
export function createPlacedViewUrl(target: PlacedViewTarget, scope: PlacedViewScope | undefined = target.scope): string {
  if (scope) {
    const view = target.kind === 'type' ? { kind: 'type' as const, typeId: target.typeId } : { kind: 'marks' as const, marks: target.marks };
    return buildConsoleLink({ kind: 'view', scope, view });
  }
  if (target.kind === 'type') return `${VIEW_URL_PREFIX}type/${encodeURIComponent(target.typeId)}`;
  return target.marks === 'all' ? `${VIEW_URL_PREFIX}marks` : `${VIEW_URL_PREFIX}marks?kind=${target.marks}`;
}

/** Percent-encodes a free-form title value so it holds no space, quote or `=`. */
export function encodeViewAttrValue(value: string): string {
  return encodeURIComponent(value).replace(/'/g, '%27');
}

/** Reverses `encodeViewAttrValue`; a hand-written `+` reads as a space. */
export function decodeViewAttrValue(value: string): string {
  const spaced = value.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/**
 * The markdown a page stores for a placed view. `attrs` values must already be
 * title-safe (see `encodeViewAttrValue`); empty values are dropped.
 */
export function createPlacedViewMarkdown(
  target: PlacedViewTarget,
  label: string,
  attrs: Record<string, string> = {},
  scope?: PlacedViewScope,
): string {
  const safeLabel = label.replace(/[[\]\n]/g, ' ').replace(/\s+/g, ' ').trim() || 'View';
  const title = Object.entries(attrs)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  const url = createPlacedViewUrl(target, scope);
  return title ? `[${safeLabel}](${url} "${title}")` : `[${safeLabel}](${url})`;
}
