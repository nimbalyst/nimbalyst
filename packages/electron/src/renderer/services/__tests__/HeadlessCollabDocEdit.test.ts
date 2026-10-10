/**
 * Closed-document writes (NIM-3754 / NIM-2640).
 *
 * Runs with NO mounted editor throughout -- the state in which the tools used
 * to refuse outright. The markdown reconciliation path is heavy (Lexical) and
 * is mocked here; this file covers the dispatch, the durability guards, and
 * presence. `headlessMarkdownEdit` gets its own coverage where paying for
 * Lexical buys something.
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
  applyMarkdown: vi.fn(),
  createRevision: vi.fn(),
}));

vi.mock('../../store/atoms/collabDocuments', () => ({
  getSharedDocumentsForScopeKey: host.getDocuments,
  getTeamSyncProviderForScopeKey: host.getTeamProvider,
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

vi.mock('../headlessMarkdownEdit', () => ({
  applyMarkdownReplacementsToYDoc: host.applyMarkdown,
}));

vi.mock('@nimbalyst/runtime/sync/collabHistoryClient', () => ({
  CollabHistoryClient: class {
    createRevision(input: unknown) {
      return host.createRevision(input);
    }
  },
}));

import { applyHeadlessCollabDocEdit } from '../HeadlessCollabDocEdit';
import { resetAgentEditRevisionBursts } from '../collabAgentEditRevision';

const DOCUMENT_URI = 'collab://org:org-1:doc:doc-1';
const WORKSPACE_PATH = '/workspace';
const BODY = 'alpha beta gamma';

function body(yDoc: Y.Doc) {
  return yDoc.getText('body').toString();
}

const CODEC_ONLY_TYPE = {
  documentType: 'test-doc',
  fileExtensions: ['.testdoc'],
  layoutVersion: 1,
  isEmpty: (yDoc: Y.Doc) => yDoc.getText('body').length === 0,
  seedFromFile: () => {},
  applyFromFile: (yDoc: Y.Doc, source: string | Uint8Array) => {
    const text = yDoc.getText('body');
    text.delete(0, text.length);
    text.insert(0, typeof source === 'string' ? source : '');
  },
  exportToFile: body,
  toPlainText: body,
};

const MARKDOWN_CODEC = { ...CODEC_ONLY_TYPE, documentType: 'markdown', fileExtensions: ['.md'] };

function stubRoom(options: {
  documentType?: string;
  synced?: boolean;
  undecoded?: boolean;
  acked?: boolean;
  /** Give the provider what it needs to reach the room's version history. */
  history?: boolean;
} = {}) {
  const yDoc = new Y.Doc();
  yDoc.getText('body').insert(0, BODY);
  const release = vi.fn();
  const flushWithAck = vi.fn().mockResolvedValue(options.acked ?? true);
  const sendAwareness = vi.fn().mockResolvedValue(undefined);
  const sendAwarenessDeparture = vi.fn().mockReturnValue(true);
  host.getDocuments.mockReturnValue([
    {
      documentId: 'doc-1',
      title: 'Shared doc',
      documentType: options.documentType ?? 'test-doc',
      fileExtension: '.testdoc',
      editorId: 'com.nimbalyst.test',
      teamProjectId: null,
    },
  ]);
  host.acquire.mockResolvedValue({
    release,
    resource: {
      config: {
        orgId: 'org-1',
        teamMemberId: 'member-1',
        ...(options.history
          ? { documentId: 'doc-1', serverUrl: 'wss://sync.test', getJwt: async () => 'jwt' }
          : {}),
      },
      replica: { getOutboxState: () => 'clean' },
      syncProvider: {
        getYDoc: () => yDoc,
        isSynced: () => options.synced ?? true,
        getStatus: () => (options.synced ?? true ? 'connected' : 'connecting'),
        hasUndecodedContent: () => options.undecoded ?? false,
        flushWithAck,
        sendAwareness,
        sendAwarenessDeparture,
        ...(options.history ? { getLastSeq: () => 42 } : {}),
      },
    },
  });
  return { yDoc, release, flushWithAck, sendAwareness, sendAwarenessDeparture };
}

const EDIT = [{ oldText: 'beta', newText: 'BETA' }];

describe('applyHeadlessCollabDocEdit', () => {
  beforeEach(() => {
    host.acquire.mockReset();
    host.applyMarkdown.mockReset();
    host.createRevision.mockReset();
    resetAgentEditRevisionBursts();
    host.getTeamProvider.mockReturnValue(undefined);
    registerCollabContentAdapter(CODEC_ONLY_TYPE);
    registerCollabContentAdapter(MARKDOWN_CODEC);
  });

  afterEach(() => {
    clearCollabContentAdapters();
  });

  it('edits a codec-only document that is not open in any editor', async () => {
    const { yDoc } = stubRoom();

    await applyHeadlessCollabDocEdit(DOCUMENT_URI, WORKSPACE_PATH, EDIT);

    expect(body(yDoc)).toBe('alpha BETA gamma');
  });

  /**
   * The decision that separates a minimal delta from a whole-document replace.
   * Markdown must NOT go through the codec's clear-and-reseed.
   */
  it('routes a markdown document through the editor reconciliation path', async () => {
    const { yDoc } = stubRoom({ documentType: 'markdown' });

    await applyHeadlessCollabDocEdit(DOCUMENT_URI, WORKSPACE_PATH, EDIT);

    expect(host.applyMarkdown).toHaveBeenCalledWith(yDoc, EDIT);
    expect(body(yDoc)).toBe(BODY);
  });

  it('reports failure when the server never acknowledges the write', async () => {
    stubRoom({ acked: false });

    await expect(
      applyHeadlessCollabDocEdit(DOCUMENT_URI, WORKSPACE_PATH, EDIT),
    ).rejects.toMatchObject({ code: 'FLUSH_TIMEOUT' });
  });

  it('refuses to overwrite a room whose contents it cannot decode', async () => {
    const { yDoc } = stubRoom({ undecoded: true });

    await expect(
      applyHeadlessCollabDocEdit(DOCUMENT_URI, WORKSPACE_PATH, EDIT),
    ).rejects.toMatchObject({ code: 'UNDECODABLE_CONTENT' });
    expect(body(yDoc)).toBe(BODY);
  });

  /**
   * A never-synced peer holds none of the document, so a clear-then-insert
   * merges as a second copy rather than replacing anything.
   */
  it('refuses to write through a peer that never synced', async () => {
    const { yDoc, flushWithAck } = stubRoom({ synced: false });

    await expect(
      applyHeadlessCollabDocEdit(DOCUMENT_URI, WORKSPACE_PATH, EDIT, {
        hydrationTimeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: 'ROOM_UNREACHABLE' });
    expect(body(yDoc)).toBe(BODY);
    expect(flushWithAck).not.toHaveBeenCalled();
  });

  it('fails loudly when the text to replace is not in the document', async () => {
    const { yDoc } = stubRoom();

    await expect(
      applyHeadlessCollabDocEdit(DOCUMENT_URI, WORKSPACE_PATH, [
        { oldText: 'text that is not there', newText: 'x' },
      ]),
    ).rejects.toBeTruthy();
    expect(body(yDoc)).toBe(BODY);
  });

  it('announces the agent as a participant and clears it afterwards', async () => {
    const { sendAwareness, sendAwarenessDeparture } = stubRoom();

    await applyHeadlessCollabDocEdit(DOCUMENT_URI, WORKSPACE_PATH, EDIT, {
      agent: { sessionId: 'session-1', sessionName: 'Refactor pass' },
    });

    expect(sendAwareness).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'session-1', name: 'Refactor pass' }),
    });
    expect(sendAwarenessDeparture).toHaveBeenCalledTimes(1);
  });

  /**
   * A ghost participant outlives the session that created it, so the departure
   * has to survive the edit blowing up -- not just the happy path.
   */
  it('clears the agent participant even when the edit fails', async () => {
    const { sendAwarenessDeparture, release } = stubRoom({ acked: false });

    await applyHeadlessCollabDocEdit(DOCUMENT_URI, WORKSPACE_PATH, EDIT, {
      agent: { sessionId: 'session-1', sessionName: 'Refactor pass' },
    }).catch(() => {});

    expect(sendAwarenessDeparture).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  /**
   * An agent edit to a shared document lands as final text, so the version
   * history is the undo. Its own auto snapshots only fire after idle time with a
   * tab open, so the edit path records the state it is about to replace.
   */
  it('records the pre-edit markdown as a revision before the first edit of a burst', async () => {
    stubRoom({ documentType: 'markdown', history: true });
    const order: string[] = [];
    host.createRevision.mockImplementation(async (input: { plaintext: Uint8Array }) => {
      order.push(`revision:${new TextDecoder().decode(input.plaintext)}`);
      return {};
    });
    host.applyMarkdown.mockImplementation(() => order.push('edit'));

    await applyHeadlessCollabDocEdit(DOCUMENT_URI, WORKSPACE_PATH, EDIT);
    await applyHeadlessCollabDocEdit(DOCUMENT_URI, WORKSPACE_PATH, EDIT);

    expect(order).toEqual([`revision:${BODY}`, 'edit', 'edit']);
    expect(host.createRevision).toHaveBeenCalledWith(
      expect.objectContaining({ revisionKind: 'auto', contentFormat: 'markdown', basisSequence: 42 })
    );
  });

  it('still applies the edit when the history server refuses the revision', async () => {
    stubRoom({ documentType: 'markdown', history: true });
    host.createRevision.mockRejectedValue(new Error('503'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await applyHeadlessCollabDocEdit(DOCUMENT_URI, WORKSPACE_PATH, EDIT);

    expect(host.applyMarkdown).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
