/**
 * The mark editor popover: kind, who, email, when and what was not chosen.
 * Loaded on first open so the eager editor bundle carries none of it.
 */

import './PageMarkEditor.css';

import type { JSX } from 'react';
import { useState } from 'react';
import type { LexicalEditor, NodeKey } from 'lexical';
import {
  FloatingPortal,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';

import { removePageMark, updatePageMark } from './pageMarkActions';
import type { PageMarkAttrs, PageMarkKind } from '../../../core/pageMarkSyntax';

function PageMarkForm({
  editor,
  nodeKey,
  initial,
  onClose,
}: {
  editor: LexicalEditor;
  nodeKey: NodeKey;
  initial: PageMarkAttrs;
  onClose: () => void;
}): JSX.Element {
  const [kind, setKind] = useState<PageMarkKind>(initial.kind);
  const [by, setBy] = useState(initial.by ?? '');
  const [email, setEmail] = useState(initial.email ?? '');
  const [on, setOn] = useState(initial.on ?? '');
  const [over, setOver] = useState(initial.over ?? '');

  const save = () => {
    updatePageMark(editor, nodeKey, { kind, by, email, on, ...(kind === 'decided' ? { over } : {}) });
    onClose();
  };
  const remove = () => {
    removePageMark(editor, nodeKey);
    onClose();
  };

  return (
    <form
      className="page-mark-editor-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="page-mark-editor-kinds" role="radiogroup" aria-label="Mark">
        {(['decided', 'open'] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={kind === option}
            className={`page-mark-editor-kind page-mark-editor-kind--${option}${kind === option ? ' is-active' : ''}`}
            onClick={() => setKind(option)}
          >
            {option === 'decided' ? 'Decided' : 'Open question'}
          </button>
        ))}
      </div>
      <label className="page-mark-editor-field">
        <span>{kind === 'decided' ? 'Decided by' : 'Owner'}</span>
        <input autoFocus value={by} onChange={(event) => setBy(event.target.value)} placeholder="Name" />
      </label>
      <label className="page-mark-editor-field">
        <span>Email</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
        />
      </label>
      <label className="page-mark-editor-field">
        <span>On</span>
        <input type="date" value={on} onChange={(event) => setOn(event.target.value)} />
      </label>
      {kind === 'decided' ? (
        <label className="page-mark-editor-field">
          <span>Not chosen</span>
          <input value={over} onChange={(event) => setOver(event.target.value)} placeholder="What was set aside" />
        </label>
      ) : null}
      <div className="page-mark-editor-actions">
        <button type="button" className="page-mark-editor-remove" onClick={remove}>
          Remove mark
        </button>
        <button type="submit" className="page-mark-editor-save" data-testid="page-mark-editor-save">
          Done
        </button>
      </div>
    </form>
  );
}

export default function PageMarkEditorPopover({
  editor,
  nodeKey,
  initial,
  reference,
  onClose,
}: {
  editor: LexicalEditor;
  nodeKey: NodeKey;
  initial: PageMarkAttrs;
  reference: HTMLElement;
  onClose: () => void;
}): JSX.Element {
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (next) => {
      if (!next) onClose();
    },
    elements: { reference },
    placement: 'bottom-start',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const { getFloatingProps } = useInteractions([useDismiss(context), useRole(context, { role: 'dialog' })]);
  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className="page-mark-editor"
        data-testid="page-mark-editor"
        {...getFloatingProps()}
      >
        <PageMarkForm editor={editor} nodeKey={nodeKey} initial={initial} onClose={onClose} />
      </div>
    </FloatingPortal>
  );
}
