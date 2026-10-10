// @vitest-environment node
/**
 * Closed-document reads (NIM-3754).
 *
 * Every assertion here runs with NO mounted editor, because that is the only
 * state in which the bug exists -- a test that opens the document first passes
 * against the broken code.
 *
 * Only the authenticated room and catalog boundaries are replaced. The
 * acquisition, codec registry, and Y.Doc paths are the production ones.
 */
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCollabContentAdapters,
  registerCollabContentAdapter,
} from '@nimbalyst/collab-adapters';

const host = vi.hoisted(() => ({
  acquire: vi.fn(),
  getDocuments: vi.fn(),
  getTeamProvider: vi.fn(),
  findOtherProject: vi.fn((_scopeKey: unknown, _documentId: unknown): unknown => null),
}));

vi.mock('../../store/atoms/collabDocuments', () => ({
  getSharedDocumentsForScopeKey: host.getDocuments,
  getTeamSyncProviderForScopeKey: host.getTeamProvider,
  findOtherProjectDocument: host.findOtherProject,
}));

vi.mock('../CollaborativeEmbedProviderCache', () => ({
  collaborativeEmbedProviderCache: { acquire: host.acquire },
}));

vi.mock('../CollaborativeDocumentTypeCatalog', () => ({
  getCollaborativeDocumentTypeCatalog: () => ({
    editorIdForDescriptor: () => 'com.nimbalyst.test',
    resolveMetadata: () => ({
      state: 'ready',
      descriptor: { defaultExtension: '.testdoc' },
    }),
  }),
}));

import { editorRegistry } from '@nimbalyst/runtime/ai/EditorRegistry';

import {
  HeadlessCollabDocumentError,
  readHeadlessCollabDocContent,
} from '../HeadlessCollabDocument';
import { applyAgentDiff, readCollabDocForAgent } from '../agentDocumentAccess';

const DOCUMENT_URI = 'collab://org:org-1:doc:doc-1';
const WORKSPACE_PATH = '/workspace';
const BODY = 'the current room contents';

/**
 * `toPlainText` deliberately returns something DIFFERENT from `exportToFile`
 * here. The two agree for markdown, which would let a read silently switch to
 * the lossy projection without any test noticing -- and an agent that quotes a
 * lossy projection back as `oldText` cannot match the document it is editing.
 */
const TEST_CODEC = {
  documentType: 'test-doc',
  fileExtensions: ['.testdoc'],
  layoutVersion: 1,
  isEmpty: (yDoc: Y.Doc) => yDoc.getText('body').length === 0,
  seedFromFile: () => {},
  applyFromFile: () => {},
  exportToFile: (yDoc: Y.Doc) => yDoc.getText('body').toString(),
  toPlainText: () => 'lossy projection, not for round-tripping',
};

/** Options mirror the room states a headless peer can legitimately be in. */
function stubRoom(options: {
  synced?: boolean;
  undecoded?: boolean;
  body?: string;
} = {}) {
  const yDoc = new Y.Doc();
  yDoc.getText('body').insert(0, options.body ?? BODY);
  const release = vi.fn();
  host.acquire.mockResolvedValue({
    release,
    resource: {
      config: { orgId: 'org-1', teamMemberId: 'member-1' },
      replica: { getOutboxState: () => 'clean' },
      syncProvider: {
        getYDoc: () => yDoc,
        isSynced: () => options.synced ?? true,
        getStatus: () => (options.synced ?? true ? 'connected' : 'connecting'),
        hasUndecodedContent: () => options.undecoded ?? false,
      },
    },
  });
  return { yDoc, release };
}

describe('readHeadlessCollabDocContent', () => {
  beforeEach(() => {
    host.acquire.mockReset();
    host.getTeamProvider.mockReturnValue(undefined);
    host.getDocuments.mockReturnValue([
      {
        documentId: 'doc-1',
        title: 'Shared doc',
        documentType: 'test-doc',
        fileExtension: '.testdoc',
        editorId: 'com.nimbalyst.test',
        teamProjectId: null,
      },
    ]);
    registerCollabContentAdapter(TEST_CODEC);
  });

  afterEach(() => {
    clearCollabContentAdapters();
  });

  it('reads a document that is not open in any editor', async () => {
    stubRoom();

    await expect(
      readHeadlessCollabDocContent(DOCUMENT_URI, WORKSPACE_PATH),
    ).resolves.toBe(BODY);
  });

  it('releases the acquisition after a successful read', async () => {
    const { release } = stubRoom();

    await readHeadlessCollabDocContent(DOCUMENT_URI, WORKSPACE_PATH);

    expect(release).toHaveBeenCalledTimes(1);
  });

  /**
   * The failure that silently corrupts callers: an unsynced peer's Y.Doc reads
   * empty because it has been told nothing yet, not because the room is empty.
   * Returning '' here would tell an agent the document has no content.
   */
  it('reports a never-synced peer as unreachable rather than empty content', async () => {
    stubRoom({ synced: false, body: '' });

    await expect(
      readHeadlessCollabDocContent(DOCUMENT_URI, WORKSPACE_PATH, {
        hydrationTimeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: 'ROOM_UNREACHABLE' });
  });

  it('releases the acquisition when the room never syncs', async () => {
    const { release } = stubRoom({ synced: false });

    await readHeadlessCollabDocContent(DOCUMENT_URI, WORKSPACE_PATH, {
      hydrationTimeoutMs: 50,
    }).catch(() => {});

    expect(release).toHaveBeenCalledTimes(1);
  });

  /** The room holds content this client cannot decode -- also not "empty". */
  it('refuses to report content when the room holds undecodable state', async () => {
    stubRoom({ undecoded: true });

    await expect(
      readHeadlessCollabDocContent(DOCUMENT_URI, WORKSPACE_PATH),
    ).rejects.toMatchObject({ code: 'UNDECODABLE_CONTENT' });
  });

  it('fails loudly when no codec is registered for the document type', async () => {
    clearCollabContentAdapters();
    stubRoom();

    await expect(
      readHeadlessCollabDocContent(DOCUMENT_URI, WORKSPACE_PATH),
    ).rejects.toBeInstanceOf(HeadlessCollabDocumentError);
  });

  it('fails when the document is not in the workspace shared index', async () => {
    host.getDocuments.mockReturnValue([]);
    stubRoom();

    await expect(
      readHeadlessCollabDocContent(DOCUMENT_URI, WORKSPACE_PATH),
    ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_AVAILABLE' });
  });
});

/**
 * The routing decision itself. A mounted editor is what the user is looking at,
 * so it stays authoritative; headless is the fallback that makes the tool work
 * at all when nobody has the tab open.
 */
describe('readCollabDocForAgent', () => {
  const MOUNTED_BODY = 'what the open editor currently shows';

  beforeEach(() => {
    host.acquire.mockReset();
    host.getTeamProvider.mockReturnValue(undefined);
    host.getDocuments.mockReturnValue([
      {
        documentId: 'doc-1',
        title: 'Shared doc',
        documentType: 'test-doc',
        fileExtension: '.testdoc',
        editorId: 'com.nimbalyst.test',
        teamProjectId: null,
      },
    ]);
    registerCollabContentAdapter(TEST_CODEC);
  });

  afterEach(() => {
    clearCollabContentAdapters();
    editorRegistry.unregister(DOCUMENT_URI);
  });

  it('prefers a mounted editor over a second peer in the room', async () => {
    editorRegistry.register({
      filePath: DOCUMENT_URI,
      editor: {} as never,
      hasPendingDiffs: () => false,
      applyReplacements: async () => ({ success: true }),
      startStreaming: () => {},
      streamContent: () => {},
      endStreaming: () => {},
      getContent: () => MOUNTED_BODY,
    });
    stubRoom();

    await expect(
      readCollabDocForAgent(DOCUMENT_URI, WORKSPACE_PATH),
    ).resolves.toEqual({ content: MOUNTED_BODY, route: 'mounted' });
    expect(host.acquire).not.toHaveBeenCalled();
  });

  it('falls back to the room when no editor is mounted', async () => {
    stubRoom();

    await expect(
      readCollabDocForAgent(DOCUMENT_URI, WORKSPACE_PATH),
    ).resolves.toEqual({ content: BODY, route: 'headless' });
  });

  it('fails when there is no workspace to reach the room through', async () => {
    stubRoom();

    await expect(
      readCollabDocForAgent(DOCUMENT_URI, null),
    ).rejects.toBeInstanceOf(HeadlessCollabDocumentError);
  });
});

/**
 * The window holds other projects' pages only to name them in links. An agent
 * edit reaches a page through a mounted editor or the room, and either would
 * write to another project, so the project is checked before either route.
 */
describe('another project\'s page', () => {
  const applyReplacements = vi.fn(async () => ({ success: true }));

  beforeEach(() => {
    host.acquire.mockReset();
    applyReplacements.mockClear();
    host.findOtherProject.mockImplementation((scopeKey: unknown, documentId: unknown) =>
      scopeKey === WORKSPACE_PATH && documentId === 'doc-1'
        ? { document: { documentId: 'doc-1', title: 'Their page' }, projectId: 'project-b' }
        : null);
    stubRoom();
  });

  afterEach(() => {
    host.findOtherProject.mockReset().mockReturnValue(null);
    editorRegistry.unregister(DOCUMENT_URI);
  });

  const mount = () => editorRegistry.register({
    filePath: DOCUMENT_URI,
    editor: {} as never,
    hasPendingDiffs: () => false,
    applyReplacements,
    startStreaming: () => {},
    streamContent: () => {},
    endStreaming: () => {},
    getContent: () => 'their body',
  });

  it('refuses an edit whether the page is mounted or not', async () => {
    const edit = () => applyAgentDiff(DOCUMENT_URI, [{ oldText: 'a', newText: 'b' }], { workspacePath: WORKSPACE_PATH });
    expect(await edit()).toMatchObject({ success: false, code: 'OTHER_PROJECT', error: expect.stringContaining('changes stay in the current project') });
    mount();
    expect(await edit()).toMatchObject({ success: false, code: 'OTHER_PROJECT' });
    expect(applyReplacements).not.toHaveBeenCalled();
    expect(host.acquire).not.toHaveBeenCalled();
  });

  it('does not read a mounted page past the project check', async () => {
    mount();
    await expect(readCollabDocForAgent(DOCUMENT_URI, WORKSPACE_PATH))
      .rejects.toMatchObject({ code: 'OTHER_PROJECT', projectId: 'project-b' });
  });
});
