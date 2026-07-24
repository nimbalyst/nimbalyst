/**
 * Simplified tests for ListTransformers
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEditor } from 'lexical';
import { ListNode, ListItemNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { $convertToMarkdownString } from '@lexical/markdown';
import { $convertFromEnhancedMarkdownString } from '../EnhancedMarkdownImport';
import {
  getIndentLevel,
  setListConfig,
  UNORDERED_LIST,
  ORDERED_LIST,
  CHECK_LIST
} from '../ListTransformers';
import { CORE_TRANSFORMERS } from '../core-transformers';

describe('ListTransformers', () => {
  describe('getIndentLevel', () => {
    it('should detect 2-space indents', () => {
      expect(getIndentLevel('  ', true)).toBe(1);
      expect(getIndentLevel('    ', true)).toBe(2);
      expect(getIndentLevel('      ', true)).toBe(3);
    });

    it('should handle tabs', () => {
      expect(getIndentLevel('\t', true)).toBe(1);
      expect(getIndentLevel('\t\t', true)).toBe(2);
    });

    it('should handle mixed tabs and spaces', () => {
      expect(getIndentLevel('\t  ', true)).toBe(2); // 1 tab + 2 spaces
      expect(getIndentLevel('  \t', true)).toBe(2); // 2 spaces + 1 tab
    });
  });

  describe('List transformers', () => {
    let editor: ReturnType<typeof createEditor>;

    beforeEach(() => {
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

    it('should handle unordered lists', () => {
      const markdown = `- Item 1
- Item 2
  - Nested item
- Item 3`;

      let exported = '';
      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
        exported = $convertToMarkdownString(CORE_TRANSFORMERS);
      });

      expect(exported).toBe(markdown);
    });

    it('should handle ordered lists', () => {
      const markdown = `1. First
2. Second
3. Third`;

      let exported = '';
      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
        exported = $convertToMarkdownString(CORE_TRANSFORMERS);
      });

      expect(exported).toBe(markdown);
    });

    it('should handle check lists', () => {
      const markdown = `- [ ] Unchecked item
- [x] Checked item
- [ ] Another unchecked`;

      let exported = '';
      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
        exported = $convertToMarkdownString(CORE_TRANSFORMERS);
      });

      expect(exported).toBe(markdown);
    });

    it('should support different list markers', () => {
      const markdownWithStar = `* Star item
* Another star`;

      const markdownWithPlus = `+ Plus item
+ Another plus`;

      let exportedStar = '';
      let exportedPlus = '';

      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdownWithStar, CORE_TRANSFORMERS);
        exportedStar = $convertToMarkdownString(CORE_TRANSFORMERS);
      });

      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdownWithPlus, CORE_TRANSFORMERS);
        exportedPlus = $convertToMarkdownString(CORE_TRANSFORMERS);
      });

      // Should normalize to dash
      expect(exportedStar).toContain('- ');
      expect(exportedPlus).toContain('- ');
    });
  });
});