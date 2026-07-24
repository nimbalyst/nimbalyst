/**
 * Test with full document structure matching user's screenshot
 */

import {describe, expect, it} from 'vitest';
import {testComprehensiveDiff} from '../../utils/comprehensiveDiffTester';
import {$getRoot, $isElementNode} from 'lexical';
import {$getDiffState} from '../../../core/DiffState';

describe('Full document with multiple paragraphs and heading', () => {
  it('should use inline diff for all paragraphs in multi-paragraph document', () => {
    const oldMarkdown = `This is the first paragraph with some sample text that we will modify later. It contains multiple sentences to make the changes more interesting.

## Second Heading

This is the second paragraph with different content. We will apply changes to this text as well to test the diff system.`;

    const newMarkdown = `This is the **first** paragraph with some **modified** sample text that we will modify later. It contains multiple sentences to make the changes more interesting.

## Second Heading

This is the **second** paragraph with **updated** different content. We will apply changes to this text as well to test the diff system.`;

    console.log('\n=== FULL DOCUMENT TEST WITH FORMATTING ===');
    console.log('Changes:');
    console.log('  Paragraph 1: "first" → "**first**" (bold), "sample" → "**modified** sample" (added + bold)');
    console.log('  Paragraph 2: "second" → "**second**" (bold), "different" → "**updated** different" (added + bold)');

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    console.log('\nDiff stats:', {
      added: result.withDiff.stats.addedNodes,
      removed: result.withDiff.stats.removedNodes,
      modified: result.withDiff.stats.modifiedNodes,
      total: result.withDiff.stats.totalNodes,
    });

    console.log('\nNodes:');
    result.withDiff.nodes.forEach(node => {
      console.log(`  [${node.diffState || 'null'}] ${node.type}: "${node.textPreview}"`);
    });

    // Inspect the first modified paragraph in detail
    console.log('\n=== DETAILED INSPECTION OF FIRST PARAGRAPH ===');
    result.withDiff.editor.getEditorState().read(() => {
      const root = $getRoot();
      const firstPara = root.getFirstChild();

      if (firstPara && $isElementNode(firstPara)) {
        const children = firstPara.getChildren();
        console.log(`First paragraph has ${children.length} children:`);

        children.forEach((child: any, i: number) => {
          const diffState = $getDiffState(child);
          const text = child.getTextContent();
          const type = child.getType();
          const format = child.getFormat ? child.getFormat() : 'N/A';
          console.log(`  ${i}: type=${type} format=${format} diffState=[${diffState || 'null'}] "${text.substring(0, 40)}"`);
        });
      }
    });

    // Should have 2 modified paragraphs, not 4 paragraphs (2 removed + 2 added)
    const paragraphs = result.withDiff.nodes.filter(n => n.type === 'paragraph');
    console.log(`\nParagraph count: ${paragraphs.length}`);

    const modifiedParagraphs = paragraphs.filter(n => n.diffState === 'modified');
    const addedParagraphs = paragraphs.filter(n => n.diffState === 'added');
    const removedParagraphs = paragraphs.filter(n => n.diffState === 'removed');

    console.log(`  Modified: ${modifiedParagraphs.length}`);
    console.log(`  Added: ${addedParagraphs.length}`);
    console.log(`  Removed: ${removedParagraphs.length}`);

    if (addedParagraphs.length > 0 || removedParagraphs.length > 0) {
      console.log('\n❌ BUG REPRODUCED: Using full replacement instead of inline diff!');
    } else {
      console.log('\n✓ Working correctly: Using inline diff');
    }

    // Expect inline diff, not full replacement
    expect(modifiedParagraphs.length).toBe(2);
    expect(addedParagraphs.length).toBe(0);
    expect(removedParagraphs.length).toBe(0);
  });
});
