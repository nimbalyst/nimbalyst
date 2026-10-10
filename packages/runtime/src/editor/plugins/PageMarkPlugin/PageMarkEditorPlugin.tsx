/**
 * The small who/when/not-chosen editor for a page mark. Opens after "Mark
 * decided" / "Mark open" in the floating toolbar, or on a click on a mark's
 * chip or its faint line. Read-only editors never open it.
 */

import './PageMark.css';

import type { JSX } from 'react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { mergeRegister } from '@lexical/utils';
import {
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  COMMAND_PRIORITY_LOW,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';

import { $isPageMarkNode } from './PageMarkNode';
import { OPEN_PAGE_MARK_EDITOR_COMMAND } from './pageMarkEvents';
import type { PageMarkAttrs, PageMarkKind } from '../../../core/pageMarkSyntax';

const PageMarkEditorPopover = lazy(() => import('./PageMarkEditorPopover'));
import type { FloatingTextToolbarAction } from '../FloatingTextFormatToolbarPlugin/types';

function markSelection(editor: LexicalEditor, kind: PageMarkKind): void {
  void import('./pageMarkActions').then(({ markSelectionAndOpen }) => markSelectionAndOpen(editor, kind));
}

/** "Mark decided" and "Mark open" for the floating text toolbar. */
export function getPageMarkToolbarActions(editor: LexicalEditor): FloatingTextToolbarAction[] {
  return [
    {
      id: 'mark-decided',
      label: 'Mark decided',
      icon: 'gavel',
      onSelect: () => markSelection(editor, 'decided'),
    },
    {
      id: 'mark-open',
      label: 'Mark open question',
      icon: 'help',
      onSelect: () => markSelection(editor, 'open'),
    },
  ];
}

function readAttrs(editor: LexicalEditor, nodeKey: NodeKey): PageMarkAttrs | null {
  return editor.getEditorState().read(() => {
    const node = $getNodeByKey(nodeKey);
    return $isPageMarkNode(node) ? node.getAttrs() : null;
  });
}

export default function PageMarkEditorPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [openKey, setOpenKey] = useState<NodeKey | null>(null);
  const [initial, setInitial] = useState<PageMarkAttrs | null>(null);
  const [reference, setReference] = useState<HTMLElement | null>(null);

  const open = useCallback((nodeKey: NodeKey) => {
    if (!editor.isEditable()) return;
    const attrs = readAttrs(editor, nodeKey);
    const element = editor.getElementByKey(nodeKey);
    if (!attrs || !element) return;
    setInitial(attrs);
    setReference(element);
    setOpenKey(nodeKey);
  }, [editor]);

  const close = useCallback(() => {
    setOpenKey(null);
    setReference(null);
  }, []);

  useEffect(() => {
    // The chip and the faint line are pseudo-elements of the mark's own span,
    // so a click on either targets that span rather than its text.
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains('page-mark')) return;
      // `editor.read` sets the active editor; `$getNearestNodeFromDOMNode`
      // needs one to map the span back to its node.
      const nodeKey = editor.read(() => {
        const node = $getNearestNodeFromDOMNode(target);
        return $isPageMarkNode(node) ? node.getKey() : null;
      });
      if (nodeKey) open(nodeKey);
    };
    return mergeRegister(
      editor.registerCommand(
        OPEN_PAGE_MARK_EDITOR_COMMAND,
        (nodeKey) => {
          open(nodeKey);
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerRootListener((root, previous) => {
        previous?.removeEventListener('click', onClick);
        root?.addEventListener('click', onClick);
      }),
      () => editor.getRootElement()?.removeEventListener('click', onClick),
    );
  }, [editor, open]);

  // A collaborator (or undo) can remove the mark while its editor is open.
  useEffect(() => {
    if (!openKey) return undefined;
    return editor.registerUpdateListener(() => {
      if (!readAttrs(editor, openKey)) close();
    });
  }, [editor, openKey, close]);

  if (!openKey || !initial || !reference) return null;
  return (
    <Suspense fallback={null}>
      <PageMarkEditorPopover
        key={openKey}
        editor={editor}
        nodeKey={openKey}
        initial={initial}
        reference={reference}
        onClose={close}
      />
    </Suspense>
  );
}
