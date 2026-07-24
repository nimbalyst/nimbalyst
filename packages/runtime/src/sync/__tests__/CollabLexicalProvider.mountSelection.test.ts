/**
 * Regression for NIM-2005 / NIM-1982: mounting a collaborative body editor threw
 * two paired Lexical errors and took the tracker detail down through the React
 * error boundary.
 *
 *   Expected node with key <N> to exist but it's not in the nodeMap.
 *   updateEditor: selection has been lost because the previously selected nodes
 *   have been removed and selection wasn't moved to another node.
 *
 * Three facts combine:
 *
 * 1. A freshly mounted editor whose committed `_selection` is null seeds its
 *    selection from the DOM caret (`$internalCreateSelection`). A caret sitting
 *    in the editor's own bootstrap paragraph resolves to valid points and
 *    becomes a real RangeSelection on the pending state.
 * 2. `CollabLexicalProvider.connect()` replays the shared doc into the per-mount
 *    editorDoc; `syncYjsChangesToLexical` then replaces the root's children,
 *    deleting the very paragraph that selection points at.
 * 3. `@lexical/yjs`'s own recovery (`$syncCursorFromYjs`) only runs
 *    `$moveSelectionToPreviousNode` when the PRE-UPDATE committed selection is a
 *    RangeSelection. On a fresh mount that is null, so recovery is skipped and
 *    Lexical's end-of-update selection validation throws.
 *
 * These tests use a REAL DOM editor (not `createHeadlessEditor`) because the
 * headless path clones the previous selection instead of reading the DOM, which
 * is exactly the step that seeds the bad selection.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
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
  createEditor,
  type LexicalEditor,
} from 'lexical';
import type { DocumentSyncStatus } from '../documentSyncTypes';
import { CollabLexicalProvider } from '../CollabLexicalProvider';

const bindingProvider = {
  awareness: {
    getLocalState: () => null,
    setLocalState: () => {},
    getStates: () => new Map(),
    on: () => {},
    off: () => {},
  },
} as any;

function createSyncProviderStub(status: DocumentSyncStatus, sharedDoc: Y.Doc) {
  return {
    onAwarenessChange: () => () => {},
    setLocalAwareness: () => {},
    connect: async () => {},
    getYDoc: () => sharedDoc,
    getStatus: () => status,
  } as any;
}

/**
 * A shared Y.Doc holding real Lexical collab content, as a warm replica or a
 * server room does. Written through a real binding so the XmlText carries valid
 * Lexical structure rather than a bare string insert.
 */
function populatedSharedDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  const writer = createHeadlessEditor({
    namespace: 'collab-mount-selection-writer',
    nodes: [],
    onError: (e) => {
      throw e;
    },
  });
  const docMap = new Map<string, Y.Doc>([['main', doc]]);
  const binding = createBinding(writer, bindingProvider, 'main', doc, docMap);
  const removeListener = writer.registerUpdateListener(
    ({ prevEditorState, editorState, dirtyLeaves, dirtyElements, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(
        binding,
        bindingProvider,
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      );
    },
  );
  writer.update(
    () => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(text));
      root.append(paragraph);
    },
    { discrete: true },
  );
  removeListener();
  return doc;
}

/**
 * A second collaborating client on the same shared doc, used to produce genuine
 * remote deletions. Two independent Y.Docs merge rather than replace, so a real
 * "the body was rewritten while the renderer stayed open" needs an actual peer
 * that clears the root and writes new content.
 */
function mountHeadlessClient(provider: CollabLexicalProvider): LexicalEditor {
  provider.prepareForBinding();
  const editorDoc = provider.getYDoc();
  const editor = createHeadlessEditor({
    namespace: 'collab-mount-selection-peer',
    nodes: [],
    onError: (e) => {
      throw e;
    },
  });
  const docMap = new Map<string, Y.Doc>([['main', editorDoc]]);
  const binding = createBinding(editor, bindingProvider, 'main', editorDoc, docMap);
  binding.root.getSharedType().observeDeep((events: any, transaction: any) => {
    if (transaction.origin !== binding) {
      syncYjsChangesToLexical(binding, bindingProvider, events, false, () => {});
    }
  });
  editor.registerUpdateListener(
    ({ prevEditorState, editorState, dirtyLeaves, dirtyElements, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(
        binding,
        bindingProvider,
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      );
    },
  );
  return editor;
}

interface MountedEditor {
  editor: LexicalEditor;
  errors: Error[];
  rootElement: HTMLDivElement;
  attachObserver: () => void;
  detachObserver: () => void;
}

/**
 * Model one editor mount the way `@lexical/react`'s `useYjsCollaboration` does:
 * the host's providerFactory calls prepareForBinding() then getYDoc(), Lexical
 * binds to that doc, attaches observeDeep, and connect() runs afterwards.
 *
 * Unlike the headless harness in CollabLexicalProvider.paint.test.ts this editor
 * has a real root element, so Lexical takes the non-headless update path and
 * derives selection from the DOM.
 */
function mountDomEditor(provider: CollabLexicalProvider): MountedEditor {
  provider.prepareForBinding();
  const editorDoc = provider.getYDoc();

  const errors: Error[] = [];
  const editor = createEditor({
    namespace: 'collab-mount-selection-test',
    nodes: [],
    onError: (e) => {
      errors.push(e as Error);
    },
  });

  const rootElement = document.createElement('div');
  rootElement.contentEditable = 'true';
  document.body.appendChild(rootElement);
  editor.setRootElement(rootElement);

  const docMap = new Map<string, Y.Doc>([['main', editorDoc]]);
  const binding = createBinding(editor, bindingProvider, 'main', editorDoc, docMap);
  const onYjsTreeChanges = (events: any, transaction: any) => {
    if (transaction.origin !== binding) {
      syncYjsChangesToLexical(binding, bindingProvider, events, false, () => {});
    }
  };

  return {
    editor,
    errors,
    rootElement,
    attachObserver: () => binding.root.getSharedType().observeDeep(onYjsTreeChanges),
    detachObserver: () => binding.root.getSharedType().unobserveDeep(onYjsTreeChanges),
  };
}

/** Give the mount a bootstrap paragraph, exactly as CollaborationPlugin does. */
function bootstrapParagraph(editor: LexicalEditor, text: string): void {
  editor.update(
    () => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      if (text) {
        paragraph.append($createTextNode(text));
      }
      root.append(paragraph);
    },
    { discrete: true },
  );
}

/**
 * Put the browser caret inside the editor's rendered content, which is what a
 * focused-but-still-hydrating body looks like. Returns false when the DOM has no
 * text node to place the caret in.
 */
function placeCaretInEditor(mounted: MountedEditor): boolean {
  const walker = document.createTreeWalker(mounted.rootElement, NodeFilter.SHOW_TEXT);
  const textNode = walker.nextNode();
  if (!textNode) return false;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.collapse(true);
  const domSelection = window.getSelection();
  if (!domSelection) return false;
  domSelection.removeAllRanges();
  domSelection.addRange(range);
  return true;
}

/** Every key the selection references must exist in the current node map. */
function selectionKeysResolve(editor: LexicalEditor): boolean {
  let ok = true;
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    const nodeMap = editor.getEditorState()._nodeMap;
    ok = nodeMap.has(selection.anchor.key) && nodeMap.has(selection.focus.key);
  });
  return ok;
}

function readText(editor: LexicalEditor): string {
  let text = '';
  editor.getEditorState().read(() => {
    text = $getRoot().getTextContent();
  });
  return text;
}

describe('CollabLexicalProvider mount-time selection (NIM-2005)', () => {
  it('does not throw when hydration deletes the node the DOM caret was seeded from', async () => {
    const sharedDoc = populatedSharedDoc('remote body');
    const provider = new CollabLexicalProvider(createSyncProviderStub('connected', sharedDoc));

    const mounted = mountDomEditor(provider);
    // CollaborationPlugin bootstraps an empty local doc before hydration.
    bootstrapParagraph(mounted.editor, 'bootstrap');
    // The committed selection must still be null -- that is the precondition
    // that makes Lexical seed selection from the DOM and makes @lexical/yjs skip
    // its recovery. If this ever stops holding the test is no longer a repro.
    expect(mounted.editor.getEditorState()._selection).toBeNull();
    expect(placeCaretInEditor(mounted)).toBe(true);

    mounted.attachObserver();
    await provider.connect();

    expect(mounted.errors.map((e) => e.message)).toEqual([]);
    expect(selectionKeysResolve(mounted.editor)).toBe(true);
    expect(readText(mounted.editor)).toContain('remote body');
  });

  it('does not throw when a remote replacement rewrites an already-populated body', async () => {
    const sharedDoc = populatedSharedDoc('original body');
    const provider = new CollabLexicalProvider(createSyncProviderStub('connected', sharedDoc));

    const mounted = mountDomEditor(provider);
    mounted.attachObserver();
    await provider.connect();
    expect(mounted.errors.map((e) => e.message)).toEqual([]);

    // The caret lands in the hydrated body, then a peer rewrites that body
    // wholesale while this renderer stays open -- the NIM-1982 reproduction
    // (200 outreach descriptions rewritten under a live renderer).
    expect(placeCaretInEditor(mounted)).toBe(true);

    const peerProvider = new CollabLexicalProvider(
      createSyncProviderStub('connected', sharedDoc),
    );
    const peer = mountHeadlessClient(peerProvider);
    await peerProvider.connect();
    expect(readText(peer)).toContain('original body');

    peer.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('replacement body'));
        root.append(paragraph);
      },
      { discrete: true },
    );
    expect(readText(peer)).toContain('replacement body');

    // Only the selection invariant is asserted here. Whether the mount ends up
    // with byte-identical text after a peer rewrite is cross-client replication
    // fidelity (NIM-1647 territory), a separate concern from this crash.
    expect(mounted.errors.map((e) => e.message)).toEqual([]);
    expect(selectionKeysResolve(mounted.editor)).toBe(true);
  });
});
