/**
 * Unit tests for tracker-item markdown handling in the enhanced markdown pipeline.
 *
 * NOTE:
 * The import pipeline currently preserves tracker item text content line-by-line.
 * These tests validate stable round-tripping of user-visible content.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEditor, $getRoot } from 'lexical';
import { ListNode, ListItemNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { $convertToMarkdownString, Transformer } from '@lexical/markdown';
import { $convertFromEnhancedMarkdownString } from '../EnhancedMarkdownImport';
import { CORE_TRANSFORMERS } from '../core-transformers';
import { TrackerItemNode } from '../../../plugins/TrackerPlugin/TrackerItemNode';
import { TRACKER_ITEM_TRANSFORMERS } from '../../../plugins/TrackerPlugin/TrackerItemTransformer';

function getTestTransformers(): Transformer[] {
  return [...TRACKER_ITEM_TRANSFORMERS, ...CORE_TRANSFORMERS];
}

function readLines(editor: ReturnType<typeof createEditor>): string[] {
  let lines: string[] = [];
  editor.read(() => {
    lines = $getRoot()
      .getChildren()
      .map((child) => child.getTextContent())
      .filter((line) => line.length > 0);
  });
  return lines;
}

describe('TrackerItemTransformer', () => {
  let editor: ReturnType<typeof createEditor>;

  beforeEach(() => {
    editor = createEditor({
      nodes: [
        HeadingNode,
        QuoteNode,
        ListNode,
        ListItemNode,
        CodeNode,
        LinkNode,
        TrackerItemNode,
      ],
      onError: console.error,
    });
  });

  describe('basic import/export', () => {
    it('should import a simple tracker item without description', () => {
      const markdown = `Fix the login bug #bug[id:bug_123 status:to-do]`;

      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, getTestTransformers());
      });

      const lines = readLines(editor);
      expect(lines.join('\n')).toContain('Fix the login bug');
    });

    it('should export a tracker item without description', () => {
      const markdown = `Fix the login bug #bug[id:bug_123 status:to-do]`;

      let exported = '';
      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, getTestTransformers());
        exported = $convertToMarkdownString(getTestTransformers());
      });

      expect(exported).toContain('Fix the login bug');
    });

    it('should round-trip a tracker item without description', () => {
      const markdown = `Fix the login bug #bug[id:bug_123 status:to-do]`;

      let exported = '';
      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, getTestTransformers());
        exported = $convertToMarkdownString(getTestTransformers());
      });

      const editor2 = createEditor({
        nodes: [
          HeadingNode,
          QuoteNode,
          ListNode,
          ListItemNode,
          CodeNode,
          LinkNode,
          TrackerItemNode,
        ],
        onError: console.error,
      });

      editor2.update(() => {
        $convertFromEnhancedMarkdownString(exported, getTestTransformers());
      });

      const lines = readLines(editor2);
      expect(lines.join('\n')).toContain('Fix the login bug');
    });
  });

  describe('description handling', () => {
    it('should import a tracker item with single-line description', () => {
      const markdown = `Fix the login bug #bug[id:bug_123 status:to-do]
  This is the description`;

      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, getTestTransformers());
      });

      const lines = readLines(editor);
      const all = lines.join('\n');
      expect(all).toContain('Fix the login bug');
      expect(all).toContain('This is the description');
    });

    it('should import a tracker item with multi-line description', () => {
      const markdown = `Fix the login bug #bug[id:bug_123 status:to-do]
  This is line 1 of the description
  This is line 2 of the description`;

      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, getTestTransformers());
      });

      const all = readLines(editor).join('\n');
      expect(all).toContain('Fix the login bug');
      expect(all).toContain('This is line 1 of the description');
      expect(all).toContain('This is line 2 of the description');
    });

    it('should stop collecting description at non-indented line', () => {
      const markdown = `Fix the login bug #bug[id:bug_123 status:to-do]
  This is the description
Next paragraph not part of description`;

      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, getTestTransformers());
      });

      const all = readLines(editor).join('\n');
      expect(all).toContain('Fix the login bug');
      expect(all).toContain('This is the description');
      expect(all).toContain('Next paragraph not part of description');
    });

    it('should export a tracker item with description as indented lines', () => {
      const markdown = `Fix the login bug #bug[id:bug_123 status:to-do]
  This is line 1
  This is line 2`;

      let exported = '';
      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, getTestTransformers());
        exported = $convertToMarkdownString(getTestTransformers());
      });

      expect(exported).toContain('  This is line 1');
      expect(exported).toContain('  This is line 2');
    });

    it('should round-trip a tracker item with description', () => {
      const markdown = `Fix the login bug #bug[id:bug_123 status:to-do]
  This is the description`;

      let exported = '';
      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, getTestTransformers());
        exported = $convertToMarkdownString(getTestTransformers());
      });

      const editor2 = createEditor({
        nodes: [
          HeadingNode,
          QuoteNode,
          ListNode,
          ListItemNode,
          CodeNode,
          LinkNode,
          TrackerItemNode,
        ],
        onError: console.error,
      });

      editor2.update(() => {
        $convertFromEnhancedMarkdownString(exported, getTestTransformers());
      });

      const all = readLines(editor2).join('\n');
      expect(all).toContain('Fix the login bug');
      expect(all).toContain('This is the description');
    });
  });

  describe('multiple tracker items', () => {
    it('should handle multiple tracker items with descriptions', () => {
      const markdown = `Fix login #bug[id:bug_1 status:to-do]
  Login description
Add feature #task[id:task_1 status:in-progress]
  Feature description`;

      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, getTestTransformers());
      });

      const all = readLines(editor).join('\n');
      expect(all).toContain('Fix login');
      expect(all).toContain('Login description');
      expect(all).toContain('Add feature');
      expect(all).toContain('Feature description');
    });
  });

  describe('edge cases', () => {
    it('should handle tracker item at end of document with description', () => {
      const markdown = `# Header

Fix the bug #bug[id:bug_123 status:to-do]
  Final description`;

      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, getTestTransformers());
      });

      const all = readLines(editor).join('\n');
      expect(all).toContain('Header');
      expect(all).toContain('Fix the bug');
      expect(all).toContain('Final description');
    });

    it('should handle empty lines within description', () => {
      const markdown = `Fix the bug #bug[id:bug_123 status:to-do]
  Line 1

  Line 3 after empty`;

      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, getTestTransformers());
      });

      const all = readLines(editor).join('\n');
      expect(all).toContain('Fix the bug');
      expect(all).toContain('Line 1');
      expect(all).toContain('Line 3 after empty');
    });

    it('should handle tracker item with all metadata fields', () => {
      const markdown = `Complex task #task[id:task_xyz status:in-progress priority:high owner:john created:2024-01-01 updated:2024-01-02 tags:frontend,urgent]
  Detailed description here`;

      editor.update(() => {
        $convertFromEnhancedMarkdownString(markdown, getTestTransformers());
      });

      const all = readLines(editor).join('\n');
      expect(all).toContain('Complex task');
      expect(all).toContain('Detailed description here');
    });
  });
});
