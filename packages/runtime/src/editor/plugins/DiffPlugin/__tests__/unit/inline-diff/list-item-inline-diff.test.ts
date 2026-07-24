/**
 * Test inline diff for list items
 * Verify that list items use inline diff just like paragraphs
 */

import {describe, expect, it} from 'vitest';
import {testComprehensiveDiff} from '../../utils/comprehensiveDiffTester';
import {$getRoot, $isElementNode} from 'lexical';
import {$getDiffState} from '../../../core/DiffState';

describe('Inline diff - list items', () => {
  it('should show inline diff when one word changes in a list item', () => {
    const oldMarkdown = '- The quick brown fox jumps over the lazy dog.';
    const newMarkdown = '- The quick brown fox leaps over the lazy dog.';

    console.log('\n=== LIST ITEM INLINE DIFF TEST ===');
    console.log('Old:', oldMarkdown);
    console.log('New:', newMarkdown);
    console.log('Changed: "jumps" → "leaps"');

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    console.log('\nDiff stats:', {
      added: result.withDiff.stats.addedNodes,
      removed: result.withDiff.stats.removedNodes,
      modified: result.withDiff.stats.modifiedNodes,
    });

    // Inspect the list item structure
    console.log('\nList item structure:');
    result.withDiff.editor.getEditorState().read(() => {
      const root = $getRoot();
      const list = root.getFirstChild();

      if (list && $isElementNode(list)) {
        console.log(`List has ${list.getChildrenSize()} items`);
        const listItem = list.getFirstChild();

        if (listItem && $isElementNode(listItem)) {
          const diffState = $getDiffState(listItem);
          console.log(`ListItem diffState: ${diffState}`);

          const children = listItem.getChildren();
          console.log(`ListItem has ${children.length} child nodes:`);

          children.forEach((child: any, i: number) => {
            const childDiffState = $getDiffState(child);
            const text = child.getTextContent();
            console.log(`  ${i}: type=${child.getType()} [${childDiffState || 'null'}] "${text}"`);
          });
        }
      }
    });

    // List item should be marked as modified (not added/removed)
    expect(result.withDiff.stats.modifiedNodes).toBeGreaterThan(0);

    // Verify accept/reject work
    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });

  it('should show inline diff for multiple list items with changes', () => {
    const oldMarkdown = `- Item one with original text
- Item two stays the same
- Item three with different content`;

    const newMarkdown = `- Item one with modified text
- Item two stays the same
- Item three with updated content`;

    console.log('\n=== MULTIPLE LIST ITEMS TEST ===');

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    console.log('\nDiff stats:', {
      added: result.withDiff.stats.addedNodes,
      removed: result.withDiff.stats.removedNodes,
      modified: result.withDiff.stats.modifiedNodes,
    });

    // Should have some modified nodes (the changed list items)
    expect(result.withDiff.stats.modifiedNodes).toBeGreaterThan(0);

    // Should have accept/reject work correctly
    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });
});
