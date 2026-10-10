import { $getRoot, type LexicalEditor } from 'lexical';
import { $isCodeNode } from '@lexical/code';
import { createPlacedViewUrl } from '../../../core/placedViewUrl';
import { $createEmbeddedFileNode, $isEmbeddedFileNode, type EmbeddedFileNode } from './EmbeddedFileNodeCore';
import { NAMED_PAGE_VIEW_ID, namedPageViewFromNode, type NamedPageView } from './namedPageView';

export interface NamedPageViewsSnapshot { views: NamedPageView[]; editable: boolean; error: string | null }
export interface NamedPageViewsController {
  getSnapshot(): NamedPageViewsSnapshot;
  subscribe(listener: () => void): () => void;
  add(id: string, name: string, attrs: Record<string, string>): void;
  rename(id: string, name: string): void;
  patch(id: string, attrs: Readonly<Record<string, string | null>>): void;
  remove(id: string): void;
  dispose(): void;
}

/** All writes target the live editor, never a copied Markdown body or another view store. */
export function createNamedPageViewsController(editor: LexicalEditor, typeId: string): NamedPageViewsController {
  let disposed = false;
  let snapshot: NamedPageViewsSnapshot = { views: [], editable: false, error: null };
  const listeners = new Set<() => void>();
  const nodes = (): EmbeddedFileNode[] => {
    const children = $getRoot().getChildren();
    if (children.some(node => $isCodeNode(node) && node.getLanguage() === 'page-view')) throw new Error('A named view has invalid data. Repair its page-view block before changing views.');
    const views = children.filter($isEmbeddedFileNode).filter(node => node.getAttrs()[NAMED_PAGE_VIEW_ID]);
    const ids = new Set<string>();
    for (const node of views) {
      const view = namedPageViewFromNode(node)!;
      if (view.type !== typeId || ids.has(view.id)) throw new Error('Named views contain a different type or a duplicate ID. Repair the page-view blocks first.');
      ids.add(view.id);
    }
    return views;
  };
  const refresh = () => {
    let next: NamedPageViewsSnapshot;
    try { next = editor.getEditorState().read(() => ({ views: nodes().map(node => namedPageViewFromNode(node)!), editable: !disposed && editor.isEditable(), error: null })); }
    catch (error) { next = { views: [], editable: false, error: error instanceof Error ? error.message : 'Could not read named views.' }; }
    if (JSON.stringify(snapshot) !== JSON.stringify(next)) { snapshot = next; for (const listener of listeners) listener(); }
  };
  const mutate = (change: (current: EmbeddedFileNode[]) => void) => {
    if (disposed || !editor.isEditable()) throw new Error('This page is not editable.');
    let failure: unknown;
    editor.update(() => {
      try {
        if (disposed || !editor.isEditable()) throw new Error('This page is not editable.');
        change(nodes());
      } catch (error) { failure = error; }
    }, { discrete: true });
    if (failure) throw failure;
    refresh();
  };
  const find = (current: EmbeddedFileNode[], id: string) => {
    const node = current.find(node => node.getAttrs()[NAMED_PAGE_VIEW_ID] === id);
    if (!node) throw new Error('This view was removed. Choose another view.');
    return node;
  };
  const validateName = (name: string) => { if (!name.trim()) throw new Error('Give the view a name.'); };
  const unsubscribe = editor.registerUpdateListener(refresh);
  const unsubscribeEditable = editor.registerEditableListener(refresh);
  refresh();
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    add: (id, name, attrs) => mutate(current => {
      validateName(name);
      if (!id || NAMED_PAGE_VIEW_ID in attrs) throw new Error('Invalid view identity.');
      if (current.some(node => node.getAttrs()[NAMED_PAGE_VIEW_ID] === id)) throw new Error('This view already exists.');
      const node = $createEmbeddedFileNode({ src: createPlacedViewUrl({ kind: 'type', typeId, scope: 'local' }), label: name.trim(), attrs: { ...attrs, [NAMED_PAGE_VIEW_ID]: id } });
      const first = $getRoot().getFirstChild();
      if (first) first.insertBefore(node); else $getRoot().append(node);
    }),
    rename: (id, name) => mutate(current => { validateName(name); find(current, id).setLabel(name.trim()); }),
    patch: (id, attrs) => mutate(current => { find(current, id).patchViewAttrs(attrs); }),
    remove: id => mutate(current => { find(current, id).remove(); }),
    dispose: () => { disposed = true; unsubscribe(); unsubscribeEditable(); refresh(); listeners.clear(); },
  };
}
