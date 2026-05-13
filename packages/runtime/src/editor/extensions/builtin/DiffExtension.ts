/**
 * Headless extension owning the diff-system commands
 * (`APPLY_DIFF_COMMAND`, `APPLY_MARKDOWN_REPLACE_COMMAND`,
 * `APPROVE_DIFF_COMMAND`, `REJECT_DIFF_COMMAND`) and the DOM-class
 * decorator that paints added/removed/modified nodes from theme classes.
 *
 * Replaces the React `DiffPlugin` (which returned null). The
 * `useDiffCommands` hook continues to live in the original plugin module
 * for callers that prefer a hook API.
 */

import type { Change } from '../../plugins/DiffPlugin/core/exports';
import type { LexicalNode } from 'lexical';
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  defineExtension,
} from 'lexical';
import { $isTableRowNode } from '@lexical/table';

import {
  $approveDiffs,
  $getDiffState,
  $hasDiffNodes,
  $rejectDiffs,
  $setDiffState,
  APPLY_DIFF_COMMAND,
  APPROVE_DIFF_COMMAND,
  CLEAR_DIFF_TAG_COMMAND,
  REJECT_DIFF_COMMAND,
  applyMarkdownReplace,
  type TextReplacement,
  type TextReplacementInput,
} from '../../plugins/DiffPlugin/core/exports';
import { APPLY_MARKDOWN_REPLACE_COMMAND } from '../../plugins/DiffPlugin/DiffCommands';
import { diffTrace } from '../../../utils/debugFlags';
import { $convertToEnhancedMarkdownString } from '../../markdown';
import { getAllExtensionTransformers } from '../extensionContributionsStore';
import { CORE_TRANSFORMERS } from '../../markdown/core-transformers';

type ApplyMarkdownReplacePayload =
  | TextReplacementInput[]
  | { replacements: TextReplacementInput[]; requestId?: string };

const NAME = '@nimbalyst/editor/diff';

export const DiffExtension = defineExtension({
  name: NAME,
  register: (editor) => {
    const updateDiffStyling = () => {
      editor.getEditorState().read(() => {
        const root = $getRoot();
        const theme = editor._config.theme;
        const diffAddClass = theme?.diffAdd;
        const diffRemoveClass = theme?.diffRemove;
        const diffModifyClass = theme?.diffModify;
        if (!diffAddClass && !diffRemoveClass && !diffModifyClass) return;

        const traverseNodes = (node: LexicalNode) => {
          if (!$isTableRowNode(node)) {
            const diffState = $getDiffState(node);
            const element = editor.getElementByKey(node.getKey());
            if (element) {
              if (diffAddClass && element.classList.contains(diffAddClass))
                element.classList.remove(diffAddClass);
              if (diffRemoveClass && element.classList.contains(diffRemoveClass))
                element.classList.remove(diffRemoveClass);
              if (diffModifyClass && element.classList.contains(diffModifyClass))
                element.classList.remove(diffModifyClass);
              if (diffState === 'added' && diffAddClass) element.classList.add(diffAddClass);
              else if (diffState === 'removed' && diffRemoveClass) element.classList.add(diffRemoveClass);
              else if (diffState === 'modified' && diffModifyClass) element.classList.add(diffModifyClass);
            }
          }
          if ($isElementNode(node)) {
            for (const child of node.getChildren()) traverseNodes(child);
          }
        };
        for (const child of root.getChildren()) traverseNodes(child);
      });
    };

    const commandInProgress = { current: false };
    const removeUpdateListener = editor.registerUpdateListener(() => updateDiffStyling());
    updateDiffStyling();

    const applyDiffUnregister = editor.registerCommand<Change>(
      APPLY_DIFF_COMMAND,
      (payload) => {
        const { type, oldText, newText } = payload;
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          if (type === 'remove' && oldText) {
            const removeNode = $createTextNode(oldText);
            $setDiffState(removeNode, 'removed');
            selection.insertNodes([removeNode]);
          }
          if ((type === 'add' || type === 'change') && newText) {
            const addNode = $createTextNode(newText);
            $setDiffState(addNode, 'added');
            selection.insertNodes([addNode]);
          }
        });
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );

    const applyMarkdownReplaceUnregister = editor.registerCommand<ApplyMarkdownReplacePayload>(
      APPLY_MARKDOWN_REPLACE_COMMAND,
      (payload) => {
        const replacements = Array.isArray(payload) ? payload : payload?.replacements;
        const requestId = Array.isArray(payload) ? undefined : payload?.requestId;
        if (!replacements || replacements.length === 0) return false;

        try {
          const transformers = [
            ...getAllExtensionTransformers(),
            ...CORE_TRANSFORMERS,
          ];
          const originalMarkdown = editor.getEditorState().read(() =>
            $convertToEnhancedMarkdownString(transformers),
          );
          const normalizedReplacements: TextReplacement[] = replacements.map((r) => {
            if (!r.oldText) return { ...r, oldText: originalMarkdown };
            return r as TextReplacement;
          });
          try {
            const firstNew = normalizedReplacements[0]?.newText ?? '';
            const firstOld = normalizedReplacements[0]?.oldText ?? '';
            diffTrace('DiffExtension APPLY_MARKDOWN_REPLACE_COMMAND', {
              originalLen: originalMarkdown.length,
              originalHead: originalMarkdown.slice(0, 80),
              firstOldLen: firstOld.length,
              firstNewLen: firstNew.length,
              firstNewHead: firstNew.slice(0, 80),
              originalEqualsNewText: originalMarkdown === firstNew,
              originalEqualsOldText: originalMarkdown === firstOld,
              replacementCount: normalizedReplacements.length,
              t: typeof performance !== 'undefined' ? performance.now() : Date.now(),
            });
          } catch {
            /* logging only */
          }

          try {
            applyMarkdownReplace(editor, originalMarkdown, normalizedReplacements, transformers);
            if (typeof window !== 'undefined') {
              setTimeout(() => {
                window.dispatchEvent(
                  new CustomEvent('diffApplyComplete', {
                    detail: { success: true, requestId },
                  }),
                );
              }, 0);
            }
          } catch (error: unknown) {
            let errorMessage = 'Failed to apply changes';
            const err = error as {
              context?: { errorType?: string; additionalInfo?: { replacement?: unknown } };
              message?: string;
            };
            if (err?.context?.errorType === 'TEXT_REPLACEMENT_ERROR') {
              if (err.context?.additionalInfo?.replacement) {
                errorMessage =
                  'Could not find matching text in the document. The text may have been modified or contains different whitespace/formatting.';
              }
            } else if (err?.message) {
              errorMessage = err.message;
            }
            if (typeof window !== 'undefined') {
              setTimeout(() => {
                window.dispatchEvent(
                  new CustomEvent('diffApplyComplete', {
                    detail: { success: false, error: errorMessage, requestId },
                  }),
                );
              }, 0);
            }
          }
          return true;
        } catch (error: unknown) {
          const message = (error as { message?: string })?.message ?? 'Unknown error';
          console.error('[DiffExtension] Setup error before applyMarkdownReplace:', error);
          if (typeof window !== 'undefined') {
            setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent('diffApplyComplete', {
                  detail: { success: false, error: message, requestId },
                }),
              );
            }, 0);
          }
          return true;
        }
      },
      COMMAND_PRIORITY_EDITOR,
    );

    const approveDiffUnregister = editor.registerCommand(
      APPROVE_DIFF_COMMAND,
      () => {
        commandInProgress.current = true;
        $approveDiffs();
        setTimeout(() => updateDiffStyling(), 0);
        setTimeout(() => {
          const hasDiff = $hasDiffNodes(editor);
          if (!hasDiff) {
            editor.dispatchCommand(CLEAR_DIFF_TAG_COMMAND, undefined);
          }
          commandInProgress.current = false;
        }, 100);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );

    const rejectDiffUnregister = editor.registerCommand(
      REJECT_DIFF_COMMAND,
      () => {
        commandInProgress.current = true;
        $rejectDiffs();
        setTimeout(() => updateDiffStyling(), 0);
        setTimeout(() => {
          const hasDiff = $hasDiffNodes(editor);
          if (!hasDiff) {
            editor.dispatchCommand(CLEAR_DIFF_TAG_COMMAND, undefined);
          }
          commandInProgress.current = false;
        }, 100);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );

    return () => {
      removeUpdateListener();
      applyDiffUnregister();
      applyMarkdownReplaceUnregister();
      approveDiffUnregister();
      rejectDiffUnregister();
    };
  },
});
