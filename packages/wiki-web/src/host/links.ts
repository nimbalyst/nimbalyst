/**
 * A relative link in a page body (`[CMO](Personas/CMO.md "id=...")`, the
 * format FORMAT.md defines) resolved to the page it names. The editor hands
 * the href as written; it is relative to the linking page's file.
 */
import type { LocalPage } from '@nimbalyst/local-wiki';

export type LinkTarget =
  | { kind: 'page'; id: string }
  | { kind: 'item'; id: string }
  /** A file the wiki does not hold: outside its folder, or not a page. */
  | { kind: 'outside'; path: string };

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** `base` joined with `relative`, `.` and `..` folded; null when it climbs out of the wiki. */
function join(base: string, relative: string): string | null {
  const parts = base ? base.split('/') : [];
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function decode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function resolveWikiLink(pages: Iterable<LocalPage>, fromPath: string | null, href: string): LinkTarget {
  const bare = href.trim().replace(/[?#].*$/, '');
  const relative = decode(bare);
  const target = relative.startsWith('/') ? relative.replace(/^\/+/, '') : join(dirname(fromPath ?? ''), relative);
  if (target === null) return { kind: 'outside', path: relative };
  const folder = target.replace(/\/+$/, '');
  for (const page of pages) {
    if (page.trashedAt !== null) continue;
    // A page file, or a link to a page's child folder (`Ops/`).
    if (page.path === target || (bare.endsWith('/') && page.dir === folder)) {
      return page.type ? { kind: 'item', id: page.id } : { kind: 'page', id: page.id };
    }
  }
  return { kind: 'outside', path: target };
}
