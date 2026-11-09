// @vitest-environment node
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
import { unified } from 'unified';
import remarkParse from 'remark-parse';

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

  // #1937: nested children must be indented past the parent's marker so
  // CommonMark parsers keep them nested, and each sublist keeps its own start.
  describe('nested ordered lists', () => {
    let editor: ReturnType<typeof createEditor>;

    beforeEach(() => {
      setListConfig({ exportIndentSize: 2, importMinIndentSize: 2 });
      editor = createEditor({
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode],
        onError: (error) => { throw error; },
      });
    });

    function roundTrip(markdown: string): string {
      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      }, { discrete: true });
      return editor.read(() => $convertToMarkdownString(CORE_TRANSFORMERS));
    }

    // Outer list structure as an independent CommonMark parser sees it
    function commonmarkLists(markdown: string) {
      const lists: Array<{ depth: number; start: number | null | undefined; items: number }> = [];
      const walk = (node: any, depth: number) => {
        if (node.type === 'list') {
          lists.push({ depth, start: node.start, items: node.children.length });
        }
        node.children?.forEach((child: any) => walk(child, node.type === 'list' ? depth + 1 : depth));
      };
      walk(unified().use(remarkParse).parse(markdown), 0);
      return lists;
    }

    it('keeps children under "2. " nested for CommonMark', () => {
      const markdown = `1. First step.
2. Second step.
   1. Sub-step one.
   2. Sub-step two.
3. Third step.`;

      const exported = roundTrip(markdown);
      expect(exported).toBe(markdown);
      expect(commonmarkLists(exported)).toEqual([
        { depth: 0, start: 1, items: 3 },
        { depth: 1, start: 1, items: 2 },
      ]);
    });

    it('starts a sublist at its own first number, not the parent list start', () => {
      const markdown = `10. Add more choices.
    1. Click the dropdown.
    2. Enter the title.
11. Click Update Card.`;

      const exported = roundTrip(markdown);
      expect(exported).toBe(markdown);
      expect(commonmarkLists(exported)).toEqual([
        { depth: 0, start: 10, items: 2 },
        { depth: 1, start: 1, items: 2 },
      ]);
    });

    it('indents each child past its own parent marker across a width change', () => {
      const markdown = `99. Parent.
    1. Child one.
100. Next.
     1. Child two.`;

      expect(roundTrip(markdown)).toBe(markdown);
    });

    it('re-saves legacy two-space ordered children as nested', () => {
      const legacy = `1. First step.
2. Second step.
  1. Sub-step one.
  2. Sub-step two.
3. Third step.`;

      expect(roundTrip(legacy)).toBe(`1. First step.
2. Second step.
   1. Sub-step one.
   2. Sub-step two.
3. Third step.`);
    });

    it('nests a bullet sublist under a numbered item', () => {
      const markdown = `1. Parent.
   - Child one.
   - Child two.
2. Next.`;

      const exported = roundTrip(markdown);
      expect(exported).toBe(markdown);
      expect(commonmarkLists(exported)).toEqual([
        { depth: 0, start: 1, items: 2 },
        { depth: 1, start: null, items: 2 },
      ]);
    });

    it('keeps the outer number after a loose sublist with its own start', () => {
      const markdown = `1. Parent.

   7. Child seven.
   8. Child eight.
2. Next.`;

      expect(roundTrip(markdown)).toBe(markdown);
    });

    it('keeps two-space children under bullet and check items', () => {
      const bullets = `- Parent.
  - Child.
    1. Grandchild.
- Next.`;
      const checks = `- [ ] Task.
  - [x] Subtask.`;

      expect(roundTrip(bullets)).toBe(bullets);
      expect(roundTrip(checks)).toBe(checks);
    });
  });
});
