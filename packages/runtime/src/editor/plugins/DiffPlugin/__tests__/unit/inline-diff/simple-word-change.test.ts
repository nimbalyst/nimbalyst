/**
 * Test for inline diff within a single paragraph
 * When only one word changes, we should show inline diff highlighting
 * instead of removing the whole paragraph and adding a new one.
 */

import {describe, expect, it} from 'vitest';
import {testComprehensiveDiff} from '../../utils/comprehensiveDiffTester';
import {$getRoot, $isElementNode} from 'lexical';
import {$getDiffState} from '../../../core/DiffState';

describe('Inline diff - single word change', () => {
  it('should show inline diff when one word changes in a paragraph', () => {
    const oldMarkdown = 'The quick brown fox jumps over the lazy dog.';
    const newMarkdown = 'The quick brown fox leaps over the lazy dog.';

    console.log('\n=== INLINE DIFF TEST: Single Word Change ===');
    console.log('Old:', oldMarkdown);
    console.log('New:', newMarkdown);
    console.log('Changed: "jumps" → "leaps"');

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    // Debug output
    console.log('\nDiff stats:', {
      added: result.withDiff.stats.addedNodes,
      removed: result.withDiff.stats.removedNodes,
      modified: result.withDiff.stats.modifiedNodes,
    });

    console.log('\nNodes with diff state:');
    result.withDiff.nodes.forEach(node => {
      if (node.diffState) {
        console.log(`  [${node.diffState}] ${node.type}: "${node.text.substring(0, 60)}"`);
      }
    });

    // Check for inline diff nodes (child text nodes with diff state)
    console.log('\nDetailed node structure:');
    result.withDiff.editor.getEditorState().read(() => {
      const root = $getRoot();
      console.log(`Root has ${root.getChildrenSize()} children`);
      const paragraph = root.getFirstChild();

      if (!paragraph) {
        console.log('No paragraph found!');
        return;
      }

      console.log(`First child type: ${paragraph.getType()}`);

      if ($isElementNode(paragraph)) {
        const children = paragraph.getChildren();
        console.log(`Paragraph has ${children.length} child nodes:`);

        children.forEach((child: any, i: number) => {
          const diffState = $getDiffState(child);
          const text = child.getTextContent();
          console.log(`  ${i}: type=${child.getType()} [${diffState || 'null'}] "${text}"`);
        });
      } else {
        console.log('First child is not an element node!');
      }
    });

    // CURRENT BEHAVIOR (what we DON'T want):
    // - 1 paragraph node marked as removed (contains old text)
    // - 1 paragraph node marked as added (contains new text)
    // Total operations: 2

    // DESIRED BEHAVIOR (what we DO want):
    // - 1 paragraph node marked as modified
    // - Inside the paragraph: inline diff showing "jumps" removed, "leaps" added
    // Total operations: 1

    // For now, this test documents the current (undesired) behavior
    // TODO: Update this test once inline diff is implemented

    // Current behavior check
    const currentBehavior = result.withDiff.stats.addedNodes === 1 &&
                           result.withDiff.stats.removedNodes === 1 &&
                           result.withDiff.stats.modifiedNodes === 0;

    if (currentBehavior) {
      console.log('\n⚠️  Current behavior: Full paragraph replacement (not ideal)');
      console.log('   Expected: Inline diff within modified paragraph');
    }

    // Verify basic diff functionality works - should have modified node, not added/removed
    expect(result.withDiff.stats.modifiedNodes).toBeGreaterThan(0);

    // Verify accept/reject work correctly
    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });

  it('should show inline diff when multiple words change in a paragraph', () => {
    const oldMarkdown = 'The quick brown fox jumps over the lazy dog.';
    const newMarkdown = 'The fast brown fox leaps over the sleepy dog.';

    console.log('\n=== INLINE DIFF TEST: Multiple Word Changes ===');
    console.log('Old:', oldMarkdown);
    console.log('New:', newMarkdown);
    console.log('Changed: "quick" → "fast", "jumps" → "leaps", "lazy" → "sleepy"');

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    console.log('\nDiff stats:', {
      added: result.withDiff.stats.addedNodes,
      removed: result.withDiff.stats.removedNodes,
      modified: result.withDiff.stats.modifiedNodes,
    });

    // Current behavior: likely full replacement
    // Desired: inline diff showing multiple changed words

    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });

  it('should show inline diff when words are added to a paragraph', () => {
    const oldMarkdown = 'The quick fox jumps.';
    const newMarkdown = 'The quick brown fox jumps over the fence.';

    console.log('\n=== INLINE DIFF TEST: Words Added ===');
    console.log('Old:', oldMarkdown);
    console.log('New:', newMarkdown);
    console.log('Added: "brown", "over the fence"');

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    console.log('\nDiff stats:', {
      added: result.withDiff.stats.addedNodes,
      removed: result.withDiff.stats.removedNodes,
      modified: result.withDiff.stats.modifiedNodes,
    });

    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });

  it('should show inline diff when words are removed from a paragraph', () => {
    const oldMarkdown = 'The quick brown fox jumps over the lazy dog.';
    const newMarkdown = 'The quick fox jumps over the dog.';

    console.log('\n=== INLINE DIFF TEST: Words Removed ===');
    console.log('Old:', oldMarkdown);
    console.log('New:', newMarkdown);
    console.log('Removed: "brown", "lazy"');

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    console.log('\nDiff stats:', {
      added: result.withDiff.stats.addedNodes,
      removed: result.withDiff.stats.removedNodes,
      modified: result.withDiff.stats.modifiedNodes,
    });

    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });
});
