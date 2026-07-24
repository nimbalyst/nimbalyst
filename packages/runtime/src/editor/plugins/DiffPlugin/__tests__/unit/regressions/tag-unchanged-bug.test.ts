/**
 * Test for HashtagNode unchanged bug
 *
 * Bug: HashtagNode instances (#idea, #Task, #Bug) are incorrectly identified as
 * removed+added (shown as red+green) when they are identical between old and new versions.
 *
 * Root cause: HashtagNode extends TextNode, which has attributes like `detail`, `format`,
 * and `mode` that are included in the diff comparison via extractAttrs(). These attributes
 * can differ between old and new hashtag nodes even when the text content is identical,
 * causing the nodes to be seen as different.
 *
 * Expected: Identical HashtagNodes should match and not appear in diff output.
 */

import { describe, it, expect } from 'vitest';
import { testComprehensiveDiff } from '../../utils/comprehensiveDiffTester';

describe('Simple hashtag unchanged bug', () => {
  it('should not show removed+added for unchanged paragraph with #idea', () => {
    // EXACT text from the user
    const oldMarkdown = `# Hashtag

I have an #idea about how to implement GitHub integrations.

We would use an MCP server.
`;

    const newMarkdown = `# Hashtag

I have an #idea about how to implement GitHub integrations.

We would use an API.
`;

    console.log('\n=== EXACT USER BUG TEST ===');
    console.log('Only "MCP server" → "API" changed');
    console.log('Bug: The #idea paragraph shows as removed+added instead of unchanged');

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    console.log('\nDiff stats:');
    console.log(`  Added: ${result.withDiff.stats.addedNodes}`);
    console.log(`  Removed: ${result.withDiff.stats.removedNodes}`);
    console.log(`  Modified: ${result.withDiff.stats.modifiedNodes}`);
    console.log(`  Unchanged: ${result.withDiff.stats.unchangedNodes}`);

    // Find all nodes with diff state
    const nodesWithDiff = result.withDiff.nodes.filter(n => n.diffState !== null);

    console.log('\nAll nodes with diff state:');
    nodesWithDiff.forEach(n => {
      console.log(`  [${n.diffState}] [${n.type}] "${n.textPreview}"`);
    });

    // The bug from the screenshot: The paragraph "I have an #idea..." appears TWICE:
    // - Once as "removed" (red)
    // - Once as "added" (green)
    // Even though it's IDENTICAL in both old and new versions
    const ideaRemoved = nodesWithDiff.filter(n =>
      n.diffState === 'removed' && n.text?.includes('#idea')
    );
    const ideaAdded = nodesWithDiff.filter(n =>
      n.diffState === 'added' && n.text?.includes('#idea')
    );

    if (ideaRemoved.length > 0 || ideaAdded.length > 0) {
      console.log('\n❌ BUG CONFIRMED: Unchanged paragraph with #idea shown as removed+added!');
      if (ideaRemoved.length > 0) {
        console.log('  Incorrectly marked as REMOVED:', ideaRemoved[0].textPreview);
      }
      if (ideaAdded.length > 0) {
        console.log('  Incorrectly marked as ADDED:', ideaAdded[0].textPreview);
      }
    }

    // EXPECTED: The identical #idea paragraph should NOT appear in diff nodes at all
    // Only the "We would use..." paragraph should be marked as changed
    expect(ideaRemoved.length).toBe(0);
    expect(ideaAdded.length).toBe(0);

    // After reject and accept, should still match correctly
    expect(result.rejectMatchesOld.matches).toBe(true);
    expect(result.acceptMatchesNew.matches).toBe(true);
  });

  it('should not mark simple #Idea hashtag as changed', () => {
    const markdown = `#Idea This is just a simple idea`;

    console.log('\n=== SIMPLE #Idea HASHTAG TEST ===');

    const result = testComprehensiveDiff(markdown, markdown);

    const nodesWithDiff = result.withDiff.nodes.filter(n => n.diffState !== null);

    if (nodesWithDiff.length > 0) {
      console.log('\n❌ INCORRECTLY MARKED AS CHANGED:');
      nodesWithDiff.forEach(n => {
        console.log(`  [${n.diffState}] [${n.type}] "${n.textPreview}"`);
      });
    }

    expect(nodesWithDiff.length).toBe(0);
  });

  it('should handle actual changes with hashtags correctly', () => {
    const oldMarkdown = `- Item with #Task hashtag`;
    const newMarkdown = `- Different item with #Task hashtag`;

    console.log('\n=== ACTUAL CHANGE WITH HASHTAG TEST ===');

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    const hasChanges = result.withDiff.stats.addedNodes > 0 ||
                      result.withDiff.stats.removedNodes > 0 ||
                      result.withDiff.stats.modifiedNodes > 0;

    expect(hasChanges).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
    expect(result.acceptMatchesNew.matches).toBe(true);
  });
});
