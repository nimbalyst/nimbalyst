/**
 * Test that empty lines remain unchanged when surrounding content is modified
 *
 * Bug: When paragraph content is modified but structure remains the same,
 * empty lines between sections should remain unchanged (not show as delete+add).
 * The structural context (heading -> empty -> paragraph) is preserved, so the
 * empty line should match as 'equal' not 'replace'.
 */

import { describe, it, expect } from 'vitest';
import { $getRoot } from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  getEditorTransformers,
} from '../../../../../markdown';
import { applyMarkdownReplace } from '../../../core/diffUtils';
import { createTestHeadlessEditor } from '../../utils/testConfig';

describe('Empty lines unchanged when content modified', () => {
  it('should keep empty lines as unchanged when paragraph text is modified', () => {
    const editor = createTestHeadlessEditor();
    const transformers = getEditorTransformers();

    // Setup: Document with headings and paragraphs, with empty lines between sections
    const initialMarkdown = `# Test Document

## First Heading

This is the first paragraph with some sample text.

## Second Heading

This is the second paragraph with different content.
`;

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        $convertFromEnhancedMarkdownString(initialMarkdown, transformers, undefined, true, true);
      },
      { discrete: true }
    );

    // Capture initial structure
    const initialStructure: any[] = [];
    editor.getEditorState().read(() => {
      const root = $getRoot();
      root.getChildren().forEach((node, i) => {
        initialStructure.push({
          index: i,
          type: node.getType(),
          text: node.getTextContent(),
        });
      });
    });

    console.log('Initial structure:');
    console.log(JSON.stringify(initialStructure, null, 2));

    // Apply replacements that modify paragraph content but preserve structure
    const replacements = [
      {
        oldText: 'This is the first paragraph with some sample text.',
        newText: 'This is the **first** paragraph with some **modified** sample text.'
      },
      {
        oldText: 'This is the second paragraph with different content.',
        newText: 'This is the _second_ paragraph with _updated_ different content.'
      }
    ];

    editor.update(
      () => {
        const original = $convertToEnhancedMarkdownString(transformers);
        applyMarkdownReplace(editor, original, replacements, transformers);
      },
      { discrete: true }
    );

    // Check final structure and diff states
    const finalStructure: any[] = [];
    let emptyLineUnchangedCount = 0;
    let emptyLineChangedCount = 0;

    editor.getEditorState().read(() => {
      const root = $getRoot();
      root.getChildren().forEach((node, i) => {
        const type = node.getType();
        const text = node.getTextContent();
        const isEmpty = type === 'paragraph' && text.trim() === '';

        // Check diff state via node metadata
        const diffState = (node as any).__diffState;

        finalStructure.push({
          index: i,
          type,
          text: text || '(empty)',
          isEmpty,
          diffState: diffState || 'none',
        });

        // Count empty lines and their diff states
        if (isEmpty) {
          if (!diffState || diffState === 'none') {
            emptyLineUnchangedCount++;
          } else if (diffState === 'added' || diffState === 'removed') {
            emptyLineChangedCount++;
          }
        }
      });
    });

    console.log('\nFinal structure with diff states:');
    console.log(JSON.stringify(finalStructure, null, 2));

    // Verify structure is preserved
    expect(finalStructure.length).toBeGreaterThan(0);

    // Find empty lines between sections
    const emptyLines = finalStructure.filter(node => node.isEmpty);
    console.log(`\nFound ${emptyLines.length} empty lines`);
    console.log(`  Unchanged: ${emptyLineUnchangedCount}`);
    console.log(`  Changed (added/removed): ${emptyLineChangedCount}`);

    // CRITICAL: Empty lines should NOT be marked as added/removed
    // They should remain unchanged (no diff state or explicit unchanged state)
    expect(emptyLineChangedCount).toBe(0);

    // We expect at least some empty lines to exist in the structure
    expect(emptyLines.length).toBeGreaterThan(0);

    // Verify that empty lines that were between sections are still there and unchanged
    // Look for pattern: heading -> empty -> paragraph (which should have empty unchanged)
    for (let i = 1; i < finalStructure.length - 1; i++) {
      const prev = finalStructure[i - 1];
      const curr = finalStructure[i];
      const next = finalStructure[i + 1];

      // If we have heading -> empty -> paragraph pattern
      if (prev.type === 'heading' && curr.isEmpty && next.type === 'paragraph') {
        console.log(`\nFound heading->empty->paragraph pattern at index ${i}:`);
        console.log(`  Previous: ${prev.type} "${prev.text}"`);
        console.log(`  Current (empty): diffState=${curr.diffState}`);
        console.log(`  Next: ${next.type} "${next.text.substring(0, 40)}"`);

        // The empty line should be unchanged
        expect(curr.diffState).not.toBe('added');
        expect(curr.diffState).not.toBe('removed');
      }
    }

    // Verify the final markdown has proper structure
    const finalMarkdown = editor.getEditorState().read(() =>
      $convertToEnhancedMarkdownString(transformers)
    );

    console.log('\nFinal markdown:');
    console.log(finalMarkdown);

    // Should have empty line after First Heading
    expect(finalMarkdown).toContain('## First Heading\n\n');
    // Should have empty line after Second Heading
    expect(finalMarkdown).toContain('## Second Heading\n\n');
  });

  it('should keep empty lines unchanged across multiple section modifications', () => {
    const editor = createTestHeadlessEditor();
    const transformers = getEditorTransformers();

    // More complex scenario with multiple sections
    const initialMarkdown = `# Document

## Section One

Original content for section one.

## Section Two

Original content for section two.

## Section Three

Original content for section three.
`;

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        $convertFromEnhancedMarkdownString(initialMarkdown, transformers, undefined, true, true);
      },
      { discrete: true }
    );

    // Modify all section contents
    editor.update(
      () => {
        const original = $convertToEnhancedMarkdownString(transformers);
        applyMarkdownReplace(editor, original, [
          {
            oldText: 'Original content for section one.',
            newText: 'Modified content for section one with **bold** text.'
          },
          {
            oldText: 'Original content for section two.',
            newText: 'Modified content for section two with _italic_ text.'
          },
          {
            oldText: 'Original content for section three.',
            newText: 'Modified content for section three with `code` text.'
          }
        ], transformers);
      },
      { discrete: true }
    );

    // Count empty lines with added/removed state
    let emptyWithChangeState = 0;
    editor.getEditorState().read(() => {
      const root = $getRoot();
      root.getChildren().forEach((node) => {
        const isEmpty = node.getType() === 'paragraph' && node.getTextContent().trim() === '';
        const diffState = (node as any).__diffState;

        if (isEmpty && (diffState === 'added' || diffState === 'removed')) {
          emptyWithChangeState++;
          console.log(`Found empty line with state: ${diffState}`);
        }
      });
    });

    // No empty lines should be marked as changed
    expect(emptyWithChangeState).toBe(0);
  });
});
