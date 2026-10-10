/**
 * One list of a document's citations per editor, in document order, shared by
 * every chip (for a source's number) and the Sources line. Recomputed only
 * when a citation node is created, destroyed or moved.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { $getRoot, $isElementNode, type LexicalEditor, type LexicalNode, type NodeKey } from 'lexical';

import { $isCitationNode, CitationNode } from './CitationNodeCore';
import type { Citation } from '../../../core/citationSyntax';

export interface CitationIndex {
  citations: Citation[];
  /** 1-based number of each source citation, in document order. */
  sourceNumbers: ReadonlyMap<NodeKey, number>;
}

const EMPTY: CitationIndex = { citations: [], sourceNumbers: new Map() };

interface Store {
  index: CitationIndex;
  listeners: Set<() => void>;
  unregister: (() => void) | null;
}

const stores = new WeakMap<LexicalEditor, Store>();

export function $collectCitationNodes(): CitationNode[] {
  const out: CitationNode[] = [];
  const visit = (node: LexicalNode) => {
    if ($isCitationNode(node)) out.push(node);
    else if ($isElementNode(node)) node.getChildren().forEach(visit);
  };
  visit($getRoot());
  return out;
}

function compute(editor: LexicalEditor): CitationIndex {
  return editor.getEditorState().read(() => {
    const nodes = $collectCitationNodes();
    if (nodes.length === 0) return EMPTY;
    const sourceNumbers = new Map<NodeKey, number>();
    for (const node of nodes) {
      if (node.getCitation().kind === 'source') sourceNumbers.set(node.getKey(), sourceNumbers.size + 1);
    }
    return { citations: nodes.map((node) => node.getCitation()), sourceNumbers };
  });
}

function sameIndex(a: CitationIndex, b: CitationIndex): boolean {
  if (a.citations.length !== b.citations.length || a.sourceNumbers.size !== b.sourceNumbers.size) return false;
  if (a.citations.some((citation, i) => citation !== b.citations[i])) return false;
  for (const [key, number] of a.sourceNumbers) if (b.sourceNumbers.get(key) !== number) return false;
  return true;
}

function storeFor(editor: LexicalEditor): Store {
  let store = stores.get(editor);
  if (!store) {
    store = { index: EMPTY, listeners: new Set(), unregister: null };
    stores.set(editor, store);
  }
  return store;
}

function subscribe(editor: LexicalEditor, listener: () => void): () => void {
  const store = storeFor(editor);
  store.listeners.add(listener);
  if (!store.unregister) {
    store.index = compute(editor);
    const refresh = () => {
      const next = compute(editor);
      if (sameIndex(store!.index, next)) return;
      store!.index = next;
      store!.listeners.forEach((notify) => notify());
    };
    const unregisterMutations = editor.registerMutationListener(CitationNode, refresh, { skipInitialization: false });
    // Moving a block reorders its citations without mutating them.
    const unregisterUpdates = editor.registerUpdateListener(({ dirtyElements }) => {
      if (store!.index.citations.length > 1 && dirtyElements.has('root')) refresh();
    });
    store.unregister = () => {
      unregisterMutations();
      unregisterUpdates();
    };
  }
  return () => {
    store!.listeners.delete(listener);
    if (store!.listeners.size === 0 && store!.unregister) {
      store!.unregister();
      store!.unregister = null;
    }
  };
}

export function useCitationIndex(editor: LexicalEditor | null): CitationIndex {
  // Re-subscribing the last listener recomputes the snapshot. Keep this stable
  // so that snapshot-driven renders cannot start a subscribe/render loop.
  const subscribeToEditor = useCallback(
    (listener: () => void) => (editor ? subscribe(editor, listener) : () => {}),
    [editor],
  );
  return useSyncExternalStore(
    subscribeToEditor,
    () => (editor ? storeFor(editor).index : EMPTY),
  );
}
