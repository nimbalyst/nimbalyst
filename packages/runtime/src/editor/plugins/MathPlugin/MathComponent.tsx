/**
 * MathComponent - React components for rendering math via KaTeX
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey, NodeKey } from 'lexical';
import { $isMathNode } from './MathNode';
import { $isInlineMathNode } from './InlineMathNode';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// ---------------------------------------------------------------------------
// Shared KaTeX render helper
// ---------------------------------------------------------------------------

function renderKatex(
  equation: string,
  displayMode: boolean,
): { html: string; error: string | null } {
  try {
    const html = katex.renderToString(equation, {
      displayMode,
      throwOnError: true,
      strict: false,
      trust: false,
    });
    return { html, error: null };
  } catch (err: any) {
    // Render with throwOnError:false so we still get partial output
    const html = katex.renderToString(equation, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
    });
    const message =
      typeof err === 'string'
        ? err
        : err?.message || 'Failed to render equation';
    return { html, error: message };
  }
}

// ---------------------------------------------------------------------------
// Block math component ($$...$$)
// ---------------------------------------------------------------------------

interface MathBlockComponentProps {
  equation: string;
  nodeKey: NodeKey;
}

export function MathBlockComponent({ equation: initialEquation, nodeKey }: MathBlockComponentProps) {
  const [editor] = useLexicalComposerContext();
  const [isEditing, setIsEditing] = useState(false);
  const [equation, setEquation] = useState(initialEquation);
  const [editedEquation, setEditedEquation] = useState(initialEquation);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasInitializedRef = useRef(false);

  // Sync initial equation on first mount only
  useEffect(() => {
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      setEquation(initialEquation);
      setEditedEquation(initialEquation);
    }
  }, [initialEquation]);

  const rendered = useMemo(() => renderKatex(equation, true), [equation]);

  const saveToNode = useCallback(
    (newEquation: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isMathNode(node)) {
          node.setEquation(newEquation);
        }
      });
    },
    [editor, nodeKey],
  );

  const handleToggleEdit = () => {
    if (isEditing) {
      saveToNode(editedEquation);
    }
    setIsEditing(!isEditing);
  };

  const handleContentChange = (newEquation: string) => {
    setEditedEquation(newEquation);
    setEquation(newEquation);
  };

  // Auto-resize textarea
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, []);

  useEffect(() => {
    if (isEditing) {
      adjustTextareaHeight();
    }
  }, [editedEquation, isEditing, adjustTextareaHeight]);

  return (
    <div className="math-block my-4 border border-[var(--nim-border)] rounded-lg bg-[var(--nim-bg)] overflow-hidden">
      <div className="math-header flex items-center justify-between px-4 py-2 bg-[var(--nim-bg-secondary)] border-b border-[var(--nim-border)]">
        <span className="font-medium text-[var(--nim-text)] text-sm flex items-center gap-2">
          Math
        </span>
        <button
          className={`py-1 px-3 text-xs border rounded cursor-pointer transition-colors ${
            isEditing
              ? 'bg-[var(--nim-primary)] text-white border-[var(--nim-primary)] hover:bg-[var(--nim-primary-hover)]'
              : 'border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
          }`}
          onClick={handleToggleEdit}
        >
          {isEditing ? 'Done' : 'Edit'}
        </button>
      </div>

      {isEditing && (
        <div className="p-4 pb-0">
          <textarea
            ref={textareaRef}
            className="w-full min-h-[60px] p-3 border border-[var(--nim-border)] rounded font-mono text-sm resize-none overflow-hidden bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] leading-relaxed focus:outline-none focus:border-[var(--nim-border-focus)] focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--nim-primary)_10%,transparent)]"
            value={editedEquation}
            onChange={(e) => {
              handleContentChange(e.target.value);
              adjustTextareaHeight();
            }}
            onBlur={() => saveToNode(editedEquation)}
            placeholder="Enter LaTeX equation..."
            autoFocus
          />
        </div>
      )}

      <div className="math-render p-6 flex justify-center overflow-x-auto">
        {rendered.error ? (
          <div className="w-full">
            <div
              className="math-katex-output"
              dangerouslySetInnerHTML={{ __html: rendered.html }}
            />
            <div className="mt-2 text-xs text-[var(--nim-error)] font-mono">{rendered.error}</div>
          </div>
        ) : (
          <div
            className="math-katex-output"
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline math component ($...$)
// ---------------------------------------------------------------------------

interface MathInlineComponentProps {
  equation: string;
  nodeKey: NodeKey;
}

export function MathInlineComponent({ equation: initialEquation, nodeKey }: MathInlineComponentProps) {
  const [editor] = useLexicalComposerContext();
  const [isEditing, setIsEditing] = useState(false);
  const [equation, setEquation] = useState(initialEquation);
  const [editedEquation, setEditedEquation] = useState(initialEquation);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasInitializedRef = useRef(false);

  useEffect(() => {
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      setEquation(initialEquation);
      setEditedEquation(initialEquation);
    }
  }, [initialEquation]);

  const rendered = useMemo(() => renderKatex(equation, false), [equation]);

  const saveToNode = useCallback(
    (newEquation: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isInlineMathNode(node)) {
          node.setEquation(newEquation);
        }
      });
    },
    [editor, nodeKey],
  );

  const commitEdit = useCallback(() => {
    saveToNode(editedEquation);
    setIsEditing(false);
  }, [editedEquation, saveToNode]);

  const handleDoubleClick = () => {
    setIsEditing(true);
    // Focus the input after state updates
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      commitEdit();
    }
  };

  if (isEditing) {
    return (
      <span className="math-inline-edit inline-flex items-center gap-1">
        <input
          ref={inputRef}
          className="px-1.5 py-0.5 border border-[var(--nim-border-focus)] rounded text-sm font-mono bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] focus:outline-none min-w-[60px]"
          value={editedEquation}
          onChange={(e) => {
            setEditedEquation(e.target.value);
            setEquation(e.target.value);
          }}
          onBlur={commitEdit}
          onKeyDown={handleKeyDown}
          autoFocus
        />
      </span>
    );
  }

  return (
    <span
      className="math-inline-render cursor-pointer hover:bg-[var(--nim-bg-hover)] rounded px-0.5 transition-colors"
      onDoubleClick={handleDoubleClick}
      title="Double-click to edit"
    >
      {rendered.error ? (
        <span className="text-[var(--nim-error)] font-mono text-xs" title={rendered.error}>
          <span dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </span>
      ) : (
        <span dangerouslySetInnerHTML={{ __html: rendered.html }} />
      )}
    </span>
  );
}
