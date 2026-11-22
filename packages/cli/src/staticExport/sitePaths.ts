/**
 * Where each exported page lives on the site: a folder per page, named from
 * its place in the wiki (`Competitors/Acme.md` is `competitors/acme/`), so a
 * link reads like the tree. The id is the tiebreaker when two names fold to
 * the same path. Table rows have no file, so they live under `items/<id>`.
 */
import { STATIC_SITE_DATA_DIR, type LocalPage, type LocalTrackerItem } from '@nimbalyst/local-wiki';

/** Top-level folders the site itself uses; a page that folds to one gets its id appended. */
const RESERVED_TOP = new Set(['assets', 'extensions', 'html-embed', STATIC_SITE_DATA_DIR, 'search', 'types', 'items', '404.html', 'index.html']);

/** A site mount path, with leading/trailing slashes and URL-encoded segments. */
export function normalizeBasePath(base = '/'): string {
  const invalid = () => new Error('--base must be an absolute URL path such as /docs/ (no URL, query, fragment, or dot segments)');
  if (!base.startsWith('/') || base.startsWith('//') || /[?#\\\x00-\x1f\x7f]/.test(base)) throw invalid();
  if (base === '/') return base;
  const parts = base.replace(/\/$/, '').slice(1).split('/').map((part) => {
    let decoded: string;
    try { decoded = decodeURIComponent(part); } catch { throw invalid(); }
    if (!decoded || decoded === '.' || decoded === '..' || /[/\\\x00-\x1f\x7f]/.test(decoded)) throw invalid();
    return encodeURIComponent(decoded);
  });
  return `/${parts.join('/')}/`;
}

export function slugSegment(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'page';
}

/** The page's place in the tree as a path: its file without `.md`, or its folder. */
function treePath(page: LocalPage): string {
  const source = page.path ?? page.dir;
  const withoutMarkdown = source.replace(/\/(README|index)\.md$/i, '').replace(/\.md$/i, '');
  return withoutMarkdown.split('/').filter(Boolean).map(slugSegment).join('/');
}

function idSuffix(id: string): string {
  return slugSegment(id.slice(-8));
}

export interface SitePaths {
  pages: Record<string, string>;
  types: Record<string, string>;
}

/** `homeId` is the site root (''); everything else gets a folder. */
export function assignSitePaths(pages: readonly LocalPage[], rows: readonly LocalTrackerItem[], typeIds: readonly string[], homeId: string | null): SitePaths {
  const taken = new Set<string>(['']);
  /** `site`: a path in the site's own `items/` or `types/` folder, which pages may not take. */
  const claim = (wanted: string, id: string, site = false): string => {
    let candidate = wanted || 'page';
    if (!site && RESERVED_TOP.has(candidate.split('/')[0])) candidate = `${candidate}-${idSuffix(id)}`;
    if (taken.has(candidate)) candidate = `${candidate}-${idSuffix(id)}`;
    for (let n = 2; taken.has(candidate); n++) candidate = `${wanted}-${idSuffix(id)}-${n}`;
    taken.add(candidate);
    return candidate;
  };
  const out: SitePaths = { pages: {}, types: {} };
  if (homeId) out.pages[homeId] = '';
  // Shallow pages first, so a parent keeps its plain name when a child collides with it.
  const ordered = [...pages].sort((a, b) => treePath(a).split('/').length - treePath(b).split('/').length || treePath(a).localeCompare(treePath(b)) || a.id.localeCompare(b.id));
  for (const page of ordered) if (page.id !== homeId) out.pages[page.id] = claim(treePath(page), page.id);
  for (const row of rows) if (!out.pages[row.id]) out.pages[row.id] = claim(`items/${slugSegment(row.id)}`, row.id, true);
  for (const typeId of typeIds) out.types[typeId] = claim(`types/${slugSegment(typeId)}`, typeId, true);
  return out;
}

/** `../` repeated once per folder of `sitePath`, for a page's relative links back to the site root. */
export function rootPrefix(sitePath: string): string {
  return sitePath ? '../'.repeat(sitePath.split('/').length) : './';
}
