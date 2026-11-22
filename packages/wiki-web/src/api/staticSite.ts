/**
 * A static export (`nim wiki export --static`): the files under `_wiki/` in
 * place of the `nim wiki serve` API, and routes that are the export's page
 * folders (`/competitors/acme/`) rather than `/page/<id>`. Every exported page
 * sets `window.__NIMBALYST_WIKI_STATIC__` before the app loads; without it the
 * app talks to the server as always. Nothing here writes.
 */
import { searchDocs, type SearchDoc, type StaticSiteConfig, type StaticSiteLink, type StaticSiteManifest } from '@nimbalyst/local-wiki/browser';
import type { LocalPage, LocalSearchHit, LocalWikiSnapshot } from '@nimbalyst/local-wiki';

declare global {
  interface Window {
    __NIMBALYST_WIKI_STATIC__?: StaticSiteConfig;
  }
}

export const staticConfig: StaticSiteConfig | null = typeof window === 'undefined' ? null : window.__NIMBALYST_WIKI_STATIC__ ?? null;
export const staticBasePath = staticConfig?.basePath ?? '/';

export function isStaticSite(): boolean {
  return staticConfig !== null;
}

export class StaticSiteMissingError extends Error {
  constructor(readonly file: string) {
    super(`${file} is not in this export`);
    this.name = 'StaticSiteMissingError';
  }
}

const cache = new Map<string, Promise<unknown>>();

/** A file under the data folder, fetched once per tab. */
export function staticJson<T>(file: string): Promise<T> {
  let pending = cache.get(file) as Promise<T> | undefined;
  if (!pending) {
    pending = fetch(`${staticConfig?.dataPath ?? '/_wiki/'}${file}`).then(async (res) => {
      if (res.status === 404) throw new StaticSiteMissingError(file);
      if (!res.ok) throw new Error(`${file} failed to load (${res.status})`);
      return (await res.json()) as T;
    });
    // A failed fetch is retried on the next call rather than cached.
    pending.catch(() => cache.delete(file));
    cache.set(file, pending);
  }
  return pending;
}

export const dataName = (id: string) => encodeURIComponent(id);

/** The manifest and tree, read at boot so routes and file links resolve synchronously afterwards. */
interface StaticState {
  manifest: StaticSiteManifest;
  snapshot: LocalWikiSnapshot;
  pagesById: Map<string, LocalPage>;
  /** Site path to id. */
  byPath: Map<string, string>;
  /** Site path to type id. */
  typeByPath: Map<string, string>;
  /** Ids of typed pages and table rows: their route is `item`. */
  itemIds: Set<string>;
}

let state: StaticState | null = null;

export async function loadStaticSite(): Promise<StaticState> {
  if (state) return state;
  const [manifest, snapshot] = await Promise.all([staticJson<StaticSiteManifest>('manifest.json'), staticJson<LocalWikiSnapshot>('snapshot.json')]);
  const itemIds = new Set(snapshot.pages.filter((page) => page.type).map((page) => page.id));
  // A table row is in the manifest but not in the page list.
  const pageIds = new Set(snapshot.pages.map((page) => page.id));
  for (const id of Object.keys(manifest.pages)) if (!pageIds.has(id)) itemIds.add(id);
  state = {
    manifest,
    snapshot,
    pagesById: new Map(snapshot.pages.map((page) => [page.id, page])),
    byPath: new Map(Object.entries(manifest.pages).map(([id, sitePath]) => [sitePath, id])),
    typeByPath: new Map(Object.entries(manifest.types).map(([typeId, sitePath]) => [sitePath, typeId])),
    itemIds,
  };
  return state;
}

function loaded(): StaticState {
  if (!state) throw new Error('The static site is not loaded yet');
  return state;
}

export function staticSiteTitle(): string {
  return state?.manifest.title ?? 'Wiki';
}

/** Every exported page and typed page, by id. */
export function staticPages(): ReadonlyMap<string, LocalPage> {
  return loaded().pagesById;
}

// ---------------------------------------------------------------- routes

export type StaticRoute =
  | { kind: 'home' }
  | { kind: 'page'; id: string }
  | { kind: 'item'; id: string }
  | { kind: 'type'; typeId: string }
  | { kind: 'search'; query: string }
  | { kind: 'types' };

const folder = (sitePath: string) => (sitePath ? `${staticBasePath}${sitePath.split('/').map(encodeURIComponent).join('/')}/` : staticBasePath);

export function staticRoutePath(route: StaticRoute): string {
  const site = loaded();
  switch (route.kind) {
    case 'home':
      return staticBasePath;
    case 'page':
    case 'item': {
      const sitePath = site.manifest.pages[route.id];
      return sitePath === undefined ? staticBasePath : folder(sitePath);
    }
    case 'type': {
      const sitePath = site.manifest.types[route.typeId];
      return sitePath === undefined ? folder('types') : folder(sitePath);
    }
    case 'search':
      return route.query ? `${folder('search')}?q=${encodeURIComponent(route.query)}` : folder('search');
    case 'types':
      return folder('types');
  }
}

/** A path no page has opens as a missing page, which says so. */
export const MISSING_PAGE_ID = '__not-in-export__';

export function parseStaticLocation(pathname: string, search: string): StaticRoute {
  const site = loaded();
  if (pathname === staticBasePath.slice(0, -1)) return { kind: 'home' };
  if (!pathname.startsWith(staticBasePath)) return { kind: 'page', id: MISSING_PAGE_ID };
  let sitePath = pathname.slice(staticBasePath.length).replace(/^\/+|\/+$/g, '').replace(/\/index\.html$/i, '');
  try {
    sitePath = decodeURIComponent(sitePath);
  } catch {
    // As written.
  }
  if (sitePath === '' || sitePath === 'index.html') return { kind: 'home' };
  if (sitePath === 'search') return { kind: 'search', query: new URLSearchParams(search).get('q') ?? '' };
  if (sitePath === 'types') return { kind: 'types' };
  const typeId = site.typeByPath.get(sitePath);
  if (typeId) return { kind: 'type', typeId };
  const id = site.byPath.get(sitePath);
  if (!id) return { kind: 'page', id: MISSING_PAGE_ID };
  return site.itemIds.has(id) ? { kind: 'item', id } : { kind: 'page', id };
}

// ---------------------------------------------------------------- data

export function staticSearch(query: string, limit?: number): Promise<LocalSearchHit[]> {
  return staticJson<SearchDoc[]>('search.json').then((docs) => searchDocs(docs, query, limit ?? 50));
}

export function staticLinks(id: string): Promise<StaticSiteLink[]> {
  return staticJson<Record<string, StaticSiteLink[]>>('links.json').then((links) => links[id] ?? []);
}

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

/**
 * Where the export copied a file a page links to: `_wiki/files/<wiki path>`,
 * resolved against the page's folder as `wiki.resolvePageFile` does. The
 * export copied only files a page links to; anything else is a 404 there.
 */
export function staticPageFileUrl(pageId: string, decodedLinkPath: string): string {
  const page = loaded().pagesById.get(pageId);
  const base = page ? (page.path ? page.path.slice(0, Math.max(0, page.path.lastIndexOf('/'))) : page.dir) : '';
  const rel = join(base, decodedLinkPath) ?? decodedLinkPath;
  return `${staticConfig?.dataPath ?? '/_wiki/'}files/${rel.split('/').map(encodeURIComponent).join('/')}`;
}
