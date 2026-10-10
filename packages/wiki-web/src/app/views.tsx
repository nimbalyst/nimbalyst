/**
 * The main pane's views: a plain page, a typed page, a type's table, search.
 * Each reads the tree from the docs session and items from the tracker
 * provider, the same stores the sidebar reads.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import type { WikiRoute } from '../host/LocalCollabHost';
import type { LocalTrackerDataSource } from '../host/LocalTrackerDataSource';
import { PageEditor, saveStateLabel, type SaveState } from './PageEditor';

export type PageModule = Awaited<ReturnType<typeof loadTrackerPage>>;
/** The host's routes plus the views only the app has. */
export type ViewRoute = WikiRoute | { kind: 'search'; query: string } | { kind: 'types' };
type Navigate = (route: ViewRoute) => void;

function usePageTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    document.title = `${title || 'Untitled'} · Local wiki`;
  }, [title]);
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
  return (
    <article className="wiki-web-page flex min-h-full flex-col" data-testid="wiki-web-page" data-page-id={pageId}>
      <ViewHeader
        crumbs={crumbs}
        actions={markdown ? (
          <span className="wiki-web-save-state px-1 text-[11px] text-nim-faint" data-save-state={save.state} aria-live="polite" title={filePath ?? undefined}>
            {saveStateLabel(save.state, save.error)}
          </span>
        ) : undefined}
      />
      {markdown ? (
        <PageEditor key={pageId} pageId={pageId} onSaveState={onSaveState} />
      ) : (
        // Drawings, mind maps and other editor pages need their extension's editor, which the browser app does not ship.
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
  const storage = item ? trackers.typeInfo(item.primaryType)?.storage ?? 'pages' : 'pages';
  const { TrackerPageView } = module;
  return (
    <div className="wiki-web-typed-page h-full min-h-0" data-testid="wiki-web-typed-page">
      {error ? <div className="px-4 py-2 text-xs text-nim-error" role="alert">{error}</div> : null}
      <TrackerPageView
        item={item}
        loaded={loaded}
        crumb={crumb}
        editable
        title={title}
        onRename={(next) => void update({ title: next }).catch(fail)}
        fieldValues={item?.fields ?? {}}
        onUpdateField={(field, value) => void update({ [field.name]: value }).catch(fail)}
        renderBody={() => (item
          ? storage === 'pages'
            ? <PageEditor key={item.id} pageId={item.id} trackerReferenceSource={{ itemId: item.id, type: item.primaryType }} />
            : <div className="px-8 py-3 text-xs text-nim-faint">A row of a table type has fields only; its type keeps all rows in one CSV file.</div>
          : null)}
        onOpenItem={(id) => navigate({ kind: 'item', id })}
        onArchive={() => void command({ type: 'archive-item', itemId, archive: true }).then(() => navigate({ kind: 'home' })).catch(fail)}
      />
    </div>
  );
}

export function TypeTableView({ typeId, module, trackers, navigate }: { typeId: string; module: PageModule; trackers: LocalTrackerDataSource; navigate: Navigate }) {
  const { itemPlacements } = useCollabPagesState();
  const folders = useSharedFolders();
  const recordsById = useTrackerDataSelector((state) => state.recordsById);
  const info = trackers.typeInfo(typeId);
  usePageTitle(info?.displayNamePlural ?? null);
  if (!info) return <TrackerSurfaceMessage icon="search_off" message="This type is not defined in .nimbalyst/trackers." testId="wiki-web-type-missing" />;
  const { TypePageTable } = module;
  return (
    <div className="wiki-web-type-page flex min-h-full flex-col" data-testid="wiki-web-type-page">
      <ViewHeader
        crumbs={[{ id: 'types', label: 'Types', onClick: () => navigate({ kind: 'types' }) }, { id: typeId, label: info.displayNamePlural, current: true }]}
        actions={<span className="px-1 text-[11px] text-nim-faint">{info.storage === 'table' ? 'One CSV file' : 'One markdown page per item'}</span>}
      />
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
