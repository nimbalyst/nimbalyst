/**
 * Test for filtering removed list items during markdown export.
 *
 * Issue: When list items are marked as removed, the entire ListItemNode has the
 * diff state but they were still appearing in markdown export because the filter
 * only checked text nodes, not element nodes like ListItemNode.
 */

import { describe, it, expect } from 'vitest';
import { $convertToEnhancedMarkdownString } from '../EnhancedMarkdownExport';
import { MARKDOWN_TEST_TRANSFORMERS, createTestEditor } from '../../plugins/DiffPlugin/__tests__/utils/testConfig';
import { $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import { $createListNode, $createListItemNode } from '@lexical/list';
import { $setDiffState } from '../../plugins/DiffPlugin/core/DiffState';

describe('Diff Export List Filter', () => {
  it('should exclude removed list items from markdown export', async () => {
    const editor = createTestEditor();

    await editor.update(() => {
      const root = $getRoot();
      root.clear();

      // Create a list with mixed diff states
      const list = $createListNode('bullet');

      // Normal list item (no diff state - should be included)
      const item1 = $createListItemNode();
      item1.append($createTextNode('Keep this item'));

      // Removed list item (should be excluded)
      const item2 = $createListItemNode();
      item2.append($createTextNode('Remove this item'));
      $setDiffState(item2, 'removed');

      // Added list item (should be included)
      const item3 = $createListItemNode();
      item3.append($createTextNode('Added item'));
      $setDiffState(item3, 'added');

      // Another normal item
      const item4 = $createListItemNode();
      item4.append($createTextNode('Another kept item'));

      list.append(item1, item2, item3, item4);
      root.append(list);
    });

    const exportedMarkdown = await editor.getEditorState().read(() => {
      return $convertToEnhancedMarkdownString(
        MARKDOWN_TEST_TRANSFORMERS,
        { includeFrontmatter: false }
      );
    });

    // Should contain kept items
    expect(exportedMarkdown).toContain('Keep this item');
    expect(exportedMarkdown).toContain('Another kept item');
    expect(exportedMarkdown).toContain('Added item');

    // Should NOT contain removed item
    expect(exportedMarkdown).not.toContain('Remove this item');
  });

  it('should exclude entire nested structure when list item is removed', async () => {
    const editor = createTestEditor();

    await editor.update(() => {
      const root = $getRoot();
      root.clear();

      const list = $createListNode('bullet');

      // Normal item
      const item1 = $createListItemNode();
      item1.append($createTextNode('First item'));

      // Removed item with nested content
      const item2 = $createListItemNode();
      item2.append($createTextNode('Removed parent item'));

      // Add nested list
      const nestedList = $createListNode('bullet');
      const nestedItem = $createListItemNode();
      nestedItem.append($createTextNode('Nested content'));
      nestedList.append(nestedItem);
      item2.append(nestedList);

      $setDiffState(item2, 'removed');

      // Normal item
      const item3 = $createListItemNode();
      item3.append($createTextNode('Last item'));

      list.append(item1, item2, item3);
      root.append(list);
    });

    const exportedMarkdown = await editor.getEditorState().read(() => {
      return $convertToEnhancedMarkdownString(
        MARKDOWN_TEST_TRANSFORMERS,
        { includeFrontmatter: false }
      );
    });

    // Should contain kept items
    expect(exportedMarkdown).toContain('First item');
    expect(exportedMarkdown).toContain('Last item');

    // Should NOT contain removed item or its nested content
    expect(exportedMarkdown).not.toContain('Removed parent item');
    expect(exportedMarkdown).not.toContain('Nested content');
  });

  it('should handle numbered lists with removed items', async () => {
    const editor = createTestEditor();

    await editor.update(() => {
      const root = $getRoot();
      root.clear();

      const list = $createListNode('number');

      const item1 = $createListItemNode();
      item1.append($createTextNode('Step 1'));

      const item2 = $createListItemNode();
      item2.append($createTextNode('Step 2 (removed)'));
      $setDiffState(item2, 'removed');

      const item3 = $createListItemNode();
      item3.append($createTextNode('Step 3'));

      list.append(item1, item2, item3);
      root.append(list);
    });

    const exportedMarkdown = await editor.getEditorState().read(() => {
      return $convertToEnhancedMarkdownString(
        MARKDOWN_TEST_TRANSFORMERS,
        { includeFrontmatter: false }
      );
    });

    expect(exportedMarkdown).toContain('Step 1');
    expect(exportedMarkdown).toContain('Step 3');
    expect(exportedMarkdown).not.toContain('Step 2');
    expect(exportedMarkdown).not.toContain('removed');
  });

  it('should handle all items removed from a list', async () => {
    const editor = createTestEditor();

    await editor.update(() => {
      const root = $getRoot();
      root.clear();

      // Add a paragraph before the list
      const para1 = $createParagraphNode();
      para1.append($createTextNode('Before list'));

      const list = $createListNode('bullet');

      const item1 = $createListItemNode();
      item1.append($createTextNode('Removed item 1'));
      $setDiffState(item1, 'removed');

      const item2 = $createListItemNode();
      item2.append($createTextNode('Removed item 2'));
      $setDiffState(item2, 'removed');

      list.append(item1, item2);

      // Add a paragraph after the list
      const para2 = $createParagraphNode();
      para2.append($createTextNode('After list'));

      root.append(para1, list, para2);
    });

    const exportedMarkdown = await editor.getEditorState().read(() => {
      return $convertToEnhancedMarkdownString(
        MARKDOWN_TEST_TRANSFORMERS,
        { includeFrontmatter: false }
      );
    });

    // Should contain paragraphs but not list items
    expect(exportedMarkdown).toContain('Before list');
    expect(exportedMarkdown).toContain('After list');
    expect(exportedMarkdown).not.toContain('Removed item 1');
    expect(exportedMarkdown).not.toContain('Removed item 2');
  });
});
