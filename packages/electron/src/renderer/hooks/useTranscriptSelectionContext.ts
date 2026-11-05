import { useEffect, type RefObject } from 'react';
import {
  setTextSelection,
  clearTextSelection,
  transcriptSelectionKey,
} from '../components/UnifiedAI/TextSelectionIndicator';

const SELECTION_DEBOUNCE_MS = 150;

function elementOf(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

/**
 * Publishes text the user selects in a session's chat transcript into the AI
 * selection-context store, so it reaches the agent the same way a document
 * selection does (the "Selection" chip above the input).
 *
 * Semantics mirror useLexicalSelectionContext: selections outside the
 * transcript are ignored (so clicking into the input does not clear the chip),
 * a collapsed click inside the transcript clears it, and unmount clears it.
 * Message rows carry `data-message-role`, which records whose message the text
 * came from.
 */
export function useTranscriptSelectionContext(
  containerRef: RefObject<HTMLElement | null>,
  sessionId: string,
): void {
  useEffect(() => {
    const key = transcriptSelectionKey(sessionId);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const publish = () => {
      const container = containerRef.current;
      const selection = document.getSelection();
      const anchor = elementOf(selection?.anchorNode ?? null);
      if (!container || !selection || !anchor || !container.contains(anchor)) return;
      // Text fields inside the transcript (e.g. search) have their own selection.
      if (anchor.closest('input, textarea, [contenteditable="true"]')) return;

      const text = selection.toString();
      if (selection.isCollapsed || !text.trim() || !container.contains(selection.focusNode)) {
        clearTextSelection(key);
        return;
      }
      const role = anchor.closest('[data-message-role]')?.getAttribute('data-message-role');
      setTextSelection(text, key, role === 'user' ? 'user' : 'assistant');
    };

    const onSelectionChange = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(publish, SELECTION_DEBOUNCE_MS);
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      document.removeEventListener('selectionchange', onSelectionChange);
      clearTextSelection(key);
    };
  }, [containerRef, sessionId]);
}
