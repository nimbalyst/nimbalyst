import { useCallback } from 'react';
import { $getNodeByKey } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $isEmbeddedFileNode } from './EmbeddedFileNodeCore';

/** Host-independent write-back to the page that owns this placed view. */
export function usePlacedViewAttrs(nodeKey: string, detached = false) {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const change = useCallback((patch: Readonly<Record<string, string | null>>) => {
    if (!editor.isEditable() || detached) throw new Error('This page is read-only');
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isEmbeddedFileNode(node)) throw new Error('This view is no longer on the page');
      node.patchViewAttrs(patch);
    }, { discrete: true });
  }, [editor, nodeKey, detached]);
  return editable && !detached ? change : undefined;
}
