/**
 * Hook to determine if an editor instance should respond to global keyboard events.
 *
 * In a multi-tab environment, multiple editor instances exist simultaneously.
 * This hook helps plugins determine if they belong to the currently active editor
 * by checking:
 *
 * 1. Editor focus: Is the editor or any of its descendants currently focused?
 * 2. Container visibility: Is the editor's parent container marked as active?
 *
 * This ensures keyboard shortcuts only trigger for the active tab, not all tabs.
 *
 * @example
 * ```tsx
 * function MyPlugin() {
 *   const [editor] = useLexicalComposerContext();
 *   const isEditorActive = useIsEditorActive(editor);
 *
 *   useEffect(() => {
 *     const handleKeyDown = (e: KeyboardEvent) => {
 *       if (!isEditorActive) return; // Only respond when active
 *       // ... handle keyboard event
 *     };
 *     document.addEventListener('keydown', handleKeyDown);
 *     return () => document.removeEventListener('keydown', handleKeyDown);
 *   }, [isEditorActive]);
 * }
 * ```
 */

import {useEffect, useState} from 'react';
import type {LexicalEditor} from 'lexical';

export function useIsEditorActive(editor: LexicalEditor): boolean {
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    /**
     * Checks if this editor instance is currently active.
     * Returns true if:
     * - The editor or any descendant has focus, OR
     * - The editor's container is marked as active (data-active="true" or .active class)
     */
    const checkActive = (): boolean => {
      const rootElement = editor.getRootElement();
      if (!rootElement) return false;

      // Check 1: Does the editor or any of its descendants have focus?
      const activeElement = document.activeElement;
      if (activeElement && rootElement.contains(activeElement)) {
        return true;
      }

      // Check 2: Is the editor's parent container marked as active?
      // This handles cases where a dialog/input within the active tab has focus
      // but we still want to respond to keyboard shortcuts.
      let current = rootElement.parentElement;
      while (current) {
        // Check for data-active attribute (set by EditorContainer)
        if (current.getAttribute('data-active') === 'true') {
          return true;
        }

        // Check for 'active' class on multi-editor-instance container
        if (current.classList.contains('multi-editor-instance')) {
          return current.classList.contains('active');
        }

        // Move up the DOM tree
        current = current.parentElement;
      }

      return false;
    };

    /**
     * Update active state when focus changes.
     * Uses focusin/focusout instead of focus/blur because they bubble.
     */
    const handleFocusChange = () => {
      setIsActive(checkActive());
    };

    // Listen for focus changes globally
    document.addEventListener('focusin', handleFocusChange);
    document.addEventListener('focusout', handleFocusChange);

    // Perform initial check
    setIsActive(checkActive());

    return () => {
      document.removeEventListener('focusin', handleFocusChange);
      document.removeEventListener('focusout', handleFocusChange);
    };
  }, [editor]);

  return isActive;
}
