/**
 * The links in an exported page body. A link to a page that is in the export
 * stays as written; the browser app resolves it the way `nim wiki serve` does.
 * Everything a reader of the site could not open becomes its label as plain
 * text, so neither the app nor the prerendered HTML shows a dead link:
 *
 * - a page left out of the export, or one the wiki does not have;
 * - `nimbalyst://` and `collab://` references, which open only in the app,
 *   except a tracker item the export carries (`nimbalyst://USR.64`), which
 *   links to that item's page;
 * - console links to tracker items and team pages, unless the export keeps
 *   them (`outsideRefs: 'console'`). A console link to an item that is in the
 *   export is pointed at that item's page instead.
 *
 * What changed is reported, so the person exporting sees what readers lose.
 */
import * as path from 'node:path';
import { findLinks, encodeLinkPath, type LocalPage } from '@nimbalyst/local-wiki';

export type OutsideRefs = 'text' | 'console';

export interface LinkIssue {
  pageId: string;
  pageTitle: string;
  href: string;
  /** `outside-wiki`: a relative link that leaves the wiki folder, such as a repository doc. */
  kind: 'excluded-page' | 'missing-page' | 'outside-wiki' | 'app-only' | 'outside' | 'missing-file';
  /** In the body of a carried tracker item, not a wiki page. */
  inTrackerItem?: boolean;
}

export interface OutgoingLink {
  targetId: string;
  sentence: string;
}

export interface LinkContext {
  /** Every live page, exported or not, by id. */
  pages: ReadonlyMap<string, LocalPage>;
  /** Ids in the export. */
  included: ReadonlySet<string>;
  outsideRefs: OutsideRefs;
  /** Whether a wiki-relative file exists (attachments, images). */
  fileExists: (rel: string) => boolean;
  /**
   * The site URL (`/items/<id>/`) and id of a tracker item the export carries,
   * for a reference from `trackerRef`; null when it does not carry it.
   */
  trackerItem?: (ref: string) => { id: string; href: string } | null;
}

const CONSOLE_HOST = /^https?:\/\/console\.nimbalyst\.com\//i;
const APP_ONLY = /^(nimbalyst|collab):/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const TRACKER_URN = /^nimbalyst:\/\/(?!doc\/)([^/?#\s]+)\/?$/i;
const IMAGE = /!\[[^\]\n]*\]\(\s*<?([^\s)<>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Last path segment of a console URL: `.../page/item/<key>`, `.../app/item/<id>`, `.../document/<id>`. */
function consoleTarget(href: string): string {
  try {
    return decodeURIComponent(href.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? '');
  } catch {
    return '';
  }
}

/**
 * The tracker item a link names, as an issue key or id: `nimbalyst://USR.64`,
 * or a console item URL. Null for anything else, including `nimbalyst://doc/`.
 */
export function trackerRef(href: string): string | null {
  const urn = TRACKER_URN.exec(href.trim());
  if (urn) return urn[1];
  if (CONSOLE_HOST.test(href) && /\/item\//i.test(href)) return consoleTarget(href) || null;
  return null;
}

/** Folder a page's links are written relative to (as `linkBaseDir` in the library). */
export function linkBase(page: Pick<LocalPage, 'path' | 'dir'>): string {
  return page.path ? path.posix.dirname(page.path).replace(/^\.$/, '') : page.dir;
}

/** Wiki-relative target of a relative link; null when it climbs out of the wiki. */
export function resolveRelative(fromDir: string, linkPath: string): string | null {
  const joined = path.posix.normalize(path.posix.join(fromDir === '' ? '.' : fromDir, linkPath));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return null;
  return joined === '.' ? '' : joined.replace(/\/$/, '');
}

function findByPath(pages: ReadonlyMap<string, LocalPage>, target: string, folder: boolean): LocalPage | null {
  const key = target.toLowerCase();
  for (const page of pages.values()) {
    if (!folder && page.path?.toLowerCase() === key) return page;
    if (page.dir.toLowerCase() === key && (folder || !page.path)) return page;
  }
  return null;
}

/** The line around a link, with link syntax reduced to its labels: what the Links section shows. */
function sentenceAround(body: string, start: number): string {
  const lineStart = body.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = body.indexOf('\n', start);
  const line = body.slice(lineStart, lineEnd < 0 ? body.length : lineEnd);
  const text = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+\.|#{1,6}|>)\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export interface RewrittenBody {
  markdown: string;
  outgoing: OutgoingLink[];
  issues: LinkIssue[];
  /** Wiki-relative files the body links to or shows that exist: what the export copies. */
  files: string[];
}

/** `page`: a wiki page, or a carried tracker item, which has no file (`path: null, dir: ''`). */
export function rewriteBodyLinks(page: Pick<LocalPage, 'id' | 'title' | 'path' | 'dir'>, body: string, ctx: LinkContext): RewrittenBody {
  const base = linkBase(page);
  const outgoing: OutgoingLink[] = [];
  const issues: LinkIssue[] = [];
  const files = new Set<string>();
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const issue = (href: string, kind: LinkIssue['kind']) => issues.push({ pageId: page.id, pageTitle: page.title, href, kind });
  const asText = (link: { start: number; end: number; text: string }) => edits.push({ start: link.start, end: link.end, text: link.text });

  for (const link of findLinks(body)) {
    const href = link.path + link.fragment;
    if (link.isPageLink) {
      const resolved = link.id && ctx.pages.has(link.id)
        ? ctx.pages.get(link.id) ?? null
        : (() => {
            const target = resolveRelative(base, link.path);
            return target === null ? null : findByPath(ctx.pages, target, link.path.endsWith('/'));
          })();
      if (resolved && ctx.included.has(resolved.id)) {
        outgoing.push({ targetId: resolved.id, sentence: sentenceAround(body, link.start) });
      } else {
        issue(href, resolved ? 'excluded-page' : link.id === null && resolveRelative(base, link.path) === null ? 'outside-wiki' : 'missing-page');
        asText(link);
      }
      continue;
    }
    const tracker = trackerRef(link.path);
    const carried = tracker !== null && !ctx.included.has(tracker) ? ctx.trackerItem?.(tracker) ?? null : null;
    if (carried) {
      edits.push({ start: link.start, end: link.end, text: `[${link.text}](${carried.href})` });
      outgoing.push({ targetId: carried.id, sentence: sentenceAround(body, link.start) });
      continue;
    }
    if (APP_ONLY.test(link.path)) {
      issue(href, 'app-only');
      asText(link);
      continue;
    }
    if (CONSOLE_HOST.test(link.path)) {
      const last = consoleTarget(link.path);
      const target = ctx.included.has(last) ? ctx.pages.get(last) : undefined;
      if (target?.path) {
        const relative = path.posix.relative(base || '.', target.path);
        edits.push({ start: link.start, end: link.end, text: `[${link.text}](${encodeLinkPath(relative)} "id=${target.id}")` });
        outgoing.push({ targetId: target.id, sentence: sentenceAround(body, link.start) });
      } else {
        issue(href, 'outside');
        if (ctx.outsideRefs === 'text') asText(link);
      }
      continue;
    }
    if (SCHEME.test(link.path) || link.path === '') continue;
    const file = resolveRelative(base, link.path.replace(/[?#].*$/, ''));
    if (file !== null && ctx.fileExists(file)) files.add(file);
    else issue(href, 'missing-file');
  }

  IMAGE.lastIndex = 0;
  for (let match = IMAGE.exec(body); match; match = IMAGE.exec(body)) {
    const src = match[1];
    if (SCHEME.test(src) || src.startsWith('/')) continue;
    let decoded = src;
    try {
      decoded = decodeURIComponent(src);
    } catch {
      // As written.
    }
    const file = resolveRelative(base, decoded);
    if (file !== null && ctx.fileExists(file)) files.add(file);
    else issue(src, 'missing-file');
  }

  let markdown = body;
  for (const edit of edits.sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
  return { markdown, outgoing, issues, files: [...files] };
}
