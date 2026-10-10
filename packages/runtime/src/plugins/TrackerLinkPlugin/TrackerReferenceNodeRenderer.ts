import type { NodeKey } from 'lexical';
import type { ComponentType, RefObject } from 'react';

import { LexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createNodeSelection,
  $getSelection,
  $isNodeSelection,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
} from 'lexical';
import { useContext, useEffect, useMemo, useState } from 'react';
import type { TrackerReferenceView } from './TrackerReferenceNodeCore';

export interface TrackerReferenceNodeRendererProps {
  referenceKey: string;
  nodeKey: NodeKey;
  view: TrackerReferenceView;
  /** Predicate id of the relation this link states; null for a plain link. */
  relation?: string | null;
  /** The link as written (`nimbalyst://KEY` or a console link), for a host that treats some scopes apart. */
  href?: string | null;
}

let trackerReferenceNodeRenderer:
  | ComponentType<TrackerReferenceNodeRendererProps>
  | undefined;

export function setTrackerReferenceNodeRenderer(
  renderer:
    | ComponentType<TrackerReferenceNodeRendererProps>
    | undefined,
): void {
  trackerReferenceNodeRenderer = renderer;
}

export function getTrackerReferenceNodeRenderer():
  | ComponentType<TrackerReferenceNodeRendererProps>
  | undefined {
  return trackerReferenceNodeRenderer;
}

function $isNodeSelected(nodeKey: NodeKey): boolean {
  const selection = $getSelection();
  return $isNodeSelection(selection) && selection.has(nodeKey);
}

/**
 * Returns focus to the enclosing editor with its previous selection, for a
 * control inside a reference that briefly took focus (a menu's text field).
 * Null outside a Lexical editor.
 */
export function useTrackerReferenceEditorFocus(): (() => void) | null {
  const editor = useContext(LexicalComposerContext)?.[0] ?? null;
  return useMemo(() => (editor ? () => editor.focus() : null), [editor]);
}

const INTERACTIVE_SELECTOR = 'a, button, input, textarea, select, [role="link"], [role="button"]';

/**
 * Whether the reference node is node-selected (by arrowing onto it, or by a
 * click inside `elementRef` that is not on a link/button or a text drag), so a
 * renderer can show a selected cue. False outside a Lexical editor, which lets
 * the same renderer serve read-only host surfaces.
 */
export function useTrackerReferenceNodeSelected(
  nodeKey: NodeKey,
  elementRef?: RefObject<HTMLElement | null>,
): boolean {
  const editor = useContext(LexicalComposerContext)?.[0] ?? null;
  const [selected, setSelected] = useState(false);
  useEffect(() => {
    if (!editor) return undefined;
    setSelected(editor.getEditorState().read(() => $isNodeSelected(nodeKey)));
    return editor.registerUpdateListener(({ editorState }) => {
      setSelected(editorState.read(() => $isNodeSelected(nodeKey)));
    });
  }, [editor, nodeKey]);
  useEffect(() => {
    if (!editor || !elementRef) return undefined;
    return editor.registerCommand(
      CLICK_COMMAND,
      (event) => {
        const element = elementRef.current;
        const target = event.target;
        if (!element || !(target instanceof Element) || !element.contains(target)) return false;
        const interactive = target.closest(INTERACTIVE_SELECTOR);
        if (interactive && element.contains(interactive)) return false;
        const domSelection = element.ownerDocument.defaultView?.getSelection();
        if (domSelection && !domSelection.isCollapsed && element.contains(domSelection.anchorNode)) return false;
        editor.update(() => {
          const selection = $createNodeSelection();
          selection.add(nodeKey);
          $setSelection(selection);
        });
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, elementRef, nodeKey]);
  return selected;
}
