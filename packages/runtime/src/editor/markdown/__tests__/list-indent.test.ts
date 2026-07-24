/**
 * Simplified test for markdown list handling
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { $getRoot, createEditor } from 'lexical';
import { ListNode, ListItemNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { $convertToMarkdownString } from '@lexical/markdown';
import { $convertFromEnhancedMarkdownString } from '../EnhancedMarkdownImport';
import { CORE_TRANSFORMERS } from '../core-transformers';
import { setListConfig } from '../ListTransformers';

describe('Markdown List Handling', () => {
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

  it('should import and export simple lists', () => {
    const markdown = `- Item 1
- Item 2
- Item 3`;

    let exported = '';

    editor.update(() => {
      $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      exported = $convertToMarkdownString(CORE_TRANSFORMERS);
    });

    expect(exported).toBe(markdown);
  });

  it('should handle 2-space nested lists', () => {
    const markdown = `- Item 1
  - Nested 1
  - Nested 2
- Item 2`;

    let exported = '';

    editor.update(() => {
      $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      exported = $convertToMarkdownString(CORE_TRANSFORMERS);
    });

    expect(exported).toBe(markdown);
  });

  it('should normalize 4-space to 2-space on import', () => {
    const fourSpaceMarkdown = `- Item 1
    - Nested with 4 spaces
- Item 2`;

    const expectedExport = `- Item 1
  - Nested with 4 spaces
- Item 2`;

    let exported = '';

    editor.update(() => {
      $convertFromEnhancedMarkdownString(fourSpaceMarkdown, CORE_TRANSFORMERS);
      exported = $convertToMarkdownString(CORE_TRANSFORMERS);
    });

    expect(exported).toBe(expectedExport);
  });

  it('should handle deeply nested lists', () => {
    const markdown = `- Level 1
  - Level 2
    - Level 3
      - Level 4`;

    let exported = '';

    editor.update(() => {
      $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      exported = $convertToMarkdownString(CORE_TRANSFORMERS);
    });

    expect(exported).toBe(markdown);
  });

  it('should handle mixed list types', () => {
    const markdown = `1. Ordered item
2. Another ordered
   - Bullet nested
   - Another bullet
3. Back to ordered`;

    let roundTripped = '';

    editor.update(() => {
      $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      roundTripped = $convertToMarkdownString(CORE_TRANSFORMERS);
    });

    // The format should be preserved
    expect(roundTripped).toContain('1. ');
    expect(roundTripped).toContain('2. ');
    expect(roundTripped).toContain('3. ');
    expect(roundTripped).toContain('- ');
  });
});