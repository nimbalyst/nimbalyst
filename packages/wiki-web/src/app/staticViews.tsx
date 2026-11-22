/**
 * What a static export shows in place of the editing surfaces: a page tree of
 * plain links (the editable sidebar offers create, rename and drag, none of
 * which a published copy can do) and a page's "Linked from" list, which the
 * export computed from every page's links.
 */
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { LocalPage } from '@nimbalyst/local-wiki';
import { NIMBALYST_MARK_SVG, NIMBALYST_SITE_URL, type StaticSiteLink } from '@nimbalyst/local-wiki/browser';
import { MaterialSymbol } from '@nimbalyst/runtime-source/ui/icons/MaterialSymbol';
import { staticLinks, staticPages, staticRoutePath, staticSiteTitle, type StaticRoute } from '../api/staticSite';
import { currentTheme, onThemeChange, setTheme } from '../theme';

type Navigate = (route: StaticRoute, options?: { newTab?: boolean }) => void;

/** The route for a page or typed page id. */
export function routeForId(id: string, pages: ReadonlyMap<string, LocalPage>): StaticRoute {
  const page = pages.get(id);
  return page && !page.type ? { kind: 'page', id } : { kind: 'item', id };
}

/** A real link, so it can be opened in a new tab or copied; a plain click navigates in place. */
function RouteLink({ route, navigate, className, children }: { route: StaticRoute; navigate: Navigate; className?: string; children: React.ReactNode }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(route);
  };
  return <a href={staticRoutePath(route)} onClick={onClick} className={className}>{children}</a>;
}

function byOrder(a: LocalPage, b: LocalPage): number {
  return (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title);
}

function ThemeToggle() {
  const [theme, setShown] = useState(currentTheme);
  useEffect(() => onThemeChange(setShown), []);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="wiki-static-theme-toggle flex h-6 w-6 shrink-0 items-center justify-center rounded text-nim-muted hover:bg-nim-hover hover:text-nim" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={() => setTheme(next)}>
      <MaterialSymbol icon={theme === 'dark' ? 'light_mode' : 'dark_mode'} size={16} />
    </button>
  );
}

export function StaticSidebar({ activeId, navigate }: { activeId: string | null; navigate: Navigate }) {
  const pages = staticPages();
  const children = useMemo(() => {
    const map = new Map<string | null, LocalPage[]>();
    for (const page of pages.values()) {
      // A page whose parent is not in the export shows at the top.
      const parent = page.parentId && pages.has(page.parentId) ? page.parentId : null;
      map.set(parent, [...(map.get(parent) ?? []), page]);
    }
    for (const list of map.values()) list.sort(byOrder);
    return map;
  }, [pages]);
  const ancestors = useMemo(() => {
    // The open page shows its own children too, so a reader can go one level down from where they are.
    const open = new Set<string>(activeId ? [activeId] : []);
    for (let current = activeId ? pages.get(activeId) : undefined; current?.parentId; current = pages.get(current.parentId)) open.add(current.parentId);
    return open;
  }, [activeId, pages]);
  // A row the reader toggled keeps their choice; the rest open along the path to the open page.
  // Rows opened along a path stay open after the reader moves on, so the tree never folds up under them.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setVisited((previous) => ([...ancestors].every((id) => previous.has(id)) ? previous : new Set([...previous, ...ancestors]))), [ancestors]);
  const isOpen = (id: string) => toggled.get(id) ?? (ancestors.has(id) || visited.has(id));
  const toggle = (id: string) => setToggled((previous) => new Map(previous).set(id, !isOpen(id)));

  const row = (page: LocalPage, depth: number): React.ReactNode => {
    const kids = children.get(page.id) ?? [];
    const open = isOpen(page.id);
    const active = page.id === activeId;
    return (
      <li key={page.id}>
        <div className={`wiki-static-tree-row flex items-center gap-1 rounded py-0.5 pr-2 text-[13px] ${active ? 'bg-nim-selected text-nim' : 'text-nim hover:bg-nim-hover'}`} style={{ paddingLeft: 4 + depth * 14 }}>
          {kids.length ? (
            <button type="button" className="flex h-4 w-4 shrink-0 items-center justify-center text-nim-muted" aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open} onClick={() => toggle(page.id)}>
              <MaterialSymbol icon={open ? 'expand_more' : 'chevron_right'} size={15} />
            </button>
          ) : <span className="h-4 w-4 shrink-0" />}
          <RouteLink route={page.type ? { kind: 'item', id: page.id } : { kind: 'page', id: page.id }} navigate={navigate} className="min-w-0 flex-1 truncate">
            {page.title || 'Untitled'}
          </RouteLink>
        </div>
        {open && kids.length ? <ul className="m-0 list-none p-0">{kids.map((kid) => row(kid, depth + 1))}</ul> : null}
      </li>
    );
  };

  return (
    <nav className="wiki-static-sidebar flex h-full min-h-0 flex-col" aria-label="Pages">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <RouteLink route={{ kind: 'home' }} navigate={navigate} className="min-w-0 flex-1 truncate text-sm font-semibold text-nim">{staticSiteTitle()}</RouteLink>
        <ThemeToggle />
      </div>
      <form
        className="px-3 pb-2"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const query = new FormData(event.currentTarget).get('q');
          if (typeof query === 'string' && query.trim()) navigate({ kind: 'search', query: query.trim() });
        }}
      >
        <input name="q" className="w-full rounded-md border border-nim bg-nim px-2 py-1 text-[13px] text-nim outline-none focus:border-nim-focus" placeholder="Search" aria-label="Search this wiki" />
      </form>
      <ul className="m-0 min-h-0 flex-1 list-none overflow-auto px-1 pb-3">{(children.get(null) ?? []).map((page) => row(page, 0))}</ul>
      <div className="flex items-center gap-2 border-t border-nim px-3 py-2 text-[13px]">
        <RouteLink route={{ kind: 'types' }} navigate={navigate} className="text-nim-muted hover:text-nim">Types</RouteLink>
        <a href={NIMBALYST_SITE_URL} target="_blank" rel="noopener" className="wiki-static-made-with ml-auto flex items-center gap-1.5 text-xs text-nim-faint hover:text-nim">
          <span className="flex" dangerouslySetInnerHTML={{ __html: NIMBALYST_MARK_SVG }} />
          Made with Nimbalyst
        </a>
      </div>
    </nav>
  );
}

/** Pages that link to this one, with the sentence each link sits in. */
export function StaticBacklinks({ pageId, navigate }: { pageId: string; navigate: Navigate }) {
  const [links, setLinks] = useState<StaticSiteLink[]>([]);
  useEffect(() => {
    let live = true;
    void staticLinks(pageId).then((next) => {
      if (live) setLinks(next.filter((link) => link.direction === 'in'));
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [pageId]);
  const pages = staticPages();
  const unique = [...new Map(links.map((link) => [link.otherItemId, link])).values()];
  if (unique.length === 0) return null;
  return (
    <section className="wiki-static-backlinks mx-8 mb-8 mt-2 border-t border-nim pt-3 select-text" aria-label="Linked from">
      <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-nim-muted">Linked from</h4>
      <ul className="m-0 list-none p-0">
        {unique.map((link) => (
          <li key={link.otherItemId} className="py-1 text-[13px]">
            <RouteLink route={routeForId(link.otherItemId, pages)} navigate={navigate} className="font-medium text-nim-link hover:underline">{link.otherTitle || 'Untitled'}</RouteLink>
            {link.sentence ? <div className="text-xs text-nim-muted">{link.sentence}</div> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
