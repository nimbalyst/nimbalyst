/**
 * Test: checkbox round-trip through Lexical with frontmatter
 * Reproduces the bug where [x] checkboxes get reset to [ ] when a file
 * with frontmatter is opened in the editor and saved.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEditor } from 'lexical';
import { ListNode, ListItemNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { $convertToMarkdownString } from '@lexical/markdown';
import { $convertFromEnhancedMarkdownString } from '../EnhancedMarkdownImport';
import { $convertToEnhancedMarkdownString } from '../EnhancedMarkdownExport';
import { CORE_TRANSFORMERS } from '../core-transformers';

describe('Checkbox roundtrip with frontmatter', () => {
  let editor: ReturnType<typeof createEditor>;

  beforeEach(() => {
    editor = createEditor({
      nodes: [ListNode, ListItemNode, HeadingNode, QuoteNode, CodeNode, LinkNode],
    });
  });

  it('should preserve [x] checkboxes through basic round-trip', () => {
    const markdown = `- [ ] Unchecked
- [x] Checked
- [ ] Another`;

    let exported = '';
    editor.update(() => {
      $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      exported = $convertToMarkdownString(CORE_TRANSFORMERS);
    });

    expect(exported).toBe(markdown);
  });

  it('should preserve [x] checkboxes through enhanced round-trip (with frontmatter)', () => {
    const markdown = `---
planStatus:
  title: Test Plan
  progress: 50
---
# Test Plan

## Phase 1

- [x] First completed task
- [x] Second completed task
- [ ] Pending task

## Phase 2

- [ ] Future task`;

    let exported = '';
    editor.update(() => {
      $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      exported = $convertToEnhancedMarkdownString(CORE_TRANSFORMERS, {
        includeFrontmatter: true,
      });
    });

    // Check that [x] survived the round-trip
    expect(exported).toContain('- [x] First completed task');
    expect(exported).toContain('- [x] Second completed task');
    expect(exported).toContain('- [ ] Pending task');
    expect(exported).toContain('- [ ] Future task');
  });

  it('should preserve [x] in complex document structure like the plan file', () => {
    const markdown = `---
planStatus:
  progress: 43
---
# Unified Tracker System

## Implementation Phases

### Phase 1: Database Content

**Goal**: Tracker items can have rich content.

- [x] Add content JSONB column
- [x] Add archived columns
- [x] IPC handlers for content
- [x] Embed Lexical editor
- [ ] Post-import option

### Phase 2: Migration

- [x] Import plan from file
- [ ] Bulk import`;

    let exported = '';
    editor.update(() => {
      $convertFromEnhancedMarkdownString(markdown, CORE_TRANSFORMERS);
      exported = $convertToEnhancedMarkdownString(CORE_TRANSFORMERS, {
        includeFrontmatter: true,
      });
    });

    expect(exported).toContain('- [x] Add content JSONB column');
    expect(exported).toContain('- [x] Add archived columns');
    expect(exported).toContain('- [x] IPC handlers for content');
    expect(exported).toContain('- [x] Embed Lexical editor');
    expect(exported).toContain('- [ ] Post-import option');
    expect(exported).toContain('- [x] Import plan from file');
    expect(exported).toContain('- [ ] Bulk import');
  });
});
