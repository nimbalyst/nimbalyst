// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPersonalCollabScope } from '@nimbalyst/collab-client/core';
import {
  createCollabDocsSession,
  pruneCollabDocsSession,
  type CollabDocsDataChange,
} from '@nimbalyst/collab-client/docs';
import { store } from '@nimbalyst/runtime/store';
import { personalPagesRevisionAtomFamily } from '../../store/listeners/personalPagesListeners';
import { localWikiStatusAtomFamily } from '../../store/atoms/localWiki';
import { PersonalPagesDataSource } from '../PersonalPagesDataSource';
import { isLocalWikiType } from '../localWikiTrackerRecords';

const WORKSPACE = '/ws/personal-pages';

const ROOT = '/ws/personal-pages/nimbalyst-local/wiki';
const wikiPage = {
  documentId: 'w1', teamProjectId: null, title: 'Reading list', documentType: 'markdown',
  parentFolderId: null, createdBy: 'local', createdAt: 1, updatedAt: 1,
};
/** A database Personal page the user has not exported yet. */
const legacyPage = {
  documentId: 'p1', teamProjectId: null, title: 'Old notes', documentType: 'markdown',
  parentFolderId: null, createdBy: '', createdAt: 1, updatedAt: 1,
};
const legacyPlacement = { itemId: 'i1', projectId: null, parentId: 'p1', sortOrder: 0, createdBy: 'local', createdAt: 1, updatedAt: 1 };

function wikiSnapshot(items = [wikiPage]) {
  return {
    items, containers: [], typePlacements: [], itemPlacements: [], pageTree: true, pageFields: true,
    pages: items.map((item) => ({ id: item.documentId, path: `${item.title}.md`, trashedAt: null })),
    issues: [], root: ROOT, location: 'nimbalyst-local/wiki', exists: true,
  };
}

let pushHandlers: Array<(payload: unknown) => void>;
let invoke: ReturnType<typeof vi.fn>;
let legacy: { items: unknown[]; typePlacements: unknown[]; itemPlacements: unknown[]; unexportedPageCount: number };

beforeEach(() => {
  pushHandlers = [];
  legacy = { items: [legacyPage], typePlacements: [], itemPlacements: [legacyPlacement], unexportedPageCount: 1 };
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'local-wiki:snapshot') return wikiSnapshot();
    if (channel === 'local-wiki:legacy-snapshot') return legacy;
    return { ok: true };
  });
  (globalThis as any).window = {
    electronAPI: {
      invoke,
      on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        if (channel === 'local-wiki:changed' || channel === 'personal-pages:changed') pushHandlers.push(handler);
        return () => { pushHandlers = pushHandlers.filter((candidate) => candidate !== handler); };
      }),
    },
  };
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe('PersonalPagesDataSource', () => {
  it('turns type files the app could not load into broken types, placing at root only the ones nothing shows (NIM-7437)', async () => {
    const typePath = (typeId: string) => `/ws/personal-pages/.nimbalyst/trackers/${typeId}.yaml`;
    const tablePlacement = { typeId: 'lesson', projectId: null, parentFolderId: 'w1', sortOrder: 0, createdBy: 'local', createdAt: 1, updatedAt: 1 };
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'local-wiki:snapshot') {
        return {
          ...wikiSnapshot(),
          typePlacements: [tablePlacement],
          pages: [...wikiSnapshot().pages, { id: 'g1', path: 'Guide.md', type: 'guide', trashedAt: null }],
          issues: [
            { code: 'malformed-type', path: typePath('lesson'), message: 'Missing required field: modes', id: 'lesson' },
            { code: 'malformed-type', path: typePath('guide'), message: 'Missing required field: icon', id: 'guide' },
            // The library's own report of a file that is not YAML: no id, named by the file.
            { code: 'malformed-type', path: typePath('orphan'), message: 'bad indentation' },
            { code: 'broken-link', path: 'Home.md', message: 'gone' },
          ],
        };
      }
      if (channel === 'local-wiki:tracker-snapshot') return { items: [] };
      if (channel === 'local-wiki:legacy-snapshot') return null;
      return { ok: true };
    });
    const source = new PersonalPagesDataSource(WORKSPACE);
    const snapshot = await source.snapshot();

    const { brokenTypes } = store.get(localWikiStatusAtomFamily(WORKSPACE));
    expect(brokenTypes).toEqual({
      lesson: 'Missing required field: modes (.nimbalyst/trackers/lesson.yaml)',
      guide: 'Missing required field: icon (.nimbalyst/trackers/guide.yaml)',
      orphan: 'bad indentation (.nimbalyst/trackers/orphan.yaml)',
    });
    // `lesson` has its table and `guide` its typed page; only `orphan` needs a row of its own.
    expect(snapshot.typePlacements?.map((placement) => [placement.typeId, placement.parentFolderId ?? null]))
      .toEqual([['lesson', 'w1'], ['orphan', null]]);
    // An unchanged read keeps the same map, so the tree's resolver is not rebuilt.
    await source.snapshot();
    expect(store.get(localWikiStatusAtomFamily(WORKSPACE)).brokenTypes).toBe(brokenTypes);
  });

  it('shows the wiki with the database pages not exported yet, and routes each write to its own store', async () => {
    const source = new PersonalPagesDataSource(WORKSPACE);

    await expect(source.snapshot()).resolves.toEqual({
      items: [wikiPage, legacyPage], containers: [], typePlacements: [], itemPlacements: [legacyPlacement],
      pageTree: true, pageFields: true,
    });
    expect(store.get(localWikiStatusAtomFamily(WORKSPACE))).toMatchObject({ root: ROOT, exists: true, unexportedPageCount: 1 });
    // A wiki page opens as its file, without another round trip.
    invoke.mockClear();
    await expect(source.pageFilePath('w1')).resolves.toBe(`${ROOT}/Reading list.md`);
    expect(source.documentIdForFile(`${ROOT}/Reading list.md`)).toBe('w1');
    expect(invoke).not.toHaveBeenCalled();
    expect(source.isLegacyDocument('p1')).toBe(true);

    await source.command({ type: 'update-document-title', documentId: 'w1', title: 'Books' });
    expect(invoke).toHaveBeenLastCalledWith('local-wiki:command', WORKSPACE, { type: 'update-document-title', documentId: 'w1', title: 'Books' });
    const legacyRename = { type: 'update-document-title' as const, documentId: 'p1', title: 'Older notes' };
    await source.command(legacyRename);
    expect(invoke).toHaveBeenLastCalledWith('personal-pages:command', WORKSPACE, legacyRename);
    // The two stores do not mix: a new page under a database page waits for Export.
    await expect(source.command({
      type: 'register-document', documentId: 'w2', title: 'Child', documentType: 'markdown', parentFolderId: 'p1',
    })).rejects.toThrow(/Export/);

    const register = {
      type: 'register-document' as const,
      documentId: 'w2', title: 'Ideas', documentType: 'markdown', parentFolderId: null,
    };
    // Local writes are committed when main answers, so registration is acked.
    await expect(source.command(register)).resolves.toMatchObject({ ok: true, registrationAcked: true });
    expect(invoke).toHaveBeenLastCalledWith('local-wiki:command', WORKSPACE, {
      type: 'register-document', documentId: 'w2', title: 'Ideas', parentFolderId: null, sortOrder: null,
    });
    // A type page's description stays in the database store, even with no database pages left.
    const description = {
      type: 'register-document' as const,
      documentId: 'type-page:competitor', title: 'Competitors', documentType: 'markdown', parentFolderId: 'w1',
    };
    await source.command(description);
    expect(invoke).toHaveBeenLastCalledWith('personal-pages:command', WORKSPACE, description);
    await source.command({ type: 'update-document-title', documentId: 'type-page:competitor', title: 'Rivals' });
    expect(invoke.mock.lastCall?.[0]).toBe('personal-pages:command');
    // A write main did not accept never reports success.
    invoke.mockResolvedValueOnce({ ok: false, error: 'disk full' });
    await expect(source.command(register)).rejects.toThrow('disk full');

    // Placing a type writes `storage:` to its YAML; the registry hears of it
    // only when the schema watcher reloads, but an item created right away
    // must already be a file.
    expect(isLocalWikiType('offline-note')).toBe(false);
    await source.command({ type: 'set-type-placement', typeId: 'offline-note', parentFolderId: null, sortOrder: 1000 });
    expect(isLocalWikiType('offline-note')).toBe(true);

    const changes: CollabDocsDataChange[] = [];
    const unsubscribe = source.subscribe((change) => changes.push(change));
    // The session only leaves `disconnected` on a status change.
    expect(changes).toEqual([{ type: 'status', status: 'connected' }]);
    changes.length = 0;

    invoke.mockClear();
    for (const handler of pushHandlers) handler({ workspacePath: '/ws/other' });
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();

    // Exported: the database page is in the wiki now and no longer listed twice.
    legacy = { items: [], typePlacements: [], itemPlacements: [], unexportedPageCount: 0 };
    for (const handler of pushHandlers) handler({ workspacePath: WORKSPACE });
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0));
    expect(changes[0]).toMatchObject({ type: 'snapshot', snapshot: { items: [wikiPage] } });
    expect(changes[1]).toEqual({ type: 'items-removed', itemIds: ['p1'] });
    expect(source.isLegacyDocument('p1')).toBe(false);

    unsubscribe();
    const seen = changes.length;
    for (const handler of pushHandlers) handler({ workspacePath: WORKSPACE });
    await Promise.resolve();
    expect(changes).toHaveLength(seen);
  });

  it('shows an editor page with its extension, as the Team section does, and stores the bare stem', async () => {
    const drawing = { ...wikiPage, documentId: 'w3', title: 'Flow', documentType: 'excalidraw', fileExtension: '.excalidraw' };
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'local-wiki:snapshot') return { ...wikiSnapshot([drawing]), pages: [{ id: 'w3', path: 'Flow.excalidraw', trashedAt: null }] };
      if (channel === 'local-wiki:legacy-snapshot') return { items: [], typePlacements: [], itemPlacements: [], unexportedPageCount: 0 };
      return { ok: true };
    });
    const source = new PersonalPagesDataSource(WORKSPACE);
    expect((await source.snapshot()).items).toEqual([{ ...drawing, title: 'Flow.excalidraw' }]);
    await expect(source.pageFilePath('w3')).resolves.toBe(`${ROOT}/Flow.excalidraw`);

    await source.command({ type: 'update-document-title', documentId: 'w3', title: 'Flow v2.excalidraw' });
    expect(invoke).toHaveBeenLastCalledWith('local-wiki:command', WORKSPACE, { type: 'update-document-title', documentId: 'w3', title: 'Flow v2' });
    await source.command({
      type: 'register-document', documentId: 'w4', title: 'Sketch.excalidraw', documentType: 'excalidraw', parentFolderId: null,
      metadata: { metadataVersion: 2, fileExtension: '.excalidraw', editorId: 'com.nimbalyst.excalidraw' },
    });
    expect(invoke).toHaveBeenLastCalledWith('local-wiki:command', WORKSPACE, {
      type: 'register-document', documentId: 'w4', title: 'Sketch', parentFolderId: null, sortOrder: null,
      documentType: 'excalidraw', fileExtension: '.excalidraw',
    });
    await expect(source.command({ type: 'register-document', documentId: 'w5', title: 'a.ts', documentType: 'code', parentFolderId: null }))
      .rejects.toThrow(/code/);
  });

  it('drops a page deleted in another window instead of leaving a ghost row', async () => {
    const scope = createPersonalCollabScope('/ws/personal-pages-removal');
    const source = new PersonalPagesDataSource('/ws/personal-pages-removal');
    const host = {
      personalState: { status: 'unavailable' },
      documents: {
        dataSource: source,
        loadViewPreferences: async () => null,
        saveViewPreferences: async () => undefined,
        documentTypes: () => [],
        createDocument: async () => undefined,
        readReceipts: { status: 'unavailable' },
      },
    };
    const session = createCollabDocsSession(scope, source, host as never);
    try {
      await session.start();
      expect(session.getDocuments().map((row) => row.documentId)).toEqual(['w1', 'p1']);

      // Another window (or `nim`) deleted the page.
      legacy = { items: [], typePlacements: [], itemPlacements: [], unexportedPageCount: 0 };
      invoke.mockImplementation(async (channel: string) => (
        channel === 'local-wiki:snapshot' ? wikiSnapshot([]) : channel === 'local-wiki:legacy-snapshot' ? legacy : { ok: true }
      ));
      store.set(personalPagesRevisionAtomFamily('/ws/personal-pages-removal'), (revision) => revision + 1);

      await vi.waitFor(() => expect(session.getDocuments()).toEqual([]));
    } finally {
      pruneCollabDocsSession(scope.scopeKey);
    }
  });
});
