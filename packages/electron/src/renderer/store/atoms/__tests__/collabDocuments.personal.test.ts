// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  activeCollabScopeAtom,
  getElectronCollabHostForScopeKey,
  getPersonalCollabDocsSession,
  invalidateElectronCollabScopes,
  personalPagesDocumentsAtomFamily,
  pruneCollabDocumentsScopeState,
} from '../collabDocuments';

const WORKSPACE = '/workspace/personal-atoms';
const page = {
  documentId: 'p1', teamProjectId: null, title: 'Reading list.md', documentType: 'markdown',
  parentFolderId: null, createdBy: '', createdAt: 1, updatedAt: 1,
};

let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'local-wiki:snapshot') return { items: [page], containers: [], pages: [] };
    if (channel === 'local-wiki:legacy-snapshot') return { items: [] };
    if (channel === 'workspace:get-state') return {};
    return { ok: true };
  });
  (globalThis as any).window = { electronAPI: { invoke, on: vi.fn(() => () => undefined) } };
});

afterEach(() => {
  pruneCollabDocumentsScopeState(WORKSPACE);
  delete (globalThis as any).window;
});

describe('Personal pages state', () => {
  it('exposes the personal documents by workspace and survives a sign-in or sign-out', async () => {
    await getPersonalCollabDocsSession(WORKSPACE).start();

    const documents = personalPagesDocumentsAtomFamily(WORKSPACE);
    expect(store.get(documents).map((document) => document.documentId)).toEqual(['p1']);
    expect(store.get(activeCollabScopeAtom)).toBeNull();

    // Auth and org changes re-resolve the team host only.
    const teamScopeChanges = vi.fn();
    getElectronCollabHostForScopeKey(WORKSPACE).onScopeChanged(teamScopeChanges);
    invoke.mockClear();
    invalidateElectronCollabScopes();

    expect(teamScopeChanges).toHaveBeenCalledWith(null);
    expect(invoke).not.toHaveBeenCalledWith('local-wiki:snapshot', WORKSPACE);
    expect(store.get(documents).map((document) => document.documentId)).toEqual(['p1']);
    expect(store.get(getPersonalCollabDocsSession(WORKSPACE).atoms.syncStatus)).toBe('connected');
  });
});
