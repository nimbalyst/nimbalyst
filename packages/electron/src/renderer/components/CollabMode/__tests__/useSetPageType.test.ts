// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { atom } from 'jotai';
import type { CollabDocsSession } from '@nimbalyst/collab-client/docs';

vi.mock('../../../services/HeadlessCollabDocument', () => ({ readHeadlessCollabDocContent: vi.fn() }));
vi.mock('../../../services/DocumentReplicaCache', () => ({ buildDocumentReplicaCacheKey: vi.fn(), getDocumentReplicaCache: vi.fn() }));
vi.mock('../../../services/ErrorNotificationService', () => ({ errorNotificationService: { showWarning: vi.fn(), showError: vi.fn() } }));
vi.mock('../../../utils/collabDocumentOpener', () => ({ getCollabConfig: vi.fn() }));
vi.mock('../usePersonalPageBody', () => ({ flushPersonalPageBody: vi.fn() }));
vi.mock('../../../services/localWikiSetType', () => ({ isLocalWikiPage: (_ws: string, id: string) => id.startsWith('wiki-'), setLocalWikiPageType: vi.fn() }));
vi.mock('../../../store/atoms/collabDocuments', () => ({ getPersonalCollabHost: () => ({ source: () => ({ filePathsById: () => openFiles }) }) }));
vi.mock('../../../services/document-model/DocumentModelRegistry', () => ({ DocumentModelRegistry: { get: (path: string) => models.get(path) ?? null } }));

const openFiles = new Map([['wiki-1', '/ws/wiki/Plan.md']]);
const models = new Map<string, { isDirty: () => boolean; flushDirtyEditors: () => Promise<void> }>();

import { buildSetPageTypeDependencies } from '../useSetPageType';

describe('buildSetPageTypeDependencies', () => {
  // The session reports a refused trash as a result, not a throw; Set type
  // only keeps both pages (and says so) when trashPage rejects.
  it('fails the page trash when the session refuses it', async () => {
    const session = {
      trashDocument: vi.fn(async () => ({ ok: false as const, error: 'shared documents are offline' })),
    } as unknown as CollabDocsSession;
    const dependencies = buildSetPageTypeDependencies(
      { lane: 'team', workspacePath: '/ws', session, teamScope: null, tabsActions: {} as never },
      'Sync engine',
    );
    await expect(dependencies.trashPage('page-1')).rejects.toThrow('shared documents are offline');

    vi.mocked(session.trashDocument).mockResolvedValueOnce({ ok: true });
    await expect(dependencies.trashPage('page-1')).resolves.toBeUndefined();
  });

  // Move to Team copies the file and Set type rewrites it: an open tab's
  // unsaved edits are saved first, and a save that does not happen stops them.
  it('saves an open Local page editor before acting, and refuses when the save does not land', async () => {
    let dirty = true;
    const flushDirtyEditors = vi.fn(async () => { dirty = false; });
    models.set('/ws/wiki/Plan.md', { isDirty: () => dirty, flushDirtyEditors });
    const session = { atoms: { allSharedDocuments: atom([{ documentId: 'wiki-1', title: 'Plan' }]) } } as unknown as CollabDocsSession;
    const dependencies = buildSetPageTypeDependencies(
      { lane: 'personal', workspacePath: '/ws', session, teamScope: null, tabsActions: {} as never },
      'Plan',
    );
    await dependencies.flushPageEditor('wiki-1');
    expect(flushDirtyEditors).toHaveBeenCalledTimes(1);

    dirty = true;
    flushDirtyEditors.mockImplementationOnce(async () => {});
    await expect(dependencies.flushPageEditor('wiki-1')).rejects.toThrow('"Plan" has edits that could not be saved');
  });
});
