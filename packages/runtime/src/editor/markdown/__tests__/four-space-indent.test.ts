/**
 * Test for 4-space indent handling
 */

import { describe, it, expect } from 'vitest';
import { createEditor, $getRoot } from 'lexical';
import { ListNode, ListItemNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { $convertToMarkdownString } from '@lexical/markdown';
import {
  detectMarkdownIndentSize,
  normalizeMarkdown
} from '../MarkdownNormalizer';
import { setListConfig } from '../ListTransformers';
import { CORE_TRANSFORMERS } from '../core-transformers';
import { $convertFromEnhancedMarkdownString } from '../EnhancedMarkdownImport';

describe('4-Space Indent Handling', () => {
  let editor: ReturnType<typeof createEditor>;

  beforeEach(() => {
    setListConfig({
      exportIndentSize: 2,      // Use 2-space for export - our standard!
      importMinIndentSize: 2,   // Accept 2-4 spaces on import
    });

    editor = createEditor({
      nodes: [
        HeadingNode,
        QuoteNode,
        ListNode,
        ListItemNode,
        CodeNode,
        LinkNode,
      ],
      onError: console.error,
    });
  });

  it('should detect 4-space indents', () => {
    const markdown = `- List A
    - List B
    - List C
        - List D
    - List Ed
- List F`;

    const detected = detectMarkdownIndentSize(markdown);
    expect(detected).toBe(4);
  });

  it('should normalize 4-space indents to 2-space', () => {
    const markdown = `- List A
    - List B
    - List C
        - List D
    - List Ed
- List F`;

    const expected = `- List A
  - List B
  - List C
    - List D
  - List Ed
- List F`;

    const normalized = normalizeMarkdown(markdown, { targetIndentSize: 2 });
    expect(normalized).toBe(expected);
  });

  it('should correctly import 4-space markdown with automatic normalization', () => {
    const markdown = `- List A
    - List B
    - List C
        - List D
    - List Ed
- List F`;

    let items: Array<{ indent: number; text: string }> = [];

    // Import markdown with automatic normalization
    editor.update(() => {
      const result = $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      const root = $getRoot();
      const list = root.getFirstChild() as ListNode;

      // Recursive function to collect all items with their indents
      function collectItems(node: ListNode | ListItemNode): void {
        if (node.getType() === 'listitem') {
          const listItem = node as ListItemNode;
          // Use the item's own indent value
          const actualIndent = listItem.getIndent();

          // Get the text content (excluding nested lists)
          const children = listItem.getChildren();
          let text = '';
          for (const child of children) {
            if (child.getType() !== 'list') {
              text += child.getTextContent();
            }
          }

          // Only add items with actual text content
          const trimmedText = text.trim();
          if (trimmedText) {
            items.push({
              indent: actualIndent,
              text: trimmedText
            });
          }

          // Process any nested lists
          for (const child of children) {
            if (child.getType() === 'list') {
              collectItems(child as ListNode);
            }
          }
        } else if (node.getType() === 'list') {
          const listNode = node as ListNode;
          for (const child of listNode.getChildren()) {
            collectItems(child as ListItemNode);
          }
        }
      }

      if (list && list.getType() === 'list') {
        collectItems(list);
      }
    });

    // Check the structure is correct
    // With Lexical's nesting model, indented items become nested
    expect(items).toEqual([
      { indent: 0, text: 'List A' },
      { indent: 1, text: 'List B' },
      { indent: 1, text: 'List C' },
      { indent: 2, text: 'List D' },
      { indent: 1, text: 'List Ed' },
      { indent: 0, text: 'List F' },
    ]);

    // Export and verify it maintains structure with 2-space indents
    let exported = '';
    editor.update(() => {
      exported = $convertToMarkdownString(CORE_TRANSFORMERS);
    });


    // Should export with normalized 2-space indents (our standard)
    const expectedExport = `- List A
  - List B
  - List C
    - List D
  - List Ed
- List F`;
    expect(exported).toBe(expectedExport);
  });

  it('should handle deeply nested 4-space indents', () => {
    const markdown = `- Level 0
    - Level 1
        - Level 2
            - Level 3
                - Level 4`;

    const expected = `- Level 0
  - Level 1
    - Level 2
      - Level 3
        - Level 4`;

    const editor = createEditor({
      nodes: [
        HeadingNode,
        QuoteNode,
        ListNode,
        ListItemNode,
        CodeNode,
        LinkNode,
      ],
    });
    let items: Array<{ indent: number; text: string }> = [];

    // Import with automatic normalization and verify structure
    editor.update(() => {
      $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      const root = $getRoot();
      const list = root.getFirstChild() as ListNode;

      // Recursive function to collect all items with their indents
      function collectItems(node: ListNode | ListItemNode): void {
        if (node.getType() === 'listitem') {
          const listItem = node as ListItemNode;
          // Use the item's own indent value
          const actualIndent = listItem.getIndent();

          // Get the text content (excluding nested lists)
          const children = listItem.getChildren();
          let text = '';
          for (const child of children) {
            if (child.getType() !== 'list') {
              text += child.getTextContent();
            }
          }

          // Only add items with actual text content
          const trimmedText = text.trim();
          if (trimmedText) {
            items.push({
              indent: actualIndent,
              text: trimmedText
            });
          }

          // Process any nested lists
          for (const child of children) {
            if (child.getType() === 'list') {
              collectItems(child as ListNode);
            }
          }
        } else if (node.getType() === 'list') {
          const listNode = node as ListNode;
          for (const child of listNode.getChildren()) {
            collectItems(child as ListItemNode);
          }
        }
      }

      if (list && list.getType() === 'list') {
        collectItems(list);
      }
    });

    // Should have proper indent levels after normalization
    expect(items.map(item => item.indent)).toEqual([0, 1, 2, 3, 4]);
    expect(items.map(item => item.text)).toEqual(['Level 0', 'Level 1', 'Level 2', 'Level 3', 'Level 4']);
  });

  it('should handle mixed content with 4-space indents', () => {
    const markdown = `# Title

Some paragraph text.

- First list with 4-space indents
    - Nested item
        - Deeply nested
    - Another nested

Regular paragraph.

1. Ordered list
    2. With 4-space indent
        3. And deeper`;

    const normalized = normalizeMarkdown(markdown, { targetIndentSize: 2 });

    // Should only normalize the lists, not other content
    expect(normalized).toContain('# Title');
    expect(normalized).toContain('Some paragraph text.');
    expect(normalized).toContain('  - Nested item'); // Should be 2 spaces
    expect(normalized).toContain('    - Deeply nested'); // Should be 4 spaces
    expect(normalized).toContain('  2. With 4-space indent'); // Should be 2 spaces
  });
});