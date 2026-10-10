// @vitest-environment node
/**
 * `CollabSidebar` reads `host.documents.documentTypes()` through
 * `useSyncExternalStore`, which compares snapshot identity: a list rebuilt on
 * every call re-renders forever ("Maximum update depth exceeded", seen live on
 * 2026-10-02 when the Personal section first mounted).
 */
import { describe, expect, it, vi } from 'vitest';
import type { CollabDocumentTypeDescriptor } from '@nimbalyst/collab-client/core';

const dataSources = vi.hoisted(() => [] as Array<{ disposed: boolean; watching: boolean }>);
vi.mock('../PersonalPagesDataSource', () => ({
  PersonalPagesDataSource: class {
    disposed = false;
    watching = false;
    constructor() { dataSources.push(this); }
    // `legacy-*` ids stand for database pages not exported yet; the rest are wiki files.
    isLegacyDocument(id: string) { return id.startsWith('legacy-'); }
    async pageFilePath(id: string) { return `/workspace/history/nimbalyst-local/wiki/${id}.md`; }
    // The real source never resumes watching once disposed.
    subscribe() { if (!this.disposed) this.watching = true; return () => undefined; }
    dispose() { this.disposed = true; this.watching = false; }
  },
}));
vi.mock('../../contexts/TabsContext', () => ({ PERSONAL_PAGE_TAB_PREFIX: 'personal://' }));

import { registerElectronCollabDocumentTypes, electronCollabDocumentAdapters } from '../ElectronCollabHost';
import { PersonalCollabHost } from '../PersonalCollabHost';

const descriptor = (documentType: string, defaultExtension = `.${documentType}`, shareToTeam = true) =>
  ({ documentType, defaultExtension, fileExtensions: [defaultExtension], capabilities: { shareToTeam } } as unknown as CollabDocumentTypeDescriptor);

describe('PersonalCollabHost data source', () => {
  // The host is a window singleton; a docs session disposing the source on
  // unmount left a remounted Personal section with a tree that never refreshed.
  it('gives a session created after dispose a source that watches again', () => {
    dataSources.length = 0;
    const host = new PersonalCollabHost('/workspace/remount');
    const source = host.documents.dataSource;

    source.subscribe(() => undefined);
    source.dispose();
    source.subscribe(() => undefined);

    expect(dataSources.map((s) => [s.disposed, s.watching])).toEqual([[true, false], [false, true]]);
  });
});

describe('PersonalCollabHost document types', () => {
  it('returns the same list until the catalog changes, every type but code, and tells main the editor suffixes', () => {
    const invoke = vi.fn(async () => undefined);
    (globalThis as any).window = { electronAPI: { invoke } };
    const host = new PersonalCollabHost('/workspace');
    expect(electronCollabDocumentAdapters.documentTypes()).toBe(electronCollabDocumentAdapters.documentTypes());

    const catalog = [descriptor('markdown', '.md'), descriptor('excalidraw'), descriptor('code', '.ts'), descriptor('imgproj', '.imgproj', false)];
    const unregister = registerElectronCollabDocumentTypes(() => catalog);
    try {
      const first = host.documents.documentTypes();
      expect(first.map((d) => d.documentType)).toEqual(['markdown', 'excalidraw', 'imgproj']);
      expect(host.documents.documentTypes()).toBe(first);
      // Only types the catalog can share become pages when a file of theirs is dropped in the folder.
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith('local-wiki:set-editor-types', { '.excalidraw': 'excalidraw' });

      const next = [descriptor('markdown')];
      unregister();
      const unregisterNext = registerElectronCollabDocumentTypes(() => next);
      try {
        expect(host.documents.documentTypes()).not.toBe(first);
        expect(host.documents.documentTypes()).toBe(host.documents.documentTypes());
      } finally {
        unregisterNext();
      }
    } finally {
      unregister();
      delete (globalThis as any).window;
    }
  });
});

describe('PersonalCollabHost history', () => {
  it('opens local history for a Local page file, a database page, a typed page and a type page', async () => {
    const { store } = await import('@nimbalyst/runtime/store');
    const { historyDialogFileAtom } = await import('../../store/atoms/historyDialog');
    const host = new PersonalCollabHost('/workspace/history');
    const opened = vi.fn();
    host.setOpenArtifactAdapter(opened);
    const scope = host.scope;

    // A Local page is a file: its history is the file's own.
    host.openArtifact({ kind: 'document', scope, documentId: 'page-1', teamProjectId: null }, 'history');
    await vi.waitFor(() => expect(store.get(historyDialogFileAtom)).toBe('/workspace/history/nimbalyst-local/wiki/page-1.md'));
    expect(opened).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'local-file', documentId: 'page-1', path: '/workspace/history/nimbalyst-local/wiki/page-1.md' }),
      'history',
      undefined,
    );
    host.openArtifact({ kind: 'document', scope, documentId: 'legacy-1', teamProjectId: null }, 'history');
    expect(store.get(historyDialogFileAtom)).toBe('personal-doc://legacy-1');
    host.openArtifact({ kind: 'tracker', scope, trackerId: 'idea_1' }, 'history');
    expect(store.get(historyDialogFileAtom)).toBe('personal-doc://tracker-content/idea_1');
    host.openArtifact({ kind: 'type', scope, typeId: 'idea' }, 'history');
    expect(store.get(historyDialogFileAtom)).toBe('personal-doc://type-page:idea');
    expect(opened).toHaveBeenCalledTimes(4);
  });
});
