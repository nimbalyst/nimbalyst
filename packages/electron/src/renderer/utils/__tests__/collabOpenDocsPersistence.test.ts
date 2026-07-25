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
import {
  getPersistedCollabDocType,
  getPersistedCollabDocMetadata,
  loadOpenCollabDocs,
  persistOpenCollabDocs,
  readEntriesFromState,
} from '../collabOpenDocsPersistence';

interface MockState {
  openCollabDocumentIds?: string[];
  openCollabDocumentEntries?: Array<{
    documentId: string;
    documentType: string;
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

    await persistOpenCollabDocs('/ws', entries);
    const loaded = await loadOpenCollabDocs('/ws');

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

    expect(await getPersistedCollabDocMetadata('/ws', 'drawing-1')).toEqual(entry);
    expect((await getPersistedCollabDocMetadata('/ws', 'drawing-1'))?.documentType)
      .not.toBe('markdown');
  });

  it('round-trips the last-known shared document path for title-safe restore', async () => {
    const harness = installMockElectronAPI();
    const entries = [{
      documentId: '1af74157-fe92-481b-9be3-4ed7cc6f5625',
      documentType: 'markdown',
      displayPath: 'Specs/Auth/Architecture Plan',
    }];

    await persistOpenCollabDocs('/ws', entries);

    expect(await loadOpenCollabDocs('/ws')).toEqual(entries);
    expect(harness.getState().openCollabDocumentEntries?.[0]?.displayPath)
      .toBe('Specs/Auth/Architecture Plan');
  });

  it('round-trips pinned state without changing persisted tab order', async () => {
    const entries = [
      { documentId: 'pinned-doc', documentType: 'markdown', isPinned: true },
      { documentId: 'regular-doc', documentType: 'markdown', isPinned: false },
    ];
    installMockElectronAPI();

    await persistOpenCollabDocs('/ws', entries);

    expect(await loadOpenCollabDocs('/ws')).toEqual(entries);
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
    expect(await loadOpenCollabDocs('/ws')).toEqual([]);
  });

  it('returns the documentType for a single open doc lookup', async () => {
    installMockElectronAPI({
      openCollabDocumentEntries: [
        { documentId: 'sketch-1', documentType: 'excalidraw' },
      ],
    });
    expect(await getPersistedCollabDocType('/ws', 'sketch-1')).toBe('excalidraw');
    expect(await getPersistedCollabDocType('/ws', 'missing')).toBeUndefined();
  });

  it('returns the migrated markdown type for legacy ids in single-lookup', async () => {
    installMockElectronAPI({ openCollabDocumentIds: ['legacy-doc'] });
    expect(await getPersistedCollabDocType('/ws', 'legacy-doc')).toBe('markdown');
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
