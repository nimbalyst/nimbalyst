/**
 * Diff plugin module: re-exports the diff command identities and the
 * `useDiffCommands` hook. Runtime registrations (the apply / approve /
 * reject command handlers and the theme-class diff decorator) live in
 * `editor/extensions/builtin/DiffExtension.ts`.
 */

import type { Change } from './core/exports';
import { useCallback } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

import {
  $hasDiffNodes,
  APPLY_DIFF_COMMAND,
  APPROVE_DIFF_COMMAND,
  REJECT_DIFF_COMMAND,
  type TextReplacement,
} from './core/exports';
import { $convertToEnhancedMarkdownString, getEditorTransformers } from '../../markdown';
import { APPLY_MARKDOWN_REPLACE_COMMAND } from './DiffCommands';

export { LiveNodeKeyState } from './core/exports';
export { APPLY_MARKDOWN_REPLACE_COMMAND } from './DiffCommands';

/**
 * Hook to provide diff functionality
 */
export function useDiffCommands() {
  const [editor] = useLexicalComposerContext();

  const applyDiff = useCallback(
    (change: Change) => {
      editor.dispatchCommand(APPLY_DIFF_COMMAND, change);
    },
    [editor],
  );

  const applyMarkdownReplacements = useCallback(
    (replacements: TextReplacement[]) => {
      editor.dispatchCommand(APPLY_MARKDOWN_REPLACE_COMMAND, replacements);
    },
    [editor],
  );

  const approveDiffs = useCallback(() => {
    editor.dispatchCommand(APPROVE_DIFF_COMMAND, undefined);
  }, [editor]);

  const rejectDiffs = useCallback(() => {
    editor.dispatchCommand(REJECT_DIFF_COMMAND, undefined);
  }, [editor]);

  const hasDiffs = useCallback(() => {
    return editor.getEditorState().read(() => $hasDiffNodes(editor));
  }, [editor]);

  const getCurrentMarkdown = useCallback(() => {
    return editor.getEditorState().read(() =>
      $convertToEnhancedMarkdownString(getEditorTransformers()),
    );
  }, [editor]);

  return {
    applyDiff,
    applyMarkdownReplacements,
    approveDiffs,
    rejectDiffs,
    hasDiffs,
    getCurrentMarkdown,
  };
}
