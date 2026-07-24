/**
 * Wires Cmd+Shift+C / Ctrl+Shift+C to copy the current selection as
 * markdown into the system clipboard. When everything is selected, the
 * frontmatter is prepended so a "select all + copy" round-trips through
 * the markdown export.
 *
 * Headless extension (Phase 7.3). Replaces the prior React-component
 * `MarkdownCopyPlugin` mounted in Editor.tsx. The
 * `COPY_AS_MARKDOWN_COMMAND` is dispatchable from anywhere with the
 * editor reference and stays exported under the same name for
 * `useIPCHandlers` consumers.
 */

import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  KEY_MODIFIER_COMMAND,
  LexicalCommand,
  LexicalNode,
  createCommand,
  defineExtension,
} from 'lexical';
import { mergeRegister } from '@lexical/utils';
import type { Transformer } from '@lexical/markdown';

import { copyToClipboard } from '../../../utils/clipboard';
import { $convertSelectionToEnhancedMarkdownString } from '../../markdown/EnhancedMarkdownExport';
import { $getFrontmatter, serializeWithFrontmatter } from '../../markdown/FrontmatterUtils';

export const COPY_AS_MARKDOWN_COMMAND: LexicalCommand<KeyboardEvent> = createCommand(
  'COPY_AS_MARKDOWN_COMMAND',
);

export interface MarkdownCopyConfig {
  transformers: Transformer[];
}

export const MarkdownCopyExtension = defineExtension({
  name: '@nimbalyst/editor/markdown-copy',
  config: { transformers: [] as Transformer[] },
  register: (editor, config) => {
    return mergeRegister(
      editor.registerCommand(
        KEY_MODIFIER_COMMAND,
        (event: KeyboardEvent) => {
          const { code, ctrlKey, metaKey, shiftKey } = event;
          if (code === 'KeyC' && shiftKey && (metaKey || ctrlKey)) {
            event.preventDefault();
            editor.dispatchCommand(COPY_AS_MARKDOWN_COMMAND, event);
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerCommand(
        COPY_AS_MARKDOWN_COMMAND,
        () => {
          try {
            let markdown = '';

            editor.getEditorState().read(() => {
              const selection = $getSelection();
              if (!selection) return;

              const nodes = selection.getNodes();
              if (nodes.length === 0) return;

              markdown = $convertSelectionToEnhancedMarkdownString(
                config.transformers,
                selection,
                true,
              );

              // Include frontmatter when the entire document is selected,
              // so "select all + Cmd+Shift+C" round-trips through markdown
              // export.
              if ($isRangeSelection(selection)) {
                const root = $getRoot();
                const selectedRootNodes = new Set<string>();
                for (const node of nodes) {
                  let topNode: LexicalNode = node;
                  while (topNode.getParent() !== null && topNode.getParent() !== root) {
                    topNode = topNode.getParent()!;
                  }
                  if (topNode.getParent() === root) {
                    selectedRootNodes.add(topNode.getKey());
                  }
                }
                const rootChildren = root.getChildren();
                const allRootChildrenSelected =
                  rootChildren.length > 0 &&
                  rootChildren.every((child) => selectedRootNodes.has(child.getKey()));
                if (allRootChildrenSelected) {
                  const frontmatter = $getFrontmatter();
                  if (frontmatter) {
                    markdown = serializeWithFrontmatter(markdown, frontmatter);
                  }
                }
              }
            });

            if (markdown) {
              copyToClipboard(markdown).catch((error) => {
                console.error('[MarkdownCopyExtension] Failed to write to clipboard:', error);
              });
              return true;
            }
            return false;
          } catch (error) {
            console.error('[MarkdownCopyExtension] Error:', error);
            return false;
          }
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
  },
});
