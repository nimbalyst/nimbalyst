import type { FocusEvent, JSX, KeyboardEvent, MouseEvent } from 'react';

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { $getNodeByKey, type NodeKey } from 'lexical';
import { useCallback, useEffect, useRef, useState } from 'react';

import { renderMathMarkup } from '../renderMath';
import { $isMathBlockNode, type MathBlockDelimiter } from './MathBlockNode';
import { $isMathInlineNode } from './MathInlineNode';

interface EditableMathNodeProps {
  delimiter?: MathBlockDelimiter;
  displayMode: boolean;
  nodeKey: NodeKey;
  source: string;
}

export function EditableMathNode({
  delimiter = '$',
  displayMode,
  nodeKey,
  source,
}: EditableMathNodeProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const isEditable = useLexicalEditable();
  const [isSelected, setSelected, clearSelection] =
    useLexicalNodeSelection(nodeKey);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(source);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isEditing) {
      setDraft(source);
    }
  }, [isEditing, source]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }
    inputRef.current?.focus();
    if (displayMode) {
      const textarea = inputRef.current as HTMLTextAreaElement | null;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
      }
    } else {
      inputRef.current?.select();
    }
  }, [displayMode, draft, isEditing]);

  const commitDraft = useCallback(
    (nextSource: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isMathInlineNode(node) || $isMathBlockNode(node)) {
          node.setSource(nextSource);
        }
      });
    },
    [editor, nodeKey],
  );

  const finishEditing = useCallback(
    (shouldSave: boolean) => {
      if (shouldSave && draft !== source) {
        commitDraft(draft);
      } else if (!shouldSave) {
        setDraft(source);
      }
      setIsEditing(false);
    },
    [commitDraft, draft, source],
  );

  const handleSelect = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (isEditing) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        setSelected(!isSelected);
      } else {
        clearSelection();
        setSelected(true);
      }
    },
    [clearSelection, isEditing, isSelected, setSelected],
  );

  const handleStartEditing = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (!isEditable) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearSelection();
      setSelected(true);
      setIsEditing(true);
    },
    [clearSelection, isEditable, setSelected],
  );

  const handleEditorBlur = useCallback(
    (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.parentElement?.contains(nextTarget)) {
        return;
      }
      finishEditing(true);
    },
    [finishEditing],
  );

  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finishEditing(false);
        return;
      }

      if (!displayMode && event.key === 'Enter') {
        event.preventDefault();
        finishEditing(true);
        return;
      }

      if (displayMode && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        finishEditing(true);
      }
    },
    [displayMode, finishEditing],
  );

  return (
    <span
      className={[
        displayMode ? 'nim-math-block-shell' : 'nim-math-inline-shell',
        isSelected ? 'nim-math-selected' : '',
        isEditing ? 'nim-math-editing' : '',
      ].join(' ')}
      onClick={handleSelect}
      onDoubleClick={handleStartEditing}
    >
      <span
        className={displayMode ? 'nim-math-block-render' : 'nim-math-inline-render'}
        dangerouslySetInnerHTML={{ __html: renderMathMarkup(isEditing ? draft : source, displayMode) }}
      />
      {isEditing ? (
        <span className={displayMode ? 'nim-math-block-editor' : 'nim-math-inline-editor'}>
          <span className="nim-math-editor-label">LaTeX</span>
          {displayMode ? (
            <>
              <span className="nim-math-editor-delimiter">{delimiter}</span>
              <textarea
                ref={inputRef as React.MutableRefObject<HTMLTextAreaElement | null>}
                className="nim-math-textarea"
                value={draft}
                onBlur={handleEditorBlur}
                onChange={(event) => setDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={handleEditorKeyDown}
                placeholder="Enter LaTeX..."
                rows={Math.max(3, draft.split('\n').length)}
              />
              <span className="nim-math-editor-delimiter">{delimiter}</span>
            </>
          ) : (
            <span className="nim-math-inline-input-row">
              <span className="nim-math-editor-delimiter">$</span>
              <input
                ref={inputRef as React.MutableRefObject<HTMLInputElement | null>}
                className="nim-math-input"
                value={draft}
                onBlur={handleEditorBlur}
                onChange={(event) => setDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={handleEditorKeyDown}
                placeholder="Enter LaTeX..."
              />
              <span className="nim-math-editor-delimiter">$</span>
            </span>
          )}
          <span className="nim-math-editor-actions">
            <button
              type="button"
              className="nim-math-editor-button nim-math-editor-button-secondary"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                finishEditing(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="nim-math-editor-button nim-math-editor-button-primary"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                finishEditing(true);
              }}
            >
              Done
            </button>
          </span>
        </span>
      ) : null}
    </span>
  );
}
