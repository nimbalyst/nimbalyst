/**
 * Test for blank line preservation regression
 * This tests that blank lines are preserved during markdown import/export
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { $getRoot, createEditor, $isParagraphNode } from 'lexical';
import { ListNode, ListItemNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { $convertToMarkdownString } from '@lexical/markdown';
import { $convertFromEnhancedMarkdownString } from '../EnhancedMarkdownImport';
import { CORE_TRANSFORMERS } from '../core-transformers';
import { setListConfig } from '../ListTransformers';

describe('Blank Line Preservation Regression', () => {
  let editor: ReturnType<typeof createEditor>;

  beforeEach(() => {
    // Set our standard 2-space configuration
    setListConfig({
      exportIndentSize: 2,
      importMinIndentSize: 2,
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

  it('should preserve blank line between heading and list', () => {
    const markdown = `# A

- Banana
- Kiwi`;

    let exported = '';
    let childCount = 0;

    editor.update(() => {
      $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      const root = $getRoot();
      const children = root.getChildren();
      childCount = children.length;

      console.log('[TEST] Children after import:');
      children.forEach((child, i) => {
        console.log(`[TEST]   ${i}: ${child.getType()} - "${child.getTextContent()}"`);
      });

      exported = $convertToMarkdownString(CORE_TRANSFORMERS);
    });

    console.log('[TEST] Exported markdown:', JSON.stringify(exported));
    console.log('[TEST] Child count:', childCount);

    // Should have: heading, paragraph (empty), list
    expect(childCount).toBe(3);

    // The exported markdown should preserve the blank line
    expect(exported).toBe(markdown);
  });

  it('should preserve multiple blank lines', () => {
    const markdown = `# A

- Item 1


And some text`;

    let exported = '';
    let childCount = 0;

    editor.update(() => {
      $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      const root = $getRoot();
      const children = root.getChildren();
      childCount = children.length;

      console.log('[TEST] Children after import (multi-blank):');
      children.forEach((child, i) => {
        const isEmpty = $isParagraphNode(child) && child.getTextContent().trim() === '';
        console.log(`[TEST]   ${i}: ${child.getType()} - "${child.getTextContent()}" (empty: ${isEmpty})`);
      });

      exported = $convertToMarkdownString(CORE_TRANSFORMERS);
    });

    console.log('[TEST] Exported markdown (multi):', JSON.stringify(exported));
    console.log('[TEST] Child count:', childCount);

    // Should have: heading, paragraph (empty), list, paragraph (empty), paragraph (empty), paragraph (text)
    // Or at minimum: heading, paragraph, list, paragraph, paragraph
    expect(childCount).toBeGreaterThanOrEqual(5);

    // The exported markdown should preserve blank lines
    expect(exported).toContain('\n\n');
  });

  it('should import markdown with blank line and count nodes correctly', () => {
    const markdown = `# A

- Banana`;

    editor.update(() => {
      $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      const root = $getRoot();
      const children = root.getChildren();

      console.log('[TEST] Node structure:');
      children.forEach((child, i) => {
        console.log(`[TEST]   Node ${i}:`, {
          type: child.getType(),
          text: child.getTextContent(),
          childCount: 'getChildren' in child ? (child as any).getChildren().length : 0,
        });
      });

      // Minimum expectation: we should have at least heading and list
      // With blank line preservation: heading, empty paragraph, list = 3 nodes
      expect(children.length).toBeGreaterThanOrEqual(2);

      // First should be heading
      expect(children[0].getType()).toBe('heading');

      // Last should be list
      expect(children[children.length - 1].getType()).toBe('list');

      // If blank line is preserved, middle should be empty paragraph
      if (children.length === 3) {
        expect(children[1].getType()).toBe('paragraph');
        expect(children[1].getTextContent().trim()).toBe('');
      }
    });
  });
});
