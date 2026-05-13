/**
 * Intercepts PASTE_COMMAND, detects markdown-looking plain text via
 * `isLikelyMarkdown`, and inserts a parsed editor-state instead of letting
 * the default handler treat it as plain text. HTML-bearing paste payloads
 * fall through to the default handler so rich-text paste continues to
 * work.
 *
 * Headless extension (Phase 7.3). Replaces the prior React-component
 * `MarkdownPastePlugin` mounted in Editor.tsx.
 */

import {
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  $insertNodes,
  $parseSerializedNode,
  defineExtension,
} from 'lexical';
import type { Transformer } from '@lexical/markdown';

import { markdownToJSONSync } from '../../markdown';
import { isLikelyMarkdown } from '../../utils/markdownDetection';

export interface MarkdownPasteConfig {
  transformers: Transformer[];
  minConfidenceScore: number;
}

export const MarkdownPasteExtension = defineExtension({
  name: '@nimbalyst/editor/markdown-paste',
  config: { transformers: [] as Transformer[], minConfidenceScore: 15 },
  register: (editor, config) => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) {
          return false;
        }

        // HTML payload available -- defer to the default handler so rich
        // paste stays working.
        const htmlData = clipboardData.getData('text/html');
        if (htmlData && htmlData.trim().length > 0) {
          return false;
        }

        const plainText = clipboardData.getData('text/plain');
        if (!plainText || plainText.trim().length === 0) {
          return false;
        }

        // Shift+paste = "paste as plain text"; skip transformation.
        if ((event as ClipboardEvent & { shiftKey?: boolean }).shiftKey) {
          return false;
        }

        const isMarkdown = isLikelyMarkdown(plainText, {
          minConfidenceScore: config.minConfidenceScore,
        });
        if (!isMarkdown) {
          return false;
        }

        event.preventDefault();

        try {
          editor.update(() => {
            const importedEditorStateJSON = markdownToJSONSync(
              editor,
              config.transformers,
              plainText,
            );
            const nodes = importedEditorStateJSON.root.children.map($parseSerializedNode);
            $insertNodes(nodes);
          });
          return true;
        } catch (error) {
          console.error('[MarkdownPasteExtension] Failed to transform markdown:', error);
          return false;
        }
      },
      COMMAND_PRIORITY_HIGH,
    );
  },
});
