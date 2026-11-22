/**
 * The main pane's views: a plain page, a typed page, a type's table, search.
 * Each reads the tree from the docs session and items from the tracker
 * provider, the same stores the sidebar reads.
 */
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { ReactNode } from 'react';
import { EditorBreadcrumb, EditorHeaderBar, useCollabPagesState, useSharedFolders, type BreadcrumbCrumb } from '@nimbalyst/collab-bundle/docs-ui';
import {
  TrackerSurfaceMessage,
  useTrackerCommand,
  useTrackerDataSelector,
  type loadTrackerPage,
} from '@nimbalyst/collab-bundle/trackers-ui';
import type { LocalSearchHit } from '@nimbalyst/local-wiki';
import { wikiApi } from '../api/client';
import { isStaticSite, staticLinks, staticPages, staticSiteTitle } from '../api/staticSite';
import { routeForId, StaticBacklinks } from './staticViews';
import type { WikiRoute } from '../host/LocalCollabHost';
import type { LocalTrackerDataSource } from '../host/LocalTrackerDataSource';
import { ExtensionPageEditor } from '../editors/ExtensionPageEditor';
import { editorForFile } from '../editors/wikiEditors';
import { PageEditor, saveStateLabel, type SaveState } from './PageEditor';
import { typedPageEditing } from './typedPageEditing';

export type PageModule = Awaited<ReturnType<typeof loadTrackerPage>>;
/** The host's routes plus the views only the app has. */
export type ViewRoute = WikiRoute | { kind: 'search'; query: string } | { kind: 'types' };
type Navigate = (route: ViewRoute) => void;

function usePageTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    document.title = `${title || 'Untitled'} · ${isStaticSite() ? staticSiteTitle() : 'Local wiki'}`;
  }, [title]);
}

/** Redraws when the type definitions change (a type file edited, a table converted). */
function useWikiTypes(trackers: LocalTrackerDataSource): void {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => trackers.subscribeTypes(redraw), [trackers]);
}

/**
 * Converts a table type to page storage, after a second click to confirm. The
 * rows keep their ids, so an open row becomes its page in place.
 */
function ConvertToPagesAction({ typeId, plural, trackers }: { typeId: string; plural: string; trackers: LocalTrackerDataSource }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);
  const convert = async () => {
    setStep('busy');
    setError(null);
    try {
      await wikiApi.convertTypeToPages(typeId);
      await trackers.reloadTypes();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStep('idle');
    }
  };
  const button = 'rounded border border-nim px-2 py-1 text-xs text-nim hover:bg-nim-hover disabled:opacity-50';
  return (
    <span className="wiki-web-convert-type inline-flex flex-wrap items-center gap-2" data-testid="wiki-web-convert-type">
      {step === 'confirm' ? (
        <>
          <span className="text-xs text-nim-muted">Make every row of {plural} its own page? The CSV goes to the wiki trash.</span>
          <button type="button" className={button} onClick={() => void convert()}>Convert</button>
          <button type="button" className={button} onClick={() => setStep('idle')}>Cancel</button>
        </>
      ) : (
        <button type="button" className={button} disabled={step === 'busy'} onClick={() => setStep('confirm')}>
          {step === 'busy' ? 'Converting…' : 'Convert this type to pages'}
        </button>
      )}
      {error ? <span className="text-xs text-nim-error" role="alert">{error}</span> : null}
    </span>
  );
}

/** Problems in a type's file, such as a field name Nimbalyst reserves, which leave values blank. */
function TypeProblems({ problems }: { problems: readonly string[] | undefined }) {
  if (!problems?.length) return null;
  return (
    <div className="wiki-web-type-problems mx-8 mt-3 rounded border border-nim bg-nim-secondary px-3 py-2 text-xs text-nim" role="alert">
      {problems.map((problem) => <div key={problem}>{problem}</div>)}
    </div>
  );
}

/**
 * The header strip every view sits under, as in the web console and the
 * desktop editor: a breadcrumb ending in the current title, actions on the
 * right. Pages are renamed from the tree, as there.
 */
function ViewHeader({ crumbs, actions }: { crumbs: readonly BreadcrumbCrumb[]; actions?: ReactNode }) {
  return <EditorHeaderBar breadcrumb={<EditorBreadcrumb crumbs={crumbs} />} actions={actions} testId="wiki-web-header" />;
}

export function PageView({ pageId, filePath, navigate }: { pageId: string; filePath: string | null; navigate: Navigate }) {
  const { documents } = useCollabPagesState();
  const folders = useSharedFolders();
  const [save, setSave] = useState<{ state: SaveState; error: string | null }>({ state: 'saved', error: null });
  const document = documents.find((candidate) => candidate.documentId === pageId) ?? null;
  usePageTitle(document?.title ?? null);
  const crumbs = useMemo((): BreadcrumbCrumb[] => {
    const byId = new Map(folders.map((folder) => [folder.folderId, folder]));
    const out: BreadcrumbCrumb[] = [];
    for (let parent = document?.parentFolderId ? byId.get(document.parentFolderId) : undefined; parent; parent = parent.parentFolderId ? byId.get(parent.parentFolderId) : undefined) {
      const id = parent.folderId;
      out.unshift({ id, label: parent.name, onClick: () => navigate({ kind: 'page', id }) });
      if (out.length > 32) break;
    }
    return [...out, { id: pageId, label: document?.title || 'Untitled', current: true }];
  }, [document?.parentFolderId, document?.title, folders, navigate, pageId]);
  const onSaveState = useCallback((state: SaveState, error: string | null) => setSave({ state, error }), []);

  if (!document) {
    return <TrackerSurfaceMessage icon="search_off" message="This page is not in the wiki." hint="It may have been moved to the trash." testId="wiki-web-page-missing" />;
  }
  const markdown = document.documentType === 'markdown';
  // An editor page's tree title carries its suffix (`Plan.excalidraw`), which is what picks the editor.
  const editor = markdown ? null : editorForFile(document.title);
  return (
    <article className={`wiki-web-page flex flex-col ${editor ? 'min-h-0 flex-1' : 'min-h-full'}`} data-testid="wiki-web-page" data-page-id={pageId}>
      <ViewHeader
        crumbs={crumbs}
        actions={(markdown || editor) && !isStaticSite() ? (
          <span className="wiki-web-save-state px-1 text-[11px] text-nim-faint" data-save-state={save.state} aria-live="polite" title={filePath ?? undefined}>
            {saveStateLabel(save.state, save.error)}
          </span>
        ) : undefined}
      />
      {markdown ? (
        <>
          <PageEditor key={pageId} pageId={pageId} onSaveState={onSaveState} />
          {isStaticSite() ? <StaticBacklinks pageId={pageId} navigate={navigate} /> : null}
        </>
      ) : editor ? (
        <ExtensionPageEditor key={pageId} pageId={pageId} fileName={document.title} filePath={filePath ?? document.title} editor={editor} onSaveState={onSaveState} />
      ) : (
        // A page type no editor in the browser view handles (a custom suffix mapped in the wiki's settings).
        <TrackerSurfaceMessage icon="open_in_new" message="Open this page in Nimbalyst" hint={filePath ?? undefined} testId="wiki-web-editor-page" />
      )}
    </article>
  );
}

export function TypedPageView({ itemId, module, trackers, navigate }: { itemId: string; module: PageModule; trackers: LocalTrackerDataSource; navigate: Navigate }) {
  const recordsById = useTrackerDataSelector((state) => state.recordsById);
  const loaded = useTrackerDataSelector((state) => state.loaded);
  const command = useTrackerCommand();
  const { documents, typePlacements, itemPlacements } = useCollabPagesState();
  const folders = useSharedFolders();
  const [error, setError] = useState<string | null>(null);
  const item = recordsById.get(itemId) ?? null;
  const title = typeof item?.fields.title === 'string' ? item.fields.title : '';
  usePageTitle(item ? title : null);
  useWikiTypes(trackers);

  const crumb = useMemo(
    () => (item
      ? module.trackerPageCrumb(item.id, item.primaryType, { itemPlacements, typePlacements, documents, folders, item: module.crumbItemLookup(recordsById) })
      : { ancestors: [], underType: false }),
    [module, item, itemPlacements, typePlacements, documents, folders, recordsById],
  );
  const update = useCallback(async (updates: Record<string, unknown>) => {
    setError(null);
    const outcome = await command({ type: 'update-item', input: { itemId, updates } });
    const result = outcome.result as { success?: boolean; error?: string } | undefined;
    if (result?.success === false) throw new Error(result.error || 'The page could not be saved');
  }, [command, itemId]);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  if (!item && loaded) {
    return <TrackerSurfaceMessage icon="search_off" message="This item is not in the wiki." hint="It may have been moved to the trash." testId="wiki-web-item-missing" />;
  }
  const typeInfo = item ? trackers.typeInfo(item.primaryType) : undefined;
  const storage = typeInfo?.storage ?? 'pages';
  const editing = typedPageEditing(storage, isStaticSite(), {
    update,
    archive: () => void command({ type: 'archive-item', itemId, archive: true }).then(() => navigate({ kind: 'home' })).catch(fail),
    fail,
  });
  const { TrackerPageView } = module;
  return (
    <div className="wiki-web-typed-page h-full min-h-0" data-testid="wiki-web-typed-page">
      {error ? <div className="px-4 py-2 text-xs text-nim-error" role="alert">{error}</div> : null}
      <TrackerPageView
        item={item}
        loaded={loaded}
        crumb={crumb}
        {...editing}
        title={title}
        fieldValues={item?.fields ?? {}}
        renderBody={() => (item
          ? storage === 'pages'
            ? <PageEditor key={item.id} pageId={item.id} trackerReferenceSource={{ itemId: item.id, type: item.primaryType }} />
            : (
              // Read-only on purpose: a table type keeps all rows in one CSV, which has no room for a body.
              <div className="wiki-web-table-row-body mx-8 my-3 flex flex-col gap-2 rounded border border-nim bg-nim-secondary px-4 py-3" data-testid="wiki-web-table-row-body">
                <div className="text-sm font-medium text-nim">This row has fields only, no page</div>
                <div className="text-xs text-nim-muted">
                  {typeInfo?.displayNamePlural ?? 'This type'} keeps every row in one CSV file. Convert the type to pages to give each row its own page with a body and child pages; ids and field values are kept.
                </div>
                {isStaticSite() ? null : <div><ConvertToPagesAction typeId={item.primaryType} plural={typeInfo?.displayNamePlural ?? item.primaryType} trackers={trackers} /></div>}
              </div>
            )
          : null)}
        linksSource={isStaticSite() ? STATIC_LINKS_SOURCE : undefined}
        onOpenItem={(id) => navigate(isStaticSite() ? routeForId(id, staticPages()) : { kind: 'item', id })}
      />
    </div>
  );
}

/** A static export's Links section reads the links the export computed. */
const STATIC_LINKS_SOURCE = { linksFor: (itemId: string) => staticLinks(itemId) };

export function TypeTableView({ typeId, module, trackers, navigate }: { typeId: string; module: PageModule; trackers: LocalTrackerDataSource; navigate: Navigate }) {
  const { itemPlacements } = useCollabPagesState();
  const folders = useSharedFolders();
  const recordsById = useTrackerDataSelector((state) => state.recordsById);
  useWikiTypes(trackers);
  const info = trackers.typeInfo(typeId);
  usePageTitle(info?.displayNamePlural ?? null);
  if (!info) return <TrackerSurfaceMessage icon="search_off" message="This type is not defined in .nimbalyst/trackers." testId="wiki-web-type-missing" />;
  const { TypePageTable } = module;
  return (
    <div className="wiki-web-type-page flex min-h-full flex-col" data-testid="wiki-web-type-page">
      <ViewHeader
        crumbs={[{ id: 'types', label: 'Types', onClick: () => navigate({ kind: 'types' }) }, { id: typeId, label: info.displayNamePlural, current: true }]}
        actions={(
          <span className="inline-flex items-center gap-2">
            <span className="px-1 text-[11px] text-nim-faint">{info.storage === 'table' ? 'One CSV file' : 'One markdown page per item'}</span>
            {info.storage === 'table' && !isStaticSite() ? <ConvertToPagesAction typeId={typeId} plural={info.displayNamePlural} trackers={trackers} /> : null}
          </span>
        )}
      />
      <TypeProblems problems={info.problems} />
      <div className="px-8 pb-8 pt-4">
        <TypePageTable
          typeId={typeId}
          typeLabel={info.displayName}
          rootLabel="Local wiki"
          itemPlacements={itemPlacements}
          pages={folders}
          itemTitle={(id) => {
            const record = recordsById.get(id);
            return record ? String(record.fields.title ?? '') : null;
          }}
          onOpenItem={(id) => navigate({ kind: 'item', id })}
        />
      </div>
    </div>
  );
}

export function SearchView({ query, navigate }: { query: string; navigate: Navigate }) {
  const [hits, setHits] = useState<LocalSearchHit[] | null>(null);
  usePageTitle(`Search: ${query}`);
  useEffect(() => {
    let live = true;
    setHits(null);
    void wikiApi.search(query, 50).then((result) => {
      if (live) setHits(result);
    });
    return () => {
      live = false;
    };
  }, [query]);
  return (
    <div className="wiki-web-search flex min-h-full flex-col" data-testid="wiki-web-search">
      <ViewHeader crumbs={[{ id: 'search', label: 'Search', current: true }]} />
      <div className="px-8 py-6">
      <form
        className="mb-4"
        onSubmit={(event) => {
          event.preventDefault();
          const next = new FormData(event.currentTarget).get('q');
          if (typeof next === 'string') navigate({ kind: 'search', query: next.trim() });
        }}
      >
        <input
          name="q"
          key={query}
          defaultValue={query}
          autoFocus
          className="w-full max-w-xl rounded-md border border-nim bg-nim-secondary px-3 py-1.5 text-sm text-nim outline-none focus:border-nim-focus"
          placeholder="Search pages and typed pages"
          aria-label="Search the wiki"
        />
      </form>
      {!query ? null : hits === null ? <div className="text-xs text-nim-faint">Searching…</div> : hits.length === 0 ? <div className="text-sm text-nim-muted">No pages match.</div> : null}
      <ul className="m-0 list-none p-0">
        {(hits ?? []).map((hit) => (
          <li key={hit.id} className="mb-3">
            <button type="button" className="text-left text-sm font-medium text-nim-link hover:underline" onClick={() => navigate(hit.type ? { kind: 'item', id: hit.id } : { kind: 'page', id: hit.id })}>
              {hit.title}
            </button>
            {hit.snippet ? <div className="mt-0.5 text-xs text-nim-muted">{hit.snippet}</div> : null}
          </li>
        ))}
      </ul>
      </div>
    </div>
  );
}

/** Every type the wiki knows, as the console's Types entry lists them. */
export function TypesView({ trackers, navigate }: { trackers: LocalTrackerDataSource; navigate: Navigate }) {
  usePageTitle('Types');
  useWikiTypes(trackers);
  const types = trackers.allTypes();
  return (
    <div className="wiki-web-types flex min-h-full flex-col" data-testid="wiki-web-types">
      <ViewHeader crumbs={[{ id: 'types', label: 'Types', current: true }]} />
      <div className="px-8 py-6">
        {types.length === 0 ? (
          <div className="text-sm text-nim-muted">No types yet. A type is a file in .nimbalyst/trackers that declares storage: pages or storage: table.</div>
        ) : (
          <ul className="m-0 list-none p-0">
            {types.map((type) => (
              <li key={type.typeId} className="mb-2">
                <button type="button" className="text-left text-sm font-medium text-nim-link hover:underline" onClick={() => navigate({ kind: 'type', typeId: type.typeId })}>
                  {type.displayNamePlural}
                </button>
                <span className="ml-2 text-xs text-nim-faint">{type.storage === 'table' ? 'one CSV file' : 'one page per item'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
