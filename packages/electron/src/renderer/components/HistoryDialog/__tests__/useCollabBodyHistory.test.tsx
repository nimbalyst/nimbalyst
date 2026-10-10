// @vitest-environment jsdom
/**
 * A typed page's body and a type page's prose are shared rooms with the same
 * revision API as any shared page, but nothing recorded revisions for them or
 * offered their history. This hook is what makes them a page with history:
 * it publishes the controller the history dialog reads, bootstraps the room's
 * history, records idle changes, and restores through the live editor.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';
import React from 'react';
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';

vi.mock('@nimbalyst/runtime/editor', () => ({
  getEditorTransformers: () => [],
  $convertToEnhancedMarkdownString: () => $getRoot().getTextContent(),
  $convertFromEnhancedMarkdownString: (markdown: string) => {
    $getRoot().append($createParagraphNode().append($createTextNode(markdown)));
  },
}));

import { useCollabBodyHistory } from '../useCollabBodyHistory';
import { collabHistoryControllerAtom } from '../../../store/atoms/collabHistoryControllers';
import {
  AUTO_REVISION_IDLE_MS,
  CollabRevisionRecorder,
  restoreCollabRevision,
  type CollabHistoryController,
} from '@nimbalyst/collab-client/docs-ui/history';
import type { CreateRevisionInput } from '@nimbalyst/runtime/sync/collabHistoryClient';

const URI = 'collab://org/org-1/tracker-content%2Fitem-1';
const encode = (text: string) => new TextEncoder().encode(text);

function fakeClient(existing: Array<{ revisionId: string; contentHash: string; revisionKind: string; createdAt: number }> = []) {
  const createRevision = vi.fn(async (_input: CreateRevisionInput) => ({ revisionId: 'r-new', createdAt: 1 }));
  const client = {
    listRevisions: vi.fn(async () => ({ revisions: existing, cursor: null })),
    loadRevision: vi.fn(async () => ({ metadata: {}, plaintext: encode('Before the agent') })),
    createRevision,
  } as unknown as CollabHistoryController['client'];
  return { client, createRevision };
}
const kinds = (mock: ReturnType<typeof fakeClient>['createRevision']) => mock.mock.calls.map(([input]) => input.revisionKind);

function bodyEditor(text: string) {
  const editor = createEditor({ onError: (error) => { throw error; } });
  editor.setRootElement(document.createElement('div'));
  editor.update(() => { $getRoot().append($createParagraphNode().append($createTextNode(text))); }, { discrete: true });
  return editor;
}

const syncProvider = { getLastSeq: () => 7, getStatus: () => 'connected' as const, waitForPendingWrites: async () => true };

afterEach(cleanup);

describe('useCollabBodyHistory', () => {
  it('publishes the body history, bootstraps an empty room and restores through the live editor', async () => {
    const { client, createRevision } = fakeClient();
    const editor = bodyEditor('Agent rewrite');
    const store = createStore();
    const wrapper = ({ children }: { children: React.ReactNode }) => <Provider store={store}>{children}</Provider>;
    const { unmount } = renderHook(() => useCollabBodyHistory({ uri: URI, client, syncProvider, editor }), { wrapper });

    const controller = store.get(collabHistoryControllerAtom)(URI) as CollabHistoryController;
    expect(controller).not.toBeNull();
    await vi.waitFor(() => expect(createRevision).toHaveBeenCalledWith(expect.objectContaining({ revisionKind: 'bootstrap', basisSequence: 7 })));
    expect(new TextDecoder().decode(createRevision.mock.calls[0]![0].plaintext)).toBe('Agent rewrite');

    await act(async () => { await restoreCollabRevision(controller, 'r-1'); });
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('Before the agent');
    expect(kinds(createRevision)).toEqual(['bootstrap', 'restore-pre', 'restore-head']);

    unmount();
    expect(store.get(collabHistoryControllerAtom)(URI)).toBeNull();
  });

  it('records an auto revision only after a change has been idle', async () => {
    let now = 1_000_000;
    let text = 'v1';
    const { client, createRevision } = fakeClient([{ revisionId: 'r0', contentHash: 'old', revisionKind: 'bootstrap', createdAt: 0 }]);
    const recorder = new CollabRevisionRecorder({
      client, editorType: 'markdown', contentFormat: 'markdown',
      exportSnapshot: () => encode(text), getBasisSequence: () => 3, getStatus: () => 'connected',
    }, () => now);

    await recorder.tick(); // history exists: no bootstrap
    await recorder.tick(); // first sight of v1
    now += AUTO_REVISION_IDLE_MS - 1;
    await recorder.tick();
    expect(createRevision).not.toHaveBeenCalled();
    now += 2;
    await recorder.tick();
    expect(createRevision).toHaveBeenCalledTimes(1);
    expect(kinds(createRevision)).toEqual(['auto']);
    now += AUTO_REVISION_IDLE_MS * 10;
    await recorder.tick(); // unchanged since recorded
    text = 'v2';
    await recorder.tick();
    expect(createRevision).toHaveBeenCalledTimes(1);
  });
});
