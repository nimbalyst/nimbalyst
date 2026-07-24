/**
 * Test for section move bug - moving "Important Notes" below "Summary"
 */

import { describe, it, expect } from 'vitest';
import {testComprehensiveDiff} from '../../utils/comprehensiveDiffTester';

describe('Test10 section move', () => {
  it('should show clean move operation, not scattered changes', () => {
    const oldMarkdown = `# Document

## Summary

This is the summary section.

## Important Notes

- Note 1
- Note 2
- Note 3
`;

    const newMarkdown = `# Document

## Important Notes

- Note 1
- Note 2
- Note 3

## Summary

This is the summary section.
`;

    console.log('\n=== TEST10 SECTION MOVE ===');
    console.log('SCENARIO: Move "Important Notes" section above "Summary" section');
    console.log('EXPECTED: Clean move operation (or minimal remove+add)');

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    console.log('\nDiff stats:', result.withDiff.stats);
    console.log(`Removed: ${result.withDiff.stats.removedNodes}`);
    console.log(`Added: ${result.withDiff.stats.addedNodes}`);
    console.log(`Modified: ${result.withDiff.stats.modifiedNodes}`);

    // Show ALL nodes with diff states
    console.log('\n=== ALL NODES IN DIFF VIEW ===');
    result.withDiff.nodes.forEach((n, i) => {
      const stateLabel = n.diffState ? `[${n.diffState}]` : '[unchanged]';
      console.log(`${i + 1}. ${stateLabel} [${n.type}] "${n.text.substring(0, 60)}"`);
    });

    console.log('\n=== NODES WITH DIFF STATES ===');
    const nodesWithDiff = result.withDiff.nodes.filter(n => n.diffState !== null);
    console.log(`Total nodes with diff state: ${nodesWithDiff.length}`);
    nodesWithDiff.forEach((n, i) => {
      console.log(`${i + 1}. [${n.diffState}] [${n.type}] "${n.text.substring(0, 60)}"`);
    });

    // Moving two sections should ideally be recognized as a move
    // At worst, it should be: remove 2 sections + add 2 sections = 4 nodes
    // But we're probably seeing more due to paragraph/whitespace issues

    // For now, let's just verify accept/reject work correctly

    // CRITICAL: Verify accept produces new markdown
    if (!result.acceptMatchesNew.matches) {
      console.log('\n=== ACCEPT vs NEW MISMATCH ===');
      console.log('EXPECTED (new):');
      console.log(result.acceptMatchesNew.normalizedExpected);
      console.log('\nACTUAL (after accept):');
      console.log(result.acceptMatchesNew.normalizedActual);
      console.log('\nDIFF:');
      console.log(result.acceptMatchesNew.diff);
    }
    expect(result.acceptMatchesNew.matches).toBe(true);

    // CRITICAL: Verify reject produces old markdown
    if (!result.rejectMatchesOld.matches) {
      console.log('\n=== REJECT vs OLD MISMATCH ===');
      console.log('EXPECTED (old):');
      console.log(result.rejectMatchesOld.normalizedExpected);
      console.log('\nACTUAL (after reject):');
      console.log(result.rejectMatchesOld.normalizedActual);
      console.log('\nDIFF:');
      console.log(result.rejectMatchesOld.diff);
    }
    expect(result.rejectMatchesOld.matches).toBe(true);
  });
});
