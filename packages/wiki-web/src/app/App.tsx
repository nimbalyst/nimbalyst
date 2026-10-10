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
} from '@nimbalyst/collab-bundle/docs-ui';
import { TrackersUIProvider } from '@nimbalyst/collab-bundle/trackers-ui';
import { setWorkspaceFileLinkOpener } from '@nimbalyst/collab-bundle/editor';
import { LocalCollabHost, routePath } from '../host/LocalCollabHost';
import type { LocalTrackerDataSource } from '../host/LocalTrackerDataSource';
import { DraftStore, DraftStoreContext, prepareToLeave, resolveLeave, type LeaveChoice, type LeaveDecision } from './drafts';
import { PageView, SearchView, TypedPageView, TypesView, TypeTableView, type PageModule, type ViewRoute } from './views';

type Route = ViewRoute;

function parseLocation(): Route {
  const { pathname, search } = window.location;
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
  if (route.kind === 'search') return route.query ? `/search?q=${encodeURIComponent(route.query)}` : '/search';
  if (route.kind === 'types') return '/types';
  return routePath(route);
}

type Leaving = { reason: 'conflict' | 'error'; proceed: () => void };

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
  trackers: LocalTrackerDataSource;
  module: PageModule;
}

export function App({ root, trackers, module }: AppProps) {
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

  return (
    <DraftStoreContext.Provider value={drafts}>
    <TrackersUIProvider dataSource={trackers} identity={null}>
      {session ? (
        <CollabDocsUIProvider session={session}>
          <Shell root={root} host={host} route={route} navigate={navigate} trackers={trackers} module={module} notice={notice} onNotice={setNotice} onDismissNotice={() => setNotice(null)} leaving={leaving} onChooseLeave={chooseLeave} />
        </CollabDocsUIProvider>
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-nim-muted">{notice ?? 'Opening the wiki…'}</div>
      )}
    </TrackersUIProvider>
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
      const target = host.resolveLink(openPageId, href);
      if (target.kind === 'outside') onNotice(`${target.path} is not a page in this wiki, so it cannot open here. Open it in your editor or in Nimbalyst.`);
      else navigate(target);
    });
    return () => setWorkspaceFileLinkOpener(null);
  }, [host, navigate, onNotice, openPageId]);

  return (
    <div className="wiki-web-app flex h-full min-h-0">
      <aside className="wiki-web-sidebar flex w-[280px] shrink-0 flex-col border-r border-nim bg-nim-secondary">
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
            onArchiveItem={async (itemId) => {
              await trackers.command({ type: 'archive-item', itemId, archive: true });
            }}
          />
        </div>
      </aside>
      <main className="wiki-web-main flex min-w-0 flex-1 flex-col overflow-auto select-text">
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
