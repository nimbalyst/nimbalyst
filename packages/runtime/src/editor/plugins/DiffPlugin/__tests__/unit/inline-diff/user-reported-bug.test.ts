/**
 * Test case from user's screenshot showing full paragraph replacement
 * instead of inline diff
 */

import {describe, expect, it} from 'vitest';
import {testComprehensiveDiff} from '../../utils/comprehensiveDiffTester';
import {$getRoot, $isElementNode} from 'lexical';
import {$getDiffState} from '../../../core/DiffState';

describe('User reported bug - paragraph replacement instead of inline diff', () => {
  it('should use inline diff for paragraph 1 (sample → modified sample)', () => {
    const oldMarkdown = 'This is the first paragraph with some sample text that we will modify later. It contains multiple sentences to make the changes more interesting.';
    const newMarkdown = 'This is the first paragraph with some modified sample text that we will modify later. It contains multiple sentences to make the changes more interesting.';

    console.log('\n=== PARAGRAPH 1 TEST ===');
    console.log('Changed: "sample" → "modified sample"');

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    console.log('\nDiff stats:', {
      added: result.withDiff.stats.addedNodes,
      removed: result.withDiff.stats.removedNodes,
      modified: result.withDiff.stats.modifiedNodes,
    });

    // Check what actually happened
    result.withDiff.editor.getEditorState().read(() => {
      const root = $getRoot();
      const children = root.getChildren();

      console.log(`\nRoot has ${children.length} children:`);
      children.forEach((child, i) => {
        const diffState = $getDiffState(child);
        const text = child.getTextContent().substring(0, 60);
        console.log(`  ${i}: type=${child.getType()} diffState=[${diffState}] "${text}..."`);

        if ($isElementNode(child)) {
          const grandchildren = child.getChildren();
          console.log(`     Has ${grandchildren.length} children:`);
          grandchildren.forEach((gc: any, j: number) => {
            const gcDiffState = $getDiffState(gc);
            const gcText = gc.getTextContent().substring(0, 30);
            console.log(`       ${j}: [${gcDiffState || 'null'}] "${gcText}"`);
          });
        }
      });
    });

    // EXPECTED: 1 paragraph marked as "modified" with inline diff
    // NOT: 2 paragraphs (1 removed, 1 added)

    if (result.withDiff.stats.addedNodes > 0 && result.withDiff.stats.removedNodes > 0) {
      console.log('\n❌ BUG: Using full replacement (remove + add) instead of inline diff');
    } else if (result.withDiff.stats.modifiedNodes > 0) {
      console.log('\n✓ Using inline diff (paragraph marked as modified)');
    }

    // Test fails if we're doing full replacement
    expect(result.withDiff.stats.modifiedNodes).toBeGreaterThan(0);
    expect(result.withDiff.stats.addedNodes).toBe(0);
    expect(result.withDiff.stats.removedNodes).toBe(0);
  });

  it('should use inline diff for paragraph 2 (second/different → second/updated different)', () => {
    const oldMarkdown = 'This is the second paragraph with different content. We will apply changes to this text as well to test the diff system.';
    const newMarkdown = 'This is the second paragraph with updated different content. We will apply changes to this text as well to test the diff system.';

    console.log('\n=== PARAGRAPH 2 TEST ===');
    console.log('Changed: "different" → "updated different"');

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    console.log('\nDiff stats:', {
      added: result.withDiff.stats.addedNodes,
      removed: result.withDiff.stats.removedNodes,
      modified: result.withDiff.stats.modifiedNodes,
    });

    // Test fails if we're doing full replacement
    expect(result.withDiff.stats.modifiedNodes).toBeGreaterThan(0);
    expect(result.withDiff.stats.addedNodes).toBe(0);
    expect(result.withDiff.stats.removedNodes).toBe(0);
  });
});
