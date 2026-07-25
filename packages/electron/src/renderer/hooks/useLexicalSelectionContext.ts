import { useEffect } from 'react';
import { $getSelection, $isRangeSelection, type LexicalEditor } from 'lexical';
import { setTextSelection, clearTextSelection } from '../components/UnifiedAI/TextSelectionIndicator';

const SELECTION_DEBOUNCE_MS = 150;

interface UseLexicalSelectionContextOptions {
  /** The live Lexical editor whose selection should feed the AI context. */
  editor: LexicalEditor | null | undefined;
  /** File / document path recorded alongside the selection. */
  filePath: string;
  /** Whether the owning tab is currently active. */
  isActive: boolean;
  /**
   * Whether selection tracking should run at all. Callers gate this on
   * "markdown in rich-text (Lexical) mode" so Monaco / source-mode tabs opt out.
   */
  enabled: boolean;
}

/**
 * Publishes the active Lexical text selection into the AI selection-context
 * store (the "+ selection" reference pill above the agent input).
 *
 * Shared by TabEditor (local markdown) and CollaborativeTabEditor (shared
 * markdown) so both editing surfaces feed the agent identically. Previously the
 * collaborative mount had no selection wiring at all, so selecting text in a
 * shared doc never reached the agent.
 *
 * Semantics mirror the local editor: only update while the editor has focus (so
 * clicking into the AI chat does not clear the pill), debounce updates to limit
 * churn, and clear on tab deactivation / unmount.
 */
export function useLexicalSelectionContext({
  editor,
  filePath,
  isActive,
  enabled,
}: UseLexicalSelectionContextOptions): void {
  useEffect(() => {
    if (!enabled) return undefined;

    // Clear selection when the tab is inactive (switching to another file).
    if (!isActive) {
      clearTextSelection(filePath);
      return undefined;
    }

    if (!editor?.registerUpdateListener) return undefined;

    // On activation clear any stale selection state. The Lexical
    // SelectionAlwaysOnDisplay plugin may render a visual selection, but we
    // want a clean slate -- the user must re-select to use "+ selection".
    clearTextSelection(filePath);

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const unregister = editor.registerUpdateListener(() => {
      // Only update selection while the editor has focus; this prevents
      // clearing the pill when the user clicks into the AI chat.
      const editorElement = editor.getRootElement();
      const hasFocus =
        editorElement?.contains(document.activeElement) ||
        document.activeElement === editorElement;
      if (!hasFocus) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection) && !selection.isCollapsed()) {
            const selectedText = selection.getTextContent();
            if (selectedText && selectedText.trim().length > 0) {
              setTextSelection(selectedText, filePath);
            } else {
              clearTextSelection(filePath);
            }
          } else {
            // Caret placed without a range selection -- clear it.
            clearTextSelection(filePath);
          }
        });
      }, SELECTION_DEBOUNCE_MS);
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unregister();
      clearTextSelection(filePath);
    };
  }, [editor, filePath, isActive, enabled]);
}
