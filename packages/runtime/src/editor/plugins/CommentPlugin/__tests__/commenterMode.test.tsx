/**
 * Commenter mode (`editBody: false`): the server refuses any update from this
 * user that changes the Lexical `root`, so these tests bind a real Lexical
 * editor to a Y.Doc the way `useYjsCollaboration` does and assert on the Yjs
 * updates the client emits, not on editor state.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { $wrapSelectionInMarkNode, MarkNode } from '@lexical/mark';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { createHeadlessEditor } from '@lexical/headless';
import {
  createBinding,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_EDITOR,
  SKIP_COLLAB_TAG,
  type LexicalEditor,
} from 'lexical';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import {
  collabCommentControllerRegistry,
  collectMarkIds,
} from '../../../commenting/CollabCommentControllerRegistry';
import { resolveQuoteHighlights } from '../../../commenting/quoteAnchors';
import {
  createComment,
  createThread,
  YDocCommentRepository,
} from '../../../commenting/YDocCommentRepository';
import type {
  CommentCapabilities,
  CommentsConfig,
  Thread,
} from '../../../commenting/types';
import { INSERT_INLINE_COMMENT_COMMAND } from '../../../extensions/builtin/CommentsExtension';
import type { CollaborativeCommentsPanelProps } from '../../../commenting/ui/CollaborativeCommentsPanel';
import CommentsPlugin, { ORPHAN_MARK_GRACE_MS } from '../index';

// The real panel, with its latest props kept so a test can call a handler the
// panel no longer offers (a stale click, a keyboard path) and check the
// plugin's own mutation-time check.
const lastPanelProps = vi.hoisted(() => ({
  current: null as CollaborativeCommentsPanelProps | null,
}));
vi.mock('../../../commenting/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../commenting/ui')>();
  return {
    ...actual,
    CollaborativeCommentsPanel: (props: CollaborativeCommentsPanelProps) => {
      lastPanelProps.current = props;
      return actual.CollaborativeCommentsPanel(props);
    },
  };
});
import { OPEN_COMMENT_COMPOSER_COMMAND } from '../commands';

const bindingProvider = {
  awareness: {
    getLocalState: () => null,
    setLocalState: () => {},
    getStates: () => new Map(),
    on: () => {},
    off: () => {},
  },
} as any;

/**
 * Server-side document state holding real Lexical collab content, optionally
 * with a comment MarkNode around `mark.quote` as an editor client writes it.
 */
function serverDocWith(
  paragraphs: string[],
  mark?: { quote: string; id: string },
): Y.Doc {
  const doc = new Y.Doc();
  const writer = createHeadlessEditor({
    namespace: 'commenter-mode-writer',
    nodes: [MarkNode],
    onError: (error) => {
      throw error;
    },
  });
  const binding = createBinding(
    writer,
    bindingProvider,
    'main',
    doc,
    new Map([['main', doc]]),
  );
  const remove = writer.registerUpdateListener((payload) => {
    syncLexicalUpdateToYjs(
      binding,
      bindingProvider,
      payload.prevEditorState,
      payload.editorState,
      payload.dirtyElements,
      payload.dirtyLeaves,
      payload.normalizedNodes,
      payload.tags,
    );
  });
  writer.update(
    () => {
      for (const text of paragraphs) {
        $getRoot().append($createParagraphNode().append($createTextNode(text)));
      }
    },
    { discrete: true },
  );
  if (mark) {
    writer.update(
      () => {
        for (const node of $getRoot().getAllTextNodes()) {
          const start = node.getTextContent().indexOf(mark.quote);
          if (start === -1) continue;
          const selection = node.select(start, start + mark.quote.length);
          $wrapSelectionInMarkNode(selection, false, mark.id);
          return;
        }
      },
      { discrete: true },
    );
  }
  remove();
  return doc;
}

/** Binds the composer's editor to `doc` exactly as `useYjsCollaboration` does. */
function CollabBridge({
  doc,
  onReady,
}: {
  doc: Y.Doc;
  onReady(editor: LexicalEditor): void;
}): null {
  const [editor] = useLexicalComposerContext();
  onReady(editor);
  useEffect(() => {
    // A mounted editor has a root element; Lexical reports node mutations
    // (which CommentsPlugin's mark map is built from) only when it reconciles
    // a DOM.
    const rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    document.body.append(rootElement);
    editor.setRootElement(rootElement);
    const binding = createBinding(
      editor,
      bindingProvider,
      'main',
      doc,
      new Map([['main', doc]]),
    );
    const sharedRoot = binding.root.getSharedType();
    const onYjs = (events: any, transaction: Y.Transaction) => {
      if (transaction.origin !== binding) {
        syncYjsChangesToLexical(binding, bindingProvider, events, false, () => {});
      }
    };
    sharedRoot.observeDeep(onYjs);
    const removeListener = editor.registerUpdateListener((payload) => {
      if (!payload.tags.has(SKIP_COLLAB_TAG)) {
        syncLexicalUpdateToYjs(
          binding,
          bindingProvider,
          payload.prevEditorState,
          payload.editorState,
          payload.dirtyElements,
          payload.dirtyLeaves,
          payload.normalizedNodes,
          payload.tags,
        );
      }
    });
    const removeCommand = editor.registerCommand(
      INSERT_INLINE_COMMENT_COMMAND,
      ({ id, isBackward }) => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          $wrapSelectionInMarkNode(selection, isBackward, id);
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
    return () => {
      sharedRoot.unobserveDeep(onYjs);
      removeListener();
      removeCommand();
      editor.setRootElement(null);
      rootElement.remove();
    };
  }, [doc, editor]);
  return null;
}

function mountClient(
  server: Y.Doc,
  capabilities: CommentCapabilities | undefined,
) {
  const clientDoc = new Y.Doc();
  // Everything the client emits from creation on, as its provider would send
  // it, so the server-side copy below never misses a dependency.
  const outgoing = recordOutgoing(clientDoc);
  const pane = document.createElement('div');
  const anchor = document.createElement('div');
  pane.append(anchor);
  document.body.append(pane);
  const config: CommentsConfig = {
    getYDoc: () => clientDoc,
    currentUser: { id: 'reviewer-1', name: 'Reviewer' },
    getCapabilities: capabilities ? () => capabilities : undefined,
    isHydrated: () => true,
    getMembers: () => [],
    documentTitle: 'Published page',
    documentId: 'doc-1',
    documentUri: 'collab://org:test:doc:doc-1',
  };
  let editor: LexicalEditor | undefined;
  const renderClient = (commentsConfig: CommentsConfig) => (
    <LexicalComposer
      initialConfig={{
        namespace: `commenter-mode-${Math.random()}`,
        nodes: [MarkNode],
        theme: {},
        onError: (error) => {
          throw error;
        },
      }}
    >
      <CollabBridge doc={clientDoc} onReady={(value) => (editor = value)} />
      <CommentsPlugin config={commentsConfig} anchorElem={anchor} />
    </LexicalComposer>
  );
  const view = render(renderClient(config));
  if (!editor) throw new Error('Editor did not initialize.');
  // Hydrate from the server the way a provider's sync step does.
  act(() => {
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(server), 'provider');
  });
  // Commit the hydration update before tests read committed state.
  (editor as LexicalEditor).read(() => {});
  return {
    clientDoc,
    editor: editor as LexicalEditor,
    outgoing,
    pane,
    setCapabilities(next: CommentCapabilities) {
      view.rerender(renderClient({ ...config, getCapabilities: () => next }));
    },
    unmount: view.unmount,
  };
}

/** Every update the client emits from now on, as its provider would send it. */
function recordOutgoing(doc: Y.Doc): Uint8Array[] {
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'provider') updates.push(update);
  });
  return updates;
}

/**
 * What the server's check sees: apply the client's updates to its own copy and
 * report which top-level types changed.
 */
function changedTypes(server: Y.Doc, updates: Uint8Array[]) {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(server));
  const root = copy.get('root', Y.XmlText);
  const comments = copy.getArray('comments');
  const changed = { root: false, comments: false };
  root.observeDeep(() => (changed.root = true));
  comments.observeDeep(() => (changed.comments = true));
  for (const update of updates) Y.applyUpdate(copy, update);
  return { changed, threads: comments.toJSON() as Thread[], copy };
}

/** Select the `occurrence`-th (0-based) appearance of `quote` in the body. */
function selectText(editor: LexicalEditor, quote: string, occurrence = 0): void {
  editor.update(
    () => {
      let seen = 0;
      for (const node of $getRoot().getAllTextNodes()) {
        if (!$isTextNode(node)) continue;
        const text = node.getTextContent();
        let start = text.indexOf(quote);
        while (start !== -1) {
          if (seen === occurrence) {
            node.select(start, start + quote.length);
            return;
          }
          seen += 1;
          start = text.indexOf(quote, start + 1);
        }
      }
      throw new Error(`"${quote}" is not in the document.`);
    },
    { discrete: true },
  );
}

/** Type into the open composer and submit it, as the reviewer would. */
function submitComposer(pane: HTMLElement, text: string): void {
  const input = pane.querySelector<HTMLTextAreaElement>(
    '[data-testid="comment-composer-input"]',
  );
  if (!input) throw new Error('No comment composer is open.');
  fireEvent.change(input, { target: { value: text } });
  const submit = pane.querySelector<HTMLButtonElement>('.nim-comment-btn-submit');
  if (!submit) throw new Error('The composer has no submit button.');
  fireEvent.click(submit);
}

function cancelComposer(pane: HTMLElement): void {
  const cancel = pane.querySelector<HTMLButtonElement>('.nim-comment-btn-cancel');
  if (!cancel) throw new Error('The composer has no cancel button.');
  fireEvent.click(cancel);
}

describe('commenter mode', () => {
  const panes: HTMLElement[] = [];
  const unmounts: Array<() => void> = [];

  afterEach(() => {
    for (const unmount of unmounts.splice(0)) unmount();
    for (const pane of panes.splice(0)) pane.remove();
  });

  it('restores editing after immutable capability configs promote a commenter', () => {
    const server = serverDocWith(['Alpha beta gamma.']);
    const client = mountClient(server, { read: true, comment: true, editBody: false });
    panes.push(client.pane);
    unmounts.push(client.unmount);
    expect(client.editor.isEditable()).toBe(false);

    // Hosts can replace the config while still locked, before promotion.
    client.setCapabilities({ read: true, comment: true, editBody: false });
    client.setCapabilities({ read: true, comment: true });
    expect(client.editor.isEditable()).toBe(true);
    act(() => client.editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('Added.')));
    }, { discrete: true }));
    expect(changedTypes(server, client.outgoing).changed.root).toBe(true);

    client.setCapabilities({ read: true, comment: true, editBody: false });
    expect(client.editor.isEditable()).toBe(false);
  });

  it('anchors an overlapping quote to the occurrence the reviewer selected', () => {
    const server = serverDocWith(['banana']);
    const client = mountClient(server, { read: true, comment: true, editBody: false });
    panes.push(client.pane);
    unmounts.push(client.unmount);
    act(() => {
      selectText(client.editor, 'ana', 1);
      client.editor.dispatchCommand(OPEN_COMMENT_COMPOSER_COMMAND, undefined);
    });
    act(() => submitComposer(client.pane, 'The last three letters.'));
    client.editor.read(() => {});
    const { changed, threads } = changedTypes(server, client.outgoing);
    expect(changed.root).toBe(false);
    const range = resolveQuoteHighlights(client.editor, threads).ranges.get(threads[0].id);
    expect(range?.start.offset).toBe(3);
    expect(range?.end.offset).toBe(6);
  });

  // The server owns a commenter's thread by its first comment, so a thread
  // written empty (or deleted while empty) is refused, terminally.
  it('writes the thread and its first comment in one update, touching only the comments array', () => {
    const server = serverDocWith(['Alpha beta gamma.', 'Delta epsilon.']);
    const client = mountClient(server, {
      read: true,
      comment: true,
      editBody: false,
    });
    panes.push(client.pane);
    unmounts.push(client.unmount);
    expect(client.editor.isEditable()).toBe(false);

    const { outgoing } = client;
    act(() => {
      selectText(client.editor, 'beta');
      client.editor.dispatchCommand(OPEN_COMMENT_COMPOSER_COMMAND, undefined);
    });
    // Commit any update the command queued, so its Yjs write is recorded.
    client.editor.read(() => {});
    expect(outgoing).toHaveLength(0);

    act(() => submitComposer(client.pane, 'Is this right?'));
    client.editor.read(() => {});

    expect(outgoing).toHaveLength(1);
    const { changed, threads } = changedTypes(server, outgoing);
    expect(changed).toEqual({ root: false, comments: true });
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      type: 'thread',
      quote: 'beta',
      anchor: { kind: 'text-quote', exact: 'beta' },
      resolved: false,
      comments: [
        {
          type: 'comment',
          author: 'Reviewer',
          actor: { kind: 'user', userId: 'reviewer-1', displayName: 'Reviewer' },
          content: 'Is this right?',
          deleted: false,
        },
      ],
    });
    expect(collectMarkIds(client.editor).size).toBe(0);
  });

  it('cancelling a new thread writes nothing and drops it from the panel', () => {
    const server = serverDocWith(['Alpha beta gamma.']);
    const client = mountClient(server, {
      read: true,
      comment: true,
      editBody: false,
    });
    panes.push(client.pane);
    unmounts.push(client.unmount);

    act(() => {
      selectText(client.editor, 'beta');
      client.editor.dispatchCommand(OPEN_COMMENT_COMPOSER_COMMAND, undefined);
    });
    expect(client.pane.querySelectorAll('[data-anchor-state]')).toHaveLength(1);
    act(() => cancelComposer(client.pane));
    client.editor.read(() => {});

    expect(client.outgoing).toHaveLength(0);
    expect(client.pane.querySelectorAll('[data-anchor-state]')).toHaveLength(0);
  });

  it('anchors with a MarkNode in root when editBody is absent, as before', () => {
    const server = serverDocWith(['Alpha beta gamma.']);
    const client = mountClient(server, { read: true, comment: true });
    panes.push(client.pane);
    unmounts.push(client.unmount);
    expect(client.editor.isEditable()).toBe(true);

    const { outgoing } = client;
    act(() => {
      selectText(client.editor, 'beta');
      client.editor.dispatchCommand(OPEN_COMMENT_COMPOSER_COMMAND, undefined);
    });
    // Commit any update the command queued, so its Yjs write is recorded.
    client.editor.read(() => {});

    const { changed, threads } = changedTypes(server, outgoing);
    expect(changed).toEqual({ root: true, comments: true });
    expect(collectMarkIds(client.editor).has(threads[0].id)).toBe(true);
  });

  it('adds context when the selected text repeats, so the quote resolves to the selected occurrence', () => {
    const server = serverDocWith(['Alpha beta gamma.', 'Delta beta epsilon.']);
    const client = mountClient(server, {
      read: true,
      comment: true,
      editBody: false,
    });
    panes.push(client.pane);
    unmounts.push(client.unmount);

    const { outgoing } = client;
    act(() => {
      selectText(client.editor, 'beta', 1);
      client.editor.dispatchCommand(OPEN_COMMENT_COMPOSER_COMMAND, undefined);
    });
    act(() => submitComposer(client.pane, 'This one.'));
    client.editor.read(() => {});

    const { changed, threads } = changedTypes(server, outgoing);
    expect(changed.root).toBe(false);
    expect(threads[0].anchor).toMatchObject({ kind: 'text-quote', exact: 'beta' });
    const { ranges } = resolveQuoteHighlights(client.editor, threads);
    const range = ranges.get(threads[0].id);
    expect(range).toBeDefined();
    const startText = client.editor
      .getEditorState()
      .read(() => $getRoot().getAllTextNodes())
      .find((node) => node.getKey() === range!.start.key);
    expect(
      client.editor.getEditorState().read(() => startText!.getTextContent()),
    ).toBe('Delta beta epsilon.');
  });

  it('keeps every other local editor write out of the shared Y.Doc', () => {
    const server = serverDocWith(['Alpha beta gamma.']);
    const client = mountClient(server, {
      read: true,
      comment: true,
      editBody: false,
    });
    panes.push(client.pane);
    unmounts.push(client.unmount);

    const { outgoing } = client;
    act(() => {
      // Stands in for a plugin's mount-time update or a decorator toggling
      // its own state: editability does not stop programmatic updates.
      client.editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Not mine to write')),
          );
        },
        { discrete: true },
      );
    });

    expect(
      client.editor.getEditorState().read(() => $getRoot().getTextContent()),
    ).toContain('Not mine to write');
    expect(changedTypes(server, outgoing).changed.root).toBe(false);
  });

  it('creates agent threads through the controller without a MarkNode', async () => {
    const server = serverDocWith(['Alpha beta gamma.']);
    const client = mountClient(server, {
      read: true,
      comment: true,
      editBody: false,
    });
    panes.push(client.pane);
    unmounts.push(client.unmount);
    const controller = collabCommentControllerRegistry.get(
      'collab://org:test:doc:doc-1',
    );
    if (!controller) throw new Error('Controller did not register.');

    const { outgoing } = client;
    const result = await controller.createAnchored(
      { anchor: { exact: 'gamma' }, body: 'Reword?', clientMutationId: 'm-1' },
      { kind: 'user', userId: 'reviewer-1', displayName: 'Reviewer' },
    );

    expect(changedTypes(server, outgoing).changed.root).toBe(false);
    expect(controller.list().threads).toMatchObject([
      { id: result.threadId, anchorState: 'attached' },
    ]);
  });

  it('lists a thread whose quote is missing or repeated as unanchored', async () => {
    const server = serverDocWith(['Alpha beta gamma.', 'Delta beta epsilon.']);
    const repository = new YDocCommentRepository(server);
    for (const [id, exact] of [
      ['once', 'gamma'],
      ['twice', 'beta'],
      ['gone', 'omega'],
    ]) {
      repository.addThread(
        createThread(
          exact,
          [createComment('Note', 'Reviewer', { id: `c-${id}`, timeStamp: 1 })],
          id,
          false,
          { kind: 'text-quote', exact },
        ),
      );
    }
    repository.destroy();
    const client = mountClient(server, {
      read: true,
      comment: true,
      editBody: false,
    });
    panes.push(client.pane);
    unmounts.push(client.unmount);
    const toggle = client.pane.querySelector<HTMLButtonElement>(
      '.nim-comments-toggle',
    );
    if (!toggle) throw new Error('Comments toggle has not mounted.');
    fireEvent.click(toggle);

    await waitFor(() => {
      const states = Object.fromEntries(
        Array.from(
          client.pane.querySelectorAll<HTMLElement>('[data-anchor-state]'),
        ).map((card) => [
          card.querySelector('.nim-comment-quote')?.textContent?.trim(),
          card.dataset.anchorState,
        ]),
      );
      expect(states).toEqual({
        gamma: 'attached',
        beta: 'orphaned',
        omega: 'orphaned',
      });
    });
  });
});

/** A stored thread whose comments are by the given user ids, in order. */
function seedThread(server: Y.Doc, id: string, exact: string, authors: string[]): void {
  const repository = new YDocCommentRepository(server);
  repository.addThread(
    createThread(
      exact,
      authors.map((userId, index) =>
        createComment(`Note ${index}`, userId, {
          id: `${id}-c${index}`,
          timeStamp: 1 + index,
          actor: { kind: 'user', userId, displayName: userId },
        }),
      ),
      id,
      false,
      { kind: 'text-quote', exact },
    ),
  );
  repository.destroy();
}

function openPanel(pane: HTMLElement): void {
  const toggle = pane.querySelector<HTMLButtonElement>('.nim-comments-toggle');
  if (!toggle) throw new Error('Comments toggle has not mounted.');
  fireEvent.click(toggle);
}

function card(pane: HTMLElement, threadId: string): HTMLElement {
  const element = pane.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`);
  if (!element) throw new Error(`No card for thread ${threadId}.`);
  return element;
}

/** What the card offers: thread actions, and the ids of deletable comments. */
function affordances(pane: HTMLElement, threadId: string) {
  const element = card(pane, threadId);
  return {
    resolve: element.querySelector('.nim-comment-btn-resolve') !== null,
    deleteThread: element.querySelector('.nim-comment-btn-delete-thread') !== null,
    deletableComments: Array.from(element.querySelectorAll<HTMLElement>('.nim-comment'))
      .filter((comment) => comment.querySelector('.nim-comment-delete'))
      .map((comment) => comment.dataset.commentId),
  };
}

// The room accepts a commenter's own thread create, replies anywhere, and
// resolve, reopen or delete of a thread they started; it refuses the rest and
// the refusal ends the session. The panel must not offer what it refuses.
describe('commenter ownership', () => {
  const panes: HTMLElement[] = [];
  const unmounts: Array<() => void> = [];

  afterEach(() => {
    for (const unmount of unmounts.splice(0)) unmount();
    for (const pane of panes.splice(0)) pane.remove();
  });

  function mountWithThreads(capabilities: CommentCapabilities) {
    const server = serverDocWith(['Alpha beta gamma.', 'Delta epsilon zeta.']);
    seedThread(server, 'mine', 'beta', ['reviewer-1', 'other-user']);
    seedThread(server, 'theirs', 'epsilon', ['other-user', 'reviewer-1']);
    seedThread(server, 'solo', 'zeta', ['reviewer-1', 'reviewer-1']);
    const client = mountClient(server, capabilities);
    panes.push(client.pane);
    unmounts.push(client.unmount);
    act(() => openPanel(client.pane));
    return { server, client };
  }

  it('offers thread actions only on threads the commenter started, and delete only on their own comments', () => {
    const { client } = mountWithThreads({ read: true, comment: true, editBody: false });
    expect(affordances(client.pane, 'mine')).toEqual({
      resolve: true,
      deleteThread: false,
      deletableComments: ['mine-c0'],
    });
    expect(affordances(client.pane, 'solo')).toEqual({
      resolve: true,
      deleteThread: true,
      deletableComments: ['solo-c0', 'solo-c1'],
    });
    expect(affordances(client.pane, 'theirs')).toEqual({
      resolve: false,
      deleteThread: false,
      deletableComments: ['theirs-c1'],
    });
    // Replying is allowed on any thread.
    expect(card(client.pane, 'theirs').querySelector('[data-testid="comment-composer-input"]')).not.toBeNull();
  });

  it('offers resolve but not delete on an own thread someone else replied to', () => {
    const { server, client } = mountWithThreads({ read: true, comment: true, editBody: false });
    expect(affordances(client.pane, 'mine')).toMatchObject({ resolve: true, deleteThread: false });

    // Removing the thread would remove the other person's reply, which the
    // room refuses; the plugin must not write it even when asked directly.
    const props = lastPanelProps.current;
    if (!props) throw new Error('The panel never rendered.');
    const mine = props.threads.find((view) => view.thread.id === 'mine')!.thread;
    act(() => props.onDeleteThread(mine));
    client.editor.read(() => {});
    expect(client.outgoing).toHaveLength(0);
    expect(changedTypes(server, client.outgoing).threads.map((t) => t.id)).toEqual(['mine', 'theirs', 'solo']);
  });

  it('leaves an editor every action on every thread', () => {
    const { client } = mountWithThreads({ read: true, comment: true });
    for (const id of ['mine', 'theirs', 'solo']) {
      expect(affordances(client.pane, id)).toEqual({
        resolve: true,
        deleteThread: true,
        deletableComments: [`${id}-c0`, `${id}-c1`],
      });
    }
  });

  it('deletes a thread whose last comment goes in one update', () => {
    const server = serverDocWith(['Alpha beta gamma.']);
    seedThread(server, 'solo', 'beta', ['reviewer-1']);
    const client = mountClient(server, { read: true, comment: true, editBody: false });
    panes.push(client.pane);
    unmounts.push(client.unmount);
    act(() => openPanel(client.pane));

    const remove = card(client.pane, 'solo').querySelector<HTMLButtonElement>('.nim-comment-delete');
    if (!remove) throw new Error('Own comment has no delete button.');
    act(() => fireEvent.click(remove));
    client.editor.read(() => {});

    expect(client.outgoing).toHaveLength(1);
    const { changed, threads } = changedTypes(server, client.outgoing);
    expect(changed.root).toBe(false);
    expect(threads).toEqual([]);
  });
});

describe('marks whose thread was deleted elsewhere', () => {
  const panes: HTMLElement[] = [];
  const unmounts: Array<() => void> = [];

  afterEach(() => {
    for (const unmount of unmounts.splice(0)) unmount();
    for (const pane of panes.splice(0)) pane.remove();
  });

  it('are unwrapped by a client that may edit the body, after the grace period', async () => {
    // The mark is in the body; its thread is gone (deleted by a commenter).
    const server = serverDocWith(['Alpha beta gamma.'], { quote: 'beta', id: 'deleted-thread' });
    const client = mountClient(server, { read: true, comment: true });
    panes.push(client.pane);
    unmounts.push(client.unmount);
    expect(collectMarkIds(client.editor).has('deleted-thread')).toBe(true);

    await waitFor(
      () => expect(collectMarkIds(client.editor).has('deleted-thread')).toBe(false),
      { timeout: ORPHAN_MARK_GRACE_MS + 2000 },
    );
    expect(changedTypes(server, client.outgoing).changed.root).toBe(true);
    expect(
      client.editor.getEditorState().read(() => $getRoot().getTextContent()),
    ).toBe('Alpha beta gamma.');
  });

  it('are left alone by a commenter, who never writes the body', async () => {
    const server = serverDocWith(['Alpha beta gamma.'], { quote: 'beta', id: 'deleted-thread' });
    const client = mountClient(server, { read: true, comment: true, editBody: false });
    panes.push(client.pane);
    unmounts.push(client.unmount);

    await new Promise((resolve) => setTimeout(resolve, ORPHAN_MARK_GRACE_MS + 600));
    expect(collectMarkIds(client.editor).has('deleted-thread')).toBe(true);
    expect(changedTypes(server, client.outgoing).changed.root).toBe(false);
  });
});

describe('resolveQuoteHighlights', () => {
  function editorWith(paragraphs: string[]): LexicalEditor {
    const editor = createHeadlessEditor({
      namespace: 'quote-highlights',
      nodes: [MarkNode],
      onError: (error) => {
        throw error;
      },
    });
    editor.update(
      () => {
        for (const text of paragraphs) {
          $getRoot().append($createParagraphNode().append($createTextNode(text)));
        }
      },
      { discrete: true },
    );
    return editor;
  }

  function quoteThread(id: string, exact: string, prefix?: string): Thread {
    return createThread(exact, [], id, false, {
      kind: 'text-quote',
      exact,
      ...(prefix ? { prefix } : {}),
    });
  }

  it('highlights a quote found once and leaves zero or several matches unanchored', () => {
    const editor = editorWith(['Alpha beta gamma.', 'Delta beta epsilon.']);
    const { ranges, unanchored } = resolveQuoteHighlights(editor, [
      quoteThread('once', 'gamma'),
      quoteThread('zero', 'omega'),
      quoteThread('twice', 'beta'),
      quoteThread('twice-with-context', 'beta', 'Delta '),
    ]);

    expect([...ranges.keys()].sort()).toEqual(['once', 'twice-with-context']);
    expect(ranges.get('once')).toMatchObject({
      quote: 'gamma',
      start: { offset: 11 },
      end: { offset: 16 },
    });
    expect([...unanchored].sort()).toEqual(['twice', 'zero']);
  });

  it('skips threads that already have a MarkNode', () => {
    const editor = editorWith(['Alpha beta gamma.']);
    const { ranges, unanchored } = resolveQuoteHighlights(
      editor,
      [quoteThread('marked', 'omega')],
      new Set(['marked']),
    );
    expect(ranges.size).toBe(0);
    expect(unanchored.size).toBe(0);
  });
});
