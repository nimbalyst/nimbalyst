import React, { useState } from 'react';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  $setSelection,
  type LexicalEditor,
} from 'lexical';
import { $convertFromEnhancedMarkdownString } from '@nimbalyst/runtime/editor/markdown/EnhancedMarkdownImport';
import { getEditorTransformers } from '@nimbalyst/runtime/editor/markdown';

export function insertSavedDescription(
  editor: LexicalEditor,
  description: string,
): void {
  editor.update(
    () => {
      const selection = $getSelection()?.clone() ?? null;
      const fragment = $createParagraphNode();
      $convertFromEnhancedMarkdownString(
        description,
        getEditorTransformers(),
        fragment,
        true,
        false,
      );
      // Inserting recovered text never replaces a selected range or selected block.
      $setSelection(selection);
      if ($isRangeSelection(selection))
        selection.anchor.set(
          selection.focus.key,
          selection.focus.offset,
          selection.focus.type,
        );
      else $getRoot().selectEnd();
      $insertNodes(fragment.getChildren());
    },
    { discrete: true },
  );
  editor.focus();
}

export function TrackerSavedDescription({
  description,
  currentBody,
  editor,
  canInsert,
}: {
  description: string;
  /**
   * The item's stored body. Agent-created and imported items write the same
   * text to both fields, so offering it back would only duplicate the body.
   */
  currentBody?: string | null;
  editor: LexicalEditor | null;
  canInsert: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const saved = description.trim();
  if (!saved || (typeof currentBody === 'string' && currentBody.trim() === saved)) return null;
  return (
    <details className="tracker-saved-description rounded border border-nim px-3 py-2 text-xs">
      <summary className="cursor-pointer text-nim-muted">
        Saved description
      </summary>
      <p className="mt-2 text-nim-muted">
        This may contain text entered when the item was created. Copy it or
        insert it at your cursor without replacing the current body.
      </p>
      <pre className="select-text my-2 max-h-48 overflow-auto whitespace-pre-wrap font-sans">
        {description}
      </pre>
      <div className="flex gap-3">
        <button
          type="button"
          className="text-nim-link"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(description);
              setError(null);
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          Copy
        </button>
        <button
          type="button"
          className="text-nim-link disabled:opacity-50"
          disabled={!canInsert || !editor}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (canInsert && editor) {
              insertSavedDescription(editor, description);
              setError(null);
            }
          }}
        >
          Insert into body
        </button>
      </div>
      {error && (
        <p role="alert" className="text-nim-error select-text">
          {error}
        </p>
      )}
    </details>
  );
}
