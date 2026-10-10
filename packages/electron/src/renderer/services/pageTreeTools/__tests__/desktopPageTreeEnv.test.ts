/**
 * The agent's Set type puts the new typed page in the place of an open tab of
 * the converted page, so typing never lands in the page that went to Trash,
 * and opens nothing when the page was not open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabDocsSession, SharedDocument } from '@nimbalyst/collab-client/docs';
import type { TabData } from '../../../contexts/TabsContext';

vi.mock('../../../store/atoms/collabDocuments', () => ({
  activeCollabScopeAtom: { toString: () => 'activeCollabScopeAtom' },
  getElectronCollabDocsSession: vi.fn(),
  getPersonalCollabDocsSession: vi.fn(),
  // Every page here is a database page, on the copy-into-an-item path.
  getPersonalCollabHost: () => ({ source: () => ({ isLegacyDocument: () => true }) }),
}));
vi.mock('../../../components/CollabMode/collabTypeResolver', () => ({ buildCollabTypeResolver: vi.fn() }));
vi.mock('../../collaborativeDocumentCreationOrchestrator', () => ({ createCollaborativeDocument: vi.fn() }));
vi.mock('../../CollaborativeDocumentTypeCatalog', () => ({ getCollaborativeDocumentTypeCatalog: vi.fn() }));
// The conversion itself is covered by setPageType's own tests; here it only
// reaches the step that opens the typed page.
vi.mock('../../../components/CollabMode/setPageType', () => ({
  setPageType: vi.fn(async (input: { page: { documentId: string } }, dependencies: { openItem(itemId: string, pageId: string): void }) => {
    dependencies.openItem('dec_1', input.page.documentId);
    return { status: 'done', itemId: 'dec_1' };
  }),
}));

import { createDesktopPageTreeEnv } from '../desktopPageTreeEnv';
import { setPagesTabStripForTest, type PagesTabStrip } from '../pagesTabStrip';

const WS = '/ws/pages';

function fakeStrip(paths: string[]) {
  const tabs = new Map<string, TabData>();
  let order: string[] = [];
  const add = (filePath: string) => {
    const existing = [...tabs.values()].find((tab) => tab.filePath === filePath);
    if (existing) return existing.id;
    const id = `tab-${tabs.size + 1}`;
    tabs.set(id, { id, filePath, fileName: filePath } as TabData);
    order = [...order, id];
    return id;
  };
  paths.forEach(add);
  const strip = {
    getSnapshot: () => ({ tabs: new Map(tabs), tabOrder: [...order] }),
    addTab: (filePath: string) => add(filePath),
    reorderTabs: (from: number, to: number) => {
      const next = [...order];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      order = next;
    },
    removeTab: (id: string) => {
      tabs.delete(id);
      order = order.filter((tabId) => tabId !== id);
    },
  };
  return { strip: strip as unknown as PagesTabStrip, paths: () => order.map((id) => tabs.get(id)!.filePath) };
}

const page: SharedDocument = {
  documentId: 'ideas', title: 'Ideas', teamProjectId: null, documentType: 'markdown',
  createdBy: '', createdAt: 1, updatedAt: 1, parentFolderId: null,
};
const session = {} as CollabDocsSession;

describe('agent Set type and the Pages tab strip', () => {
  beforeEach(() => setPagesTabStripForTest(WS, null));

  it('puts the typed page in the place of the open page tab', async () => {
    const { strip, paths } = fakeStrip(['personal://other', 'personal://ideas', 'tracker://x']);
    setPagesTabStripForTest(WS, strip);
    const outcome = await createDesktopPageTreeEnv(WS).setPageType('personal', session, page, 'decision');
    expect(outcome).toMatchObject({ status: 'done' });
    expect(paths()).toEqual(['personal://other', 'tracker://dec_1', 'tracker://x']);
  });

  it('opens nothing when the page was not open', async () => {
    const { strip, paths } = fakeStrip(['personal://other']);
    setPagesTabStripForTest(WS, strip);
    await createDesktopPageTreeEnv(WS).setPageType('personal', session, page, 'decision');
    expect(paths()).toEqual(['personal://other']);
  });
});

describe('agent createSharedDoc', () => {
  it('seeds a structured type from its own default when given no content, and keeps Local pages markdown', async () => {
    const { createCollaborativeDocument } = await import('../../collaborativeDocumentCreationOrchestrator');
    const { getCollaborativeDocumentTypeCatalog } = await import('../../CollaborativeDocumentTypeCatalog');
    vi.mocked(getCollaborativeDocumentTypeCatalog).mockReturnValue({
      inferFileExtension: () => '.x',
      resolveMetadata: (documentType: string) => ({ state: 'ready', descriptor: { documentType } }),
    } as never);
    vi.mocked(createCollaborativeDocument).mockResolvedValue({ documentId: 'new' } as never);
    const env = createDesktopPageTreeEnv(WS);
    const input = { title: 'Diagram', parentId: null, parentKind: 'page' as const, content: '' };

    await env.createPage('team', session, { ...input, documentType: 'excalidraw' });
    expect(vi.mocked(createCollaborativeDocument).mock.calls[0]![0].sourceContent).toBeUndefined();
    await env.createPage('team', session, { ...input, documentType: 'markdown' });
    expect(vi.mocked(createCollaborativeDocument).mock.calls[1]![0].sourceContent).toBe('');

    // A Local page is a file in the wiki folder: markdown or an editor type, never code.
    await env.createPage('personal', session, { ...input, documentType: 'markdown' });
    await env.createPage('personal', session, { ...input, documentType: 'excalidraw' });
    await expect(env.createPage('personal', session, { ...input, documentType: 'code' })).rejects.toThrow(/cannot be a "code" page/);
    expect(createCollaborativeDocument).toHaveBeenCalledTimes(4);
  });
});
