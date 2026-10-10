/**
 * Regression test for the "shared extension doc reopens blank" bug.
 *
 * On reopen (after a restart or after the in-memory collab config registry
 * is empty), the workspace-state persistence is the only source of truth for
 * which collab tabs to restore AND what editor type each one needs. Prior
 * code only stored `openCollabDocumentIds: string[]`, dropping the
 * documentType. CollaborativeTabEditor then fell back to `markdown` for
 * everything, routing an Excalidraw / mockup Y.Doc through Lexical's collab
 * plugin and rendering a blank pane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import {
  getPersistedCollabDocType,
  getPersistedCollabDocMetadata,
  isPersistedCollabPageEntry,
  loadOpenCollabDocs,
  loadOpenCollabTabs,
  persistOpenCollabDocs,
  readEntriesFromState,
  readTabEntriesFromState,
} from '../collabOpenDocsPersistence';
import { activePageRow, openPageTab, toPersistedPageEntry } from '../../components/CollabMode/collabPageTabs';

const TEST_SCOPE = {
  scopeKey: '/ws',
  orgId: 'org-1',
  indexConfig: { serverUrl: 'ws://sync', teamMemberId: asTeamMemberId('user-1') },
};

interface MockState {
  openCollabDocumentIds?: string[];
  openCollabDocumentEntries?: Array<{
    documentId?: string;
    documentType?: string;
    kind?: 'tracker' | 'type' | 'personal';
    artifactId?: string;
    title?: string;
    displayPath?: string;
    metadataVersion?: 2;
    fileExtension?: string;
    editorId?: string;
    isPinned?: boolean;
  }>;
}

function installMockElectronAPI(initialState: MockState = {}) {
  let state: MockState = { ...initialState };
  const invoke = vi.fn(async (channel: string, _workspacePath: string, patch?: MockState) => {
    if (channel === 'workspace:get-state') return state;
    if (channel === 'workspace:update-state' && patch) {
      state = { ...state, ...patch };
      return undefined;
    }
    throw new Error(`unexpected channel ${channel}`);
  });
  (globalThis as any).window = { electronAPI: { invoke } };
  return {
    invoke,
    getState: () => state,
  };
}

describe('collabOpenDocsPersistence', () => {
  beforeEach(() => {
    delete (globalThis as any).window;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).window;
  });

  it('round-trips excalidraw entries with documentType preserved', async () => {
    const harness = installMockElectronAPI();
    const entries = [
      { documentId: 'doc-1', documentType: 'excalidraw' },
      { documentId: 'doc-2', documentType: 'mockup.html' },
    ];

    await persistOpenCollabDocs(TEST_SCOPE, entries);
    const loaded = await loadOpenCollabDocs(TEST_SCOPE);

    expect(loaded).toEqual(entries);
    // The legacy id list is also written for one release of downgrade safety.
    expect(harness.getState().openCollabDocumentIds).toEqual(['doc-1', 'doc-2']);
  });

  it('restores explicit V2 metadata for a non-markdown opener route', async () => {
    const entry = {
      documentId: 'drawing-1',
      documentType: 'excalidraw',
      metadataVersion: 2 as const,
      fileExtension: '.excalidraw',
      editorId: 'com.nimbalyst.excalidraw',
    };
    installMockElectronAPI({ openCollabDocumentEntries: [entry] });

    expect(await getPersistedCollabDocMetadata(TEST_SCOPE, 'drawing-1')).toEqual(entry);
    expect((await getPersistedCollabDocMetadata(TEST_SCOPE, 'drawing-1'))?.documentType)
      .not.toBe('markdown');
  });

  it('round-trips the last-known shared document path for title-safe restore', async () => {
    const harness = installMockElectronAPI();
    const entries = [{
      documentId: '1af74157-fe92-481b-9be3-4ed7cc6f5625',
      documentType: 'markdown',
      displayPath: 'Specs/Auth/Architecture Plan',
    }];

    await persistOpenCollabDocs(TEST_SCOPE, entries);

    expect(await loadOpenCollabDocs(TEST_SCOPE)).toEqual(entries);
    expect(harness.getState().openCollabDocumentEntries?.[0]?.displayPath)
      .toBe('Specs/Auth/Architecture Plan');
  });

  it('round-trips pinned state without changing persisted tab order', async () => {
    const entries = [
      { documentId: 'pinned-doc', documentType: 'markdown', isPinned: true },
      { documentId: 'regular-doc', documentType: 'markdown', isPinned: false },
    ];
    installMockElectronAPI();

    await persistOpenCollabDocs(TEST_SCOPE, entries);

    expect(await loadOpenCollabDocs(TEST_SCOPE)).toEqual(entries);
  });

  it('migrates legacy openCollabDocumentIds: string[] as markdown entries', () => {
    // This is the shape produced before the documentType-aware change. Prior
    // restore code read these strings, called openCollabDocumentViaIPC with
    // no documentType, and CollaborativeTabEditor fell back to markdown.
    const legacy = readEntriesFromState({
      openCollabDocumentIds: ['old-doc-1', 'old-doc-2'],
    });
    expect(legacy).toEqual([
      { documentId: 'old-doc-1', documentType: 'markdown' },
      { documentId: 'old-doc-2', documentType: 'markdown' },
    ]);
  });

  it('prefers the new entries field when both shapes coexist', () => {
    // After a save under the new shape we write both keys for downgrade
    // safety. On the next load, the entries field must win so non-markdown
    // types don't get coerced back to markdown.
    const entries = readEntriesFromState({
      openCollabDocumentIds: ['doc-1', 'doc-2'],
      openCollabDocumentEntries: [
        { documentId: 'doc-1', documentType: 'excalidraw' },
        { documentId: 'doc-2', documentType: 'mockup.html' },
      ],
    });
    expect(entries.map((e) => e.documentType)).toEqual(['excalidraw', 'mockup.html']);
  });

  it('returns an empty list when no state is persisted', async () => {
    installMockElectronAPI();
    expect(await loadOpenCollabDocs(TEST_SCOPE)).toEqual([]);
  });

  it('returns the documentType for a single open doc lookup', async () => {
    installMockElectronAPI({
      openCollabDocumentEntries: [
        { documentId: 'sketch-1', documentType: 'excalidraw' },
      ],
    });
    expect(await getPersistedCollabDocType(TEST_SCOPE, 'sketch-1')).toBe('excalidraw');
    expect(await getPersistedCollabDocType(TEST_SCOPE, 'missing')).toBeUndefined();
  });

  it('returns the migrated markdown type for legacy ids in single-lookup', async () => {
    installMockElectronAPI({ openCollabDocumentIds: ['legacy-doc'] });
    expect(await getPersistedCollabDocType(TEST_SCOPE, 'legacy-doc')).toBe('markdown');
  });

  it('drops malformed entries instead of returning broken records', () => {
    const entries = readEntriesFromState({
      openCollabDocumentEntries: [
        { documentId: 'good', documentType: 'excalidraw' },
        // Malformed: missing documentType. Could appear if a bad patch lands.
        { documentId: 'bad-1' } as any,
        // Malformed: missing documentId.
        { documentType: 'markdown' } as any,
      ],
    });
    expect(entries).toEqual([{ documentId: 'good', documentType: 'excalidraw' }]);
  });

  it('round-trips item and type page tabs alongside docs, in order, with pinned state', async () => {
    const harness = installMockElectronAPI();
    const tabs = [
      { kind: 'type' as const, artifactId: 'module', title: 'Modules', isPinned: true },
      { documentId: 'doc-1', documentType: 'markdown', displayPath: 'Spec/Overview' },
      { kind: 'tracker' as const, artifactId: 'item-flags', title: 'Flags', isPinned: false },
    ];

    await persistOpenCollabDocs(TEST_SCOPE, tabs);

    expect(await loadOpenCollabTabs(TEST_SCOPE)).toEqual(tabs);
    // Doc-only readers (and a downgraded build) never see a page tab as a doc.
    expect(await loadOpenCollabDocs(TEST_SCOPE)).toEqual([tabs[1]]);
    expect(harness.getState().openCollabDocumentIds).toEqual(['doc-1']);
    expect(await getPersistedCollabDocMetadata(TEST_SCOPE, 'item-flags')).toBeUndefined();
  });

  it('names the tree row an open item or type page tab stands for', () => {
    expect(activePageRow('tracker://item-flags')).toEqual({ itemId: 'item-flags', typeId: null });
    expect(activePageRow('type://module')).toEqual({ itemId: null, typeId: 'module' });
    expect(activePageRow('personal://doc-1')).toEqual({ itemId: null, typeId: null });
    expect(activePageRow(null)).toEqual({ itemId: null, typeId: null });
  });

  it('restores a personal page tab across a restart, beside docs and item pages', async () => {
    const harness = installMockElectronAPI();
    const tabs = [
      { kind: 'personal' as const, artifactId: 'pdoc-1', title: 'Reading list', isPinned: true },
      { documentId: 'doc-1', documentType: 'markdown' },
      { kind: 'tracker' as const, artifactId: 'item-flags', title: 'Flags', isPinned: false },
    ];
    await persistOpenCollabDocs(TEST_SCOPE, tabs);
    expect(harness.getState().openCollabDocumentIds).toEqual(['doc-1']);
    expect(await getPersistedCollabDocMetadata(TEST_SCOPE, 'pdoc-1')).toBeUndefined();

    // Second launch: the restore loop reopens each page entry through openPageTab.
    const opened: Array<{ path: string; title?: string; isPinned?: boolean }> = [];
    for (const entry of await loadOpenCollabTabs(TEST_SCOPE)) {
      if (!isPersistedCollabPageEntry(entry)) continue;
      openPageTab((path, _content, _switch, title, state) => {
        opened.push({ path, title, isPinned: state?.isPinned });
        return path;
      }, entry);
    }
    expect(opened[0]).toEqual({ path: 'personal://pdoc-1', title: 'Reading list', isPinned: true });

    // The reopened tab persists back to the same entry.
    expect(toPersistedPageEntry({
      id: 't1', filePath: 'personal://pdoc-1', fileName: 'Reading list', content: '',
      isDirty: false, isPinned: true,
    })).toEqual(tabs[0]);
  });

  it('restores section Search and Types tabs, and a leftover Shared Home tab as Team Search', async () => {
    const harness = installMockElectronAPI();
    const tab = (filePath: string, fileName: string) => ({ id: filePath, filePath, fileName, content: '', isDirty: false, isPinned: false });
    const entries = [
      tab('virtual://shared-home', 'Shared documents'),
      tab('virtual://pages-types/personal', 'Types'),
      tab('virtual://pages-search/bogus', 'Search'),
    ].map(toPersistedPageEntry);
    expect(entries).toEqual([
      { kind: 'search', artifactId: 'team', isPinned: false },
      { kind: 'types', artifactId: 'personal', isPinned: false },
      null,
    ]);
    await persistOpenCollabDocs(TEST_SCOPE, entries.filter((entry) => entry !== null));
    expect(harness.getState().openCollabDocumentIds).toEqual([]);

    const opened: Array<{ path: string; title?: string }> = [];
    for (const entry of await loadOpenCollabTabs(TEST_SCOPE)) {
      if (isPersistedCollabPageEntry(entry)) openPageTab((path, _content, _switch, title) => { opened.push({ path, title }); return path; }, entry);
    }
    expect(opened).toEqual([
      { path: 'virtual://pages-search/team', title: 'Search' },
      { path: 'virtual://pages-types/personal', title: 'Types' },
    ]);
  });

  it('loads an old doc-only payload as doc tabs', async () => {
    installMockElectronAPI({
      openCollabDocumentEntries: [{ documentId: 'doc-1', documentType: 'excalidraw', isPinned: true }],
    });
    expect(await loadOpenCollabTabs(TEST_SCOPE)).toEqual([
      { documentId: 'doc-1', documentType: 'excalidraw', isPinned: true },
    ]);
  });

  it('drops malformed page entries', () => {
    expect(readTabEntriesFromState({
      openCollabDocumentEntries: [
        { kind: 'tracker' } as any,
        { kind: 'type', artifactId: '' } as any,
        { kind: 'wiki', artifactId: 'x' } as any,
        { kind: 'type', artifactId: 'module', title: 7 } as any,
      ],
    })).toEqual([{ kind: 'type', artifactId: 'module' }]);
  });

  it('drops malformed display paths without dropping an otherwise valid entry', () => {
    expect(readEntriesFromState({
      openCollabDocumentEntries: [{
        documentId: 'good',
        documentType: 'markdown',
        displayPath: 42 as any,
      }],
    })).toEqual([{ documentId: 'good', documentType: 'markdown' }]);
  });
});
