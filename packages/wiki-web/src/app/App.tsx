/**
 * The shell: the page tree on the left, the open page on the right. Routes are
 * real paths (`/page/<id>`, `/item/<id>`, `/type/<typeId>`, `/search?q=`), so
 * a tree row is a link and Back works; the server answers every one of them
 * with `index.html`.
 *
 * Leaving a page with unsaved edits first finishes their save; if the file
 * changed underneath or the write fails, the person chooses before the page
 * closes (see `drafts.ts`). Closing or reloading the tab is guarded the same way.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CollabDocsUIProvider,
  CollabSidebar,
  PagesSectionEntries,
  createCollabDocsScopeLifecycle,
  useCollabPagesState,
  type CollabDocsSession,
  type CollabSidebarCreateMenu,
} from '@nimbalyst/collab-bundle/docs-ui';
import { createTrackerReferenceResolver, TrackersUIProvider } from '@nimbalyst/collab-bundle/trackers-ui';
import { PageEditorServicesContext, type PageEditorServices } from './pageEditorServices';
import { setWorkspaceFileLinkOpener } from '@nimbalyst/collab-bundle/editor';
import { MaterialSymbol } from '@nimbalyst/runtime-source/ui/icons/MaterialSymbol';
import { wikiApi, wikiChanges } from '../api/client';
import { isStaticSite, parseStaticLocation, staticRoutePath } from '../api/staticSite';
import { LocalCollabHost, routePath } from '../host/LocalCollabHost';
import type { LocalTrackerDataSource } from '../host/LocalTrackerDataSource';
import { DraftStore, DraftStoreContext, prepareToLeave, resolveLeave, type LeaveChoice, type LeaveDecision } from './drafts';
import { PageView, SearchView, TypedPageView, TypesView, TypeTableView, type PageModule, type ViewRoute } from './views';
import { WikiCreateMenu } from './WikiCreateMenu';
import { setWikiCanvasContext } from '../editors/canvas/WikiCanvasCard';
import { renderWikiFileEmbed } from '../editors/WikiFileEmbed';
import { setWikiHtmlNavigator } from '../editors/html/htmlPages';
import { openWikiHtmlLink } from '../editors/html/wikiHtmlNavigation';
import { StaticSidebar } from './staticViews';

type Route = ViewRoute;

function parseLocation(): Route {
  const { pathname, search } = window.location;
  if (isStaticSite()) return parseStaticLocation(pathname, search);
  const [, kind, raw] = pathname.split('/');
  const value = raw ? decodeURIComponent(raw) : '';
  if (kind === 'page' && value) return { kind: 'page', id: value };
  if (kind === 'item' && value) return { kind: 'item', id: value };
  if (kind === 'type' && value) return { kind: 'type', typeId: value };
  if (kind === 'search') return { kind: 'search', query: new URLSearchParams(search).get('q') ?? '' };
  if (kind === 'types') return { kind: 'types' };
  return { kind: 'home' };
}

function pathOf(route: Route): string {
  if (isStaticSite()) return staticRoutePath(route);
  if (route.kind === 'search') return route.query ? `/search?q=${encodeURIComponent(route.query)}` : '/search';
  if (route.kind === 'types') return '/types';
  return routePath(route);
}

type Leaving = { reason: 'conflict' | 'error'; proceed: () => void };

/** Whether the wiki server answers; it stops when the agent session that started it ends. */
function useServerReachable(): boolean {
  const [reachable, setReachable] = useState(() => wikiChanges.isReachable());
  useEffect(() => wikiChanges.subscribe(() => setReachable(wikiChanges.isReachable())), []);
  return reachable;
}

function useRoute(drafts: DraftStore): [Route, (route: Route, options?: { newTab?: boolean }) => void, Leaving | null, (choice: LeaveChoice) => void] {
  const [route, setRoute] = useState<Route>(parseLocation);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const routeRef = useRef(route);
  routeRef.current = route;

  const go = useCallback((next: Route, push: boolean) => {
    const path = pathOf(next);
    if (push && path !== window.location.pathname + window.location.search) window.history.pushState(null, '', path);
    setLeaving(null);
    setRoute(next);
  }, []);
  const decide = useCallback((decision: LeaveDecision, proceed: () => void) => {
    if (decision.kind === 'leave') proceed();
    else if (decision.kind === 'ask') setLeaving({ reason: decision.reason, proceed });
  }, []);

  useEffect(() => {
    const onPop = () => {
      const next = parseLocation();
      void prepareToLeave(drafts).then((decision) => {
        // The address bar already moved; put it back until the person chooses.
        if (decision.kind !== 'leave') window.history.pushState(null, '', pathOf(routeRef.current));
        decide(decision, () => go(next, decision.kind !== 'leave'));
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [decide, drafts, go]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!drafts.hasUnsaved()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [drafts]);

  const navigate = useCallback((next: Route, options?: { newTab?: boolean }) => {
    if (options?.newTab) {
      window.open(pathOf(next), '_blank', 'noopener');
      return;
    }
    // Same page: nothing closes.
    if (pathOf(next) === pathOf(routeRef.current)) {
      go(next, true);
      return;
    }
    void prepareToLeave(drafts).then((decision) => decide(decision, () => go(next, true)));
  }, [decide, drafts, go]);

  const choose = useCallback((choice: LeaveChoice) => {
    const pending = leaving;
    if (!pending) return;
    void resolveLeave(drafts, choice).then((decision) => {
      if (decision.kind === 'stay') setLeaving(null);
      else decide(decision, pending.proceed);
    });
  }, [decide, drafts, leaving]);

  return [route, navigate, leaving, choose];
}

export interface AppProps {
  root: string;
  /** The project the wiki belongs to; canvas cards name files relative to it. */
  projectRoot: string | null;
  trackers: LocalTrackerDataSource;
  module: PageModule;
}

export function App({ root, projectRoot, trackers, module }: AppProps) {
  const drafts = useMemo(() => new DraftStore(), []);
  const [route, navigate, leaving, chooseLeave] = useRoute(drafts);
  const [notice, setNotice] = useState<string | null>(null);
  const [session, setSession] = useState<CollabDocsSession | null>(null);
  const host = useMemo(() => new LocalCollabHost(root, navigate, setNotice), [root, navigate]);

  useEffect(() => {
    const lifecycle = createCollabDocsScopeLifecycle(host, {
      onSessionChanged: setSession,
      onError: (error) => setNotice(`The page tree could not load: ${error instanceof Error ? error.message : String(error)}`),
    });
    lifecycle.start();
    return () => lifecycle.dispose();
  }, [host]);

  // References in page bodies resolve against the wiki's own typed pages and rows; a click opens the item here.
  const trackerReferences = useMemo(
    () => createTrackerReferenceResolver(trackers, { onOpenItem: (id) => navigate({ kind: 'item', id }) }),
    [trackers, navigate],
  );
  useEffect(() => () => trackerReferences.dispose(), [trackerReferences]);
  const editorServices = useMemo<PageEditorServices>(
    () => ({
      pageLinks: (pageId) => host.pageLinkSource(pageId),
      fileEmbed: (pageId, embed) => {
        const target = host.resolveLink(pageId, embed.src);
        return renderWikiFileEmbed(embed, target.kind === 'outside' ? null : host.source().page(target.id) ?? null, drafts);
      },
      trackerReferences,
    }),
    [host, trackerReferences, drafts],
  );

  // A link clicked inside an HTML page; with no embedding page, the open page.
  const routeRef = useRef(route);
  routeRef.current = route;
  useEffect(() => {
    setWikiHtmlNavigator((fromPageId, href, options) => {
      const current = routeRef.current;
      const from = fromPageId ?? (current.kind === 'page' || current.kind === 'item' ? current.id : null);
      openWikiHtmlLink(href, options, from, {
        resolveLink: (pageId, link) => host.resolveLink(pageId, link),
        navigate,
        itemIdForKey: (key) => {
          const resolved = trackerReferences.resolve(key);
          return resolved.state === 'resolved' ? resolved.item.id : null;
        },
        openExternal: (link) => window.open(link, '_blank', 'noopener'),
        notice: setNotice,
      });
    });
    return () => setWikiHtmlNavigator(null);
  }, [host, navigate, trackerReferences]);

  useEffect(() => setWikiCanvasContext({
    wikiRoot: root,
    projectRoot,
    pages: () => host.source().allPages(),
    subscribe: (listener) => host.source().subscribe((change) => {
      if (change.type === 'snapshot') listener();
    }),
  }), [host, root, projectRoot]);

  return (
    <DraftStoreContext.Provider value={drafts}>
    <PageEditorServicesContext.Provider value={editorServices}>
    <TrackersUIProvider dataSource={trackers} identity={null}>
      {session ? (
        <CollabDocsUIProvider session={session}>
          <Shell root={root} host={host} route={route} navigate={navigate} trackers={trackers} module={module} notice={notice} onNotice={setNotice} onDismissNotice={() => setNotice(null)} leaving={leaving} onChooseLeave={chooseLeave} />
        </CollabDocsUIProvider>
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-nim-muted">{notice ?? 'Opening the wiki…'}</div>
      )}
    </TrackersUIProvider>
    </PageEditorServicesContext.Provider>
    </DraftStoreContext.Provider>
  );
}

function joinPath(root: string, relative: string | null): string | null {
  if (!relative) return null;
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${relative.split('/').join(separator)}`;
}

function Shell({
  root,
  host,
  route,
  navigate,
  trackers,
  module,
  notice,
  onNotice,
  onDismissNotice,
  leaving,
  onChooseLeave,
}: {
  root: string;
  host: LocalCollabHost;
  route: Route;
  navigate: (route: Route, options?: { newTab?: boolean }) => void;
  trackers: LocalTrackerDataSource;
  module: PageModule;
  notice: string | null;
  onNotice: (message: string) => void;
  onDismissNotice: () => void;
  leaving: Leaving | null;
  onChooseLeave: (choice: LeaveChoice) => void;
}) {
  const typeResolver = module.useBrowserTypeResolver('team');
  const { documents } = useCollabPagesState();
  const [createMenu, setCreateMenu] = useState<CollabSidebarCreateMenu | null>(null);
  const reachable = useServerReachable();
  const published = isStaticSite();
  // Narrow screens: the tree is a drawer over the page, opened from the bar; picking a page,
  // tapping outside it or Escape closes it. Wide screens show the tree as a column and ignore this.
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [route]);
  useEffect(() => {
    if (!navOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  // Home is the first top-level page, as `nim wiki init` writes one.
  const home = useMemo(
    () => documents.filter((document) => !document.parentFolderId).sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) || a.title.localeCompare(b.title))[0] ?? null,
    [documents],
  );
  const resolved: Route = route.kind === 'home' && home ? { kind: 'page', id: home.documentId } : route;
  const open = (next: Route) => ({ newTab }: { newTab: boolean }) => navigate(next, { newTab });

  // A relative link in the open page's body (`Personas/CMO.md`) opens that page here.
  // Without an opener the editor swallows the click and nothing happens.
  const openPageId = resolved.kind === 'page' || resolved.kind === 'item' ? resolved.id : null;
  useEffect(() => {
    if (!openPageId) return undefined;
    setWorkspaceFileLinkOpener((href) => {
      // A published wiki writes links to the items it carries from the app's tracker as site paths (`/items/<id>/`).
      if (published && href.startsWith('/') && !href.startsWith('//')) {
        const [pathname, search = ''] = href.split('?');
        navigate(parseStaticLocation(pathname, search ? `?${search}` : ''));
        return;
      }
      const target = host.resolveLink(openPageId, href);
      // An attachment or other file beside the page opens from the server, as the browser shows it.
      if (target.kind === 'outside' && !/\.md$/i.test(target.path) && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        window.open(wikiApi.pageFileUrl(openPageId, href.replace(/[?#].*$/, '')), '_blank', 'noopener');
      } else if (target.kind === 'outside') onNotice(published ? `${target.path} is not part of this published wiki.` : `${target.path} is not a page in this wiki, so it cannot open here. Open it in your editor or in Nimbalyst.`);
      else navigate(target);
    });
    return () => setWorkspaceFileLinkOpener(null);
  }, [host, navigate, onNotice, openPageId, published]);

  return (
    <div className={`wiki-web-app flex h-full min-h-0 ${published ? 'wiki-static-app' : ''}`}>
      {published ? (
        <div className="wiki-static-topbar items-center gap-2 border-b border-nim bg-nim-secondary px-3 py-2">
          <button type="button" className="flex items-center text-nim-muted hover:text-nim" aria-label={navOpen ? 'Hide pages' : 'Show pages'} aria-expanded={navOpen} onClick={() => setNavOpen((open) => !open)}>
            <MaterialSymbol icon={navOpen ? 'close' : 'menu'} size={20} />
          </button>
        </div>
      ) : null}
      {published ? <button type="button" className="wiki-static-scrim" data-open={navOpen} aria-label="Hide pages" tabIndex={-1} onClick={() => setNavOpen(false)} /> : null}
      {published ? (
        // Shown and hidden by styles.css, not utilities: an extension bundle injects its own `.flex`/`.hidden` later in the page.
        <aside className="wiki-web-sidebar wiki-static-sidebar-panel w-[280px] shrink-0 flex-col border-r border-nim bg-nim-secondary" data-open={navOpen}>
          <StaticSidebar activeId={resolved.kind === 'page' || resolved.kind === 'item' ? resolved.id : null} navigate={navigate} />
        </aside>
      ) : (
      <aside className="wiki-web-sidebar flex w-[280px] shrink-0 flex-col border-r border-nim bg-nim-secondary">
        <WikiCreateMenu menu={createMenu} />
        <div className="min-h-0 flex-1">
          {/* As the desktop's Wiki section: a compact section label and the Home / Search / Types rows above the tree. */}
          <CollabSidebar
            activeDocumentId={resolved.kind === 'page' ? resolved.id : null}
            activeItemId={resolved.kind === 'item' ? resolved.id : null}
            activeTypeId={resolved.kind === 'type' ? resolved.typeId : null}
            sectionTitle="Local wiki"
            sectionEntries={(
              <PagesSectionEntries
                active={resolved.kind === 'search' ? 'search' : resolved.kind === 'types' ? 'types' : resolved.kind === 'page' && resolved.id === home?.documentId ? 'home' : null}
                onOpenHome={home ? open({ kind: 'page', id: home.documentId }) : undefined}
                onOpenSearch={open({ kind: 'search', query: '' })}
                onOpenTypes={open({ kind: 'types' })}
              />
            )}
            typeResolver={typeResolver}
            registerCreateMenu={setCreateMenu}
            onArchiveItem={async (itemId) => {
              await trackers.command({ type: 'archive-item', itemId, archive: true });
            }}
          />
        </div>
      </aside>
      )}
      <main className="wiki-web-main flex min-w-0 flex-1 flex-col overflow-auto select-text">
        {reachable ? null : (
          <div className="wiki-web-server-down border-b border-nim bg-nim-secondary px-4 py-2 text-xs text-nim" role="alert">
            The wiki server stopped, so changes made here are not saved. Ask your agent to open the wiki in the browser again, or run <code>nim wiki serve</code>; this page reconnects on its own.
          </div>
        )}
        {notice ? (
          <div className="wiki-web-notice flex items-start gap-2 border-b border-nim bg-nim-secondary px-4 py-2 text-xs text-nim" role="alert">
            <span className="flex-1">{notice}</span>
            <button type="button" className="text-nim-muted hover:text-nim" onClick={onDismissNotice}>Dismiss</button>
          </div>
        ) : null}
        {leaving ? (
          <div className="wiki-web-leave-conflict mx-8 my-2 flex flex-wrap items-center gap-2 rounded border border-nim bg-nim-secondary px-3 py-2 text-xs text-nim" role="alert">
            <span className="flex-1">
              {leaving.reason === 'conflict'
                ? 'Your edits to this page are not saved: the file changed on disk while you were editing it.'
                : 'Your edits to this page could not be saved.'}
            </span>
            <button type="button" className="rounded border border-nim px-2 py-1 hover:bg-nim-hover" onClick={() => onChooseLeave('keep')}>Keep editing</button>
            <button type="button" className="rounded border border-nim px-2 py-1 hover:bg-nim-hover" onClick={() => onChooseLeave('discard')}>Discard my changes</button>
            <button type="button" className="rounded border border-nim px-2 py-1 hover:bg-nim-hover" onClick={() => onChooseLeave('overwrite')}>Use mine and overwrite the file</button>
          </div>
        ) : null}
        {resolved.kind === 'page' ? <PageView pageId={resolved.id} filePath={joinPath(root, host.pagePath(resolved.id))} navigate={navigate} />
          : resolved.kind === 'item' ? <TypedPageView itemId={resolved.id} module={module} trackers={trackers} navigate={navigate} />
            : resolved.kind === 'type' ? <TypeTableView typeId={resolved.typeId} module={module} trackers={trackers} navigate={navigate} />
              : resolved.kind === 'search' ? <SearchView query={resolved.query} navigate={navigate} />
                : resolved.kind === 'types' ? <TypesView trackers={trackers} navigate={navigate} />
                : <div className="px-8 py-6 text-sm text-nim-muted">This wiki has no pages yet. Create one from the tree.</div>}
      </main>
    </div>
  );
}
