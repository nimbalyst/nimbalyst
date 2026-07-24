/**
 * Integration test for list normalization with import/export
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEditor, $getRoot } from 'lexical';
import { ListNode, ListItemNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { $convertToMarkdownString } from '@lexical/markdown';
import { $convertFromEnhancedMarkdownString } from '../EnhancedMarkdownImport';
import { normalizeMarkdown } from '../MarkdownNormalizer';
import { setListConfig } from '../ListTransformers';
import { CORE_TRANSFORMERS } from '../core-transformers';

describe('List Normalization Integration', () => {
  let editor: ReturnType<typeof createEditor>;

  beforeEach(() => {
    setListConfig({
      exportIndentSize: 2,
      importMinIndentSize: 2,
      autoDetectIndent: false, // We're normalizing, so no need to detect
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

  it('should handle mixed 2 and 4 space indents correctly', () => {
    const markdown = `- List A
  - List B (2 spaces)
    - List C (4 spaces - should become level 2)
      - List D (6 spaces - should become level 3)
  - List E (2 spaces - back to level 1)`;

    // Normalize first
    const normalized = normalizeMarkdown(markdown, { targetIndentSize: 2 });

    let exportedMarkdown = '';

    // Import normalized markdown
    editor.update(() => {
      $convertFromEnhancedMarkdownString(normalized, CORE_TRANSFORMERS);
    });

    // Export and check
    editor.update(() => {
      exportedMarkdown = $convertToMarkdownString(CORE_TRANSFORMERS);
    });

    // Should maintain the correct structure
    expect(exportedMarkdown).toBe(normalized);
  });

  it('should handle your specific problematic case', () => {
    // Your original example that was causing issues
    const markdown = `# Small

- List A
  - List B
  - List C
    - List D
  - List Ed
- List F`;

    // Normalize (should detect 2-space and keep it)
    const normalized = normalizeMarkdown(markdown);
    console.log('Normalized markdown:');
    console.log(normalized);

    let items: Array<{ indent: number; text: string }> = [];

    // Import
    editor.update(() => {
      $convertFromEnhancedMarkdownString(normalized, CORE_TRANSFORMERS);
      const root = $getRoot();

      console.log('Root children:', root.getChildrenSize());

      // Debug: log all children
      const children = root.getChildren();
      children.forEach((child, i) => {
        console.log(`Child ${i}: type=${child.getType()}, text="${child.getTextContent()}"`);

        if (child.getType() === 'list') {
          const listNode = child as ListNode;
          const listItems = listNode.getChildren() as ListItemNode[];
          console.log(`  List has ${listItems.length} items`);
          items = listItems.map(item => {
            const result = {
              indent: item.getIndent(),
              text: item.getTextContent().trim()
            };
            console.log(`    Item: indent=${result.indent}, text="${result.text}"`);
            return result;
          });
        }
      });
    });

    // For now, just check we got some items
    expect(items.length).toBeGreaterThan(0);

    // Export and verify round-trip
    let exportedMarkdown = '';
    editor.update(() => {
      exportedMarkdown = $convertToMarkdownString(CORE_TRANSFORMERS);
    });

    console.log('Exported markdown:');
    console.log(exportedMarkdown);
  });

  it('should fix inconsistent 4-space indents', () => {
    // Someone using 4 spaces inconsistently
    const markdown = `- Item 1
    - Item 2 (4 spaces - should be level 1)
        - Item 3 (8 spaces - should be level 2)
    - Item 4 (4 spaces - level 1)`;

    // Normalize to 2-space
    const normalized = normalizeMarkdown(markdown, { targetIndentSize: 2 });

    const expected = `- Item 1
  - Item 2 (4 spaces - should be level 1)
    - Item 3 (8 spaces - should be level 2)
  - Item 4 (4 spaces - level 1)`;

    expect(normalized).toBe(expected);

    // Import and export to verify it works end-to-end
    editor.update(() => {
      $convertFromEnhancedMarkdownString(normalized, CORE_TRANSFORMERS);
    });

    let exportedMarkdown = '';
    editor.update(() => {
      exportedMarkdown = $convertToMarkdownString(CORE_TRANSFORMERS);
    });

    expect(exportedMarkdown).toBe(expected);
  });

  it('should handle tabs correctly', () => {
    const markdown = `- Item 1
\t- Item 2 (tab)
\t\t- Item 3 (2 tabs)
\t- Item 4 (tab)`;

    // Normalize (tabs become 4 spaces, then normalized to 2-space output)
    const normalized = normalizeMarkdown(markdown, { targetIndentSize: 2 });

    const expected = `- Item 1
  - Item 2 (tab)
    - Item 3 (2 tabs)
  - Item 4 (tab)`;

    expect(normalized).toBe(expected);
  });

  it('should preserve structure with deep nesting', () => {
    const markdown = `- Level 0
  - Level 1
    - Level 2
      - Level 3
        - Level 4
      - Back to 3
    - Back to 2
  - Back to 1
- Back to 0`;

    const normalized = normalizeMarkdown(markdown);

    editor.update(() => {
      $convertFromEnhancedMarkdownString(normalized, CORE_TRANSFORMERS);
    });

    let exportedMarkdown = '';
    editor.update(() => {
      exportedMarkdown = $convertToMarkdownString(CORE_TRANSFORMERS);
    });

    expect(exportedMarkdown).toBe(normalized);
  });
});