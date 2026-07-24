/**
 * Example test using comprehensive diff tester
 *
 * This demonstrates the recommended pattern for writing diff tests.
 * The comprehensive tester creates three separate editors and verifies
 * the complete workflow automatically.
 */

import {describe, expect, it} from 'vitest';
import {testComprehensiveDiff, printDiffReport} from '../../utils/comprehensiveDiffTester';

describe('Comprehensive Diff Testing Pattern', () => {
  it('example: adding a heading at the beginning', () => {
    const oldMarkdown = `First paragraph of content.

Second paragraph here.`;

    const newMarkdown = `# Document Title

First paragraph of content.

Second paragraph here.`;

    // Run comprehensive test - creates three editors automatically
    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    // Print detailed report for debugging (optional)
    if (!result.success) {
      console.log(printDiffReport(result));
    }

    // Verify the workflow succeeded
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);

    // Verify diff was applied correctly
    expect(result.withDiff.stats.addedNodes).toBe(2); // H1 + empty paragraph
    expect(result.withDiff.stats.modifiedNodes).toBe(0);
    expect(result.withDiff.stats.removedNodes).toBe(0);

    // Find the added heading
    const addedHeading = result.withDiff.nodes.find(n =>
      n.type === 'heading' && n.diffState === 'added'
    );
    expect(addedHeading).toBeDefined();
    expect(addedHeading!.text).toContain('Document Title');

    // Verify heading is at the beginning
    expect(addedHeading!.index).toBeLessThanOrEqual(1);

    // Verify accept produces new markdown
    expect(result.acceptMatchesNew.matches).toBe(true);

    // Verify reject produces old markdown
    expect(result.rejectMatchesOld.matches).toBe(true);

    // Verify diff markers cleared after accept
    expect(result.afterAccept.stats.addedNodes).toBe(0);
    expect(result.afterAccept.stats.removedNodes).toBe(0);

    // Verify diff markers cleared after reject
    expect(result.afterReject.stats.addedNodes).toBe(0);
    expect(result.afterReject.stats.removedNodes).toBe(0);
  });

  it('example: removing a paragraph', () => {
    const oldMarkdown = `# Title

First paragraph.

Second paragraph to remove.

Third paragraph.`;

    const newMarkdown = `# Title

First paragraph.

Third paragraph.`;

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    expect(result.success).toBe(true);

    // Verify removal was detected
    expect(result.withDiff.stats.removedNodes).toBeGreaterThan(0);

    // Find removed paragraph
    const removedPara = result.withDiff.nodes.find(n =>
      n.diffState === 'removed' && n.text.includes('Second paragraph')
    );
    expect(removedPara).toBeDefined();

    // Verify accept/reject workflow
    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });

  it('example: modifying text in a paragraph', () => {
    const oldMarkdown = `This is the original text.`;

    const newMarkdown = `This is the modified text with changes.`;

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    expect(result.success).toBe(true);

    // Verify modification was detected
    expect(result.withDiff.stats.modifiedNodes).toBeGreaterThan(0);

    // Verify accept/reject workflow
    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });

  it('example: complex multi-change document', () => {
    const oldMarkdown = `# Original Title

Some content here.

## Section A

Content in section A.

## Section B

Content in section B.`;

    const newMarkdown = `# Updated Title

Some content here.

New paragraph added.

## Section A

Modified content in section A with more details.

## Section B

Content in section B.

## Section C

Brand new section.`;

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    // Print report if there are issues
    if (!result.success) {
      console.log(printDiffReport(result));
    }

    expect(result.success).toBe(true);

    // Verify multiple changes detected
    expect(result.withDiff.stats.addedNodes).toBeGreaterThan(0);
    expect(result.withDiff.stats.modifiedNodes).toBeGreaterThan(0);

    // Can inspect specific nodes if needed
    const sectionC = result.withDiff.nodes.find(n =>
      n.type === 'heading' && n.text.includes('Section C')
    );
    expect(sectionC).toBeDefined();
    expect(sectionC!.diffState).toBe('added');

    // Verify full workflow
    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });

  it('example: further incremental changes after accept', () => {
    const v1 = `# Version 1`;
    const v2 = `# Version 2\n\nAdded content.`;
    const v3 = `# Version 3\n\nAdded content.\n\nMore content.`;

    // First diff: v1 → v2
    const result1 = testComprehensiveDiff(v1, v2);
    expect(result1.success).toBe(true);

    // After accepting v1→v2, the editor has v2
    // Now we can use that editor for the next diff
    const result2 = testComprehensiveDiff(v2, v3);
    expect(result2.success).toBe(true);

    // Verify incremental changes
    expect(result2.withDiff.stats.addedNodes).toBeGreaterThan(0);
    expect(result2.acceptMatchesNew.matches).toBe(true);
  });
});
