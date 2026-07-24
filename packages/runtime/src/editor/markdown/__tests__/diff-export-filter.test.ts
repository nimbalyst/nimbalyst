/**
 * Test for filtering removed diff nodes during markdown export.
 *
 * Issue: When markdown is saved with diff state, both added (green) and removed (red)
 * nodes were being exported, causing both versions to appear after reopen.
 * Fix: Filter out nodes with NodeState.removed during export.
 */

import { describe, it, expect } from 'vitest';
import { $convertToEnhancedMarkdownString } from '../EnhancedMarkdownExport';
import { MARKDOWN_TEST_TRANSFORMERS, createTestEditor } from '../../plugins/DiffPlugin/__tests__/utils/testConfig';
import { $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import { $setDiffState } from '../../plugins/DiffPlugin/core/DiffState';

describe('Diff Export Filter', () => {
  it('should exclude removed nodes from markdown export', async () => {
    const editor = createTestEditor();

    await editor.update(() => {
      const root = $getRoot();
      root.clear();

      // Create a paragraph with mixed diff states
      const paragraph = $createParagraphNode();

      // Original text (no diff state)
      const originalText = $createTextNode('This is ');

      // Added text (green - should be included)
      const addedText = $createTextNode('new ');
      $setDiffState(addedText, 'added');

      // Removed text (red - should be excluded)
      const removedText = $createTextNode('old ');
      $setDiffState(removedText, 'removed');

      // More original text
      const moreText = $createTextNode('text.');

      paragraph.append(originalText, addedText, removedText, moreText);
      root.append(paragraph);
    });

    const exportedMarkdown = await editor.getEditorState().read(() => {
      return $convertToEnhancedMarkdownString(
        MARKDOWN_TEST_TRANSFORMERS,
        { includeFrontmatter: false }
      );
    });

    // The exported markdown should contain original + added text, but NOT removed text
    expect(exportedMarkdown).toBe('This is new text.');
    expect(exportedMarkdown).not.toContain('old');
  });

  it('should include added nodes in markdown export', async () => {
    const editor = createTestEditor();

    await editor.update(() => {
      const root = $getRoot();
      root.clear();

      const paragraph = $createParagraphNode();

      const originalText = $createTextNode('Original ');

      const addedText = $createTextNode('added ');
      $setDiffState(addedText, 'added');

      const moreText = $createTextNode('content.');

      paragraph.append(originalText, addedText, moreText);
      root.append(paragraph);
    });

    const exportedMarkdown = await editor.getEditorState().read(() => {
      return $convertToEnhancedMarkdownString(
        MARKDOWN_TEST_TRANSFORMERS,
        { includeFrontmatter: false }
      );
    });

    expect(exportedMarkdown).toBe('Original added content.');
  });

  it('should handle multiple removed nodes in sequence', async () => {
    const editor = createTestEditor();

    await editor.update(() => {
      const root = $getRoot();
      root.clear();

      const paragraph = $createParagraphNode();

      const text1 = $createTextNode('Keep ');

      const removed1 = $createTextNode('remove1 ');
      $setDiffState(removed1, 'removed');

      const removed2 = $createTextNode('remove2 ');
      $setDiffState(removed2, 'removed');

      const text2 = $createTextNode('this.');

      paragraph.append(text1, removed1, removed2, text2);
      root.append(paragraph);
    });

    const exportedMarkdown = await editor.getEditorState().read(() => {
      return $convertToEnhancedMarkdownString(
        MARKDOWN_TEST_TRANSFORMERS,
        { includeFrontmatter: false }
      );
    });

    expect(exportedMarkdown).toBe('Keep this.');
    expect(exportedMarkdown).not.toContain('remove1');
    expect(exportedMarkdown).not.toContain('remove2');
  });

  it('should preserve normal text when no diff state present', async () => {
    const editor = createTestEditor();

    await editor.update(() => {
      const root = $getRoot();
      root.clear();

      const paragraph = $createParagraphNode();
      const text = $createTextNode('Normal text without diffs.');

      paragraph.append(text);
      root.append(paragraph);
    });

    const exportedMarkdown = await editor.getEditorState().read(() => {
      return $convertToEnhancedMarkdownString(
        MARKDOWN_TEST_TRANSFORMERS,
        { includeFrontmatter: false }
      );
    });

    expect(exportedMarkdown).toBe('Normal text without diffs.');
  });
});
