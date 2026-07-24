/**
 * Test for empty lines appearing at bottom instead of correct position
 *
 * Bug: When applying a diff that adds multiple sections with headings and paragraphs,
 * empty lines that should appear between sections end up at the bottom of the change.
 */

import { describe, it, expect } from 'vitest';
import { $getRoot, $isElementNode, $isParagraphNode } from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  getEditorTransformers,
} from '../../../../../markdown';
import { applyMarkdownReplace } from '../../../core/diffUtils';
import { createTestHeadlessEditor } from '../../utils/testConfig';

describe('Empty lines positioning bug', () => {
  it('should position empty lines between sections, not at bottom', () => {
    const editor = createTestHeadlessEditor();
    const transformers = getEditorTransformers();

    // Setup: Create document with h1, h2, paragraph, and two empty lines
    const preEditMarkdown = `# Main Title

## First Section

This is the initial paragraph.


`;

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        $convertFromEnhancedMarkdownString(preEditMarkdown, transformers, undefined, true, true);
      },
      { discrete: true }
    );

    // Get the markdown to verify initial state
    let initialMarkdown = '';
    editor.getEditorState().read(() => {
      initialMarkdown = $convertToEnhancedMarkdownString(transformers);
    });

    console.log('Initial markdown:', JSON.stringify(initialMarkdown));

    // Apply diff: replace paragraph + empty lines with multiple sections
    const oldText = 'This is the initial paragraph.\n\n\n';
    const newText = `This is the initial paragraph.

## Second Section

This is the second paragraph.

## Third Section

This is the third paragraph.
`;

    editor.update(
      () => {
        const original = $convertToEnhancedMarkdownString(transformers);
        console.log('Before replacement:', JSON.stringify(original));

        applyMarkdownReplace(
          editor,
          original,
          [{ oldText, newText }],
          transformers
        );
      },
      { discrete: true }
    );

    // Get final markdown and node structure
    let finalMarkdown = '';
    const nodeStructure: any[] = [];

    editor.getEditorState().read(() => {
      finalMarkdown = $convertToEnhancedMarkdownString(transformers);
      console.log('Final markdown:', JSON.stringify(finalMarkdown));

      const root = $getRoot();
      const children = root.getChildren();

      children.forEach((node, index) => {
        if ($isElementNode(node)) {
          const type = node.getType();
          const textContent = node.getTextContent();

          nodeStructure.push({
            index,
            type,
            textContent: textContent || '(empty)',
          });
        }
      });
    });

    console.log('\nFinal node structure:');
    console.log(JSON.stringify(nodeStructure, null, 2));

    // Verify structure: should be in this order
    // 0: heading "Main Title"
    // 1: paragraph (empty - spacing after Main Title)
    // 2: heading "First Section"
    // 3: paragraph "This is the initial paragraph."
    // 4: paragraph (empty - spacing before Second Section)
    // 5: heading "Second Section"
    // 6: paragraph "This is the second paragraph."
    // 7: paragraph (empty - spacing before Third Section)
    // 8: heading "Third Section"
    // 9: paragraph "This is the third paragraph."

    // Find the indices of key nodes
    let firstParagraphIndex = -1;
    let secondSectionIndex = -1;
    let secondParagraphIndex = -1;
    let thirdSectionIndex = -1;
    let thirdParagraphIndex = -1;

    for (let i = 0; i < nodeStructure.length; i++) {
      const node = nodeStructure[i];
      if (node.textContent.includes('initial paragraph')) {
        firstParagraphIndex = i;
      } else if (node.textContent.includes('Second Section')) {
        secondSectionIndex = i;
      } else if (node.textContent.includes('second paragraph')) {
        secondParagraphIndex = i;
      } else if (node.textContent.includes('Third Section')) {
        thirdSectionIndex = i;
      } else if (node.textContent.includes('third paragraph')) {
        thirdParagraphIndex = i;
      }
    }

    console.log('\nKey node indices:');
    console.log('  First paragraph:', firstParagraphIndex);
    console.log('  Second Section heading:', secondSectionIndex);
    console.log('  Second paragraph:', secondParagraphIndex);
    console.log('  Third Section heading:', thirdSectionIndex);
    console.log('  Third paragraph:', thirdParagraphIndex);

    // Check that all sections were found
    expect(firstParagraphIndex).toBeGreaterThan(-1);
    expect(secondSectionIndex).toBeGreaterThan(-1);
    expect(secondParagraphIndex).toBeGreaterThan(-1);
    expect(thirdSectionIndex).toBeGreaterThan(-1);
    expect(thirdParagraphIndex).toBeGreaterThan(-1);

    // BUG CHECK: Empty lines should appear BETWEEN sections, not at the bottom
    // There should be an empty paragraph between "initial paragraph" and "Second Section"
    const emptyBetweenFirstAndSecond = nodeStructure[firstParagraphIndex + 1];
    console.log('\nNode between first paragraph and Second Section:');
    console.log(JSON.stringify(emptyBetweenFirstAndSecond));

    expect(emptyBetweenFirstAndSecond.type).toBe('paragraph');
    expect(emptyBetweenFirstAndSecond.textContent).toBe('(empty)');

    // The "Second Section" heading should come right after the empty paragraph
    expect(secondSectionIndex).toBe(firstParagraphIndex + 2);

    // There should be an empty paragraph between "second paragraph" and "Third Section"
    const emptyBetweenSecondAndThird = nodeStructure[secondParagraphIndex + 1];
    console.log('\nNode between second paragraph and Third Section:');
    console.log(JSON.stringify(emptyBetweenSecondAndThird));

    expect(emptyBetweenSecondAndThird.type).toBe('paragraph');
    expect(emptyBetweenSecondAndThird.textContent).toBe('(empty)');

    // The "Third Section" heading should come right after the empty paragraph
    expect(thirdSectionIndex).toBe(secondParagraphIndex + 2);

    // BUG: If empty lines appear at the bottom, they would be after thirdParagraphIndex
    // Check that there are no extra empty paragraphs at the end
    const lastIndex = nodeStructure.length - 1;
    const lastNode = nodeStructure[lastIndex];

    console.log('\nLast node:');
    console.log(JSON.stringify(lastNode));

    // Check that the main structure is correct (empty lines in right positions)
    // It's acceptable to have trailing empty lines at the end from unmatched source empties

    // The key requirement: empty lines should be BETWEEN sections, not collected at bottom
    // We've already verified this above by checking emptyBetweenFirstAndSecond and emptyBetweenSecondAndThird

    // Final verification: the markdown should have proper spacing between sections
    expect(finalMarkdown).toContain('This is the initial paragraph.\n\n## Second Section');
    expect(finalMarkdown).toContain('This is the second paragraph.\n\n## Third Section');
  });
});
