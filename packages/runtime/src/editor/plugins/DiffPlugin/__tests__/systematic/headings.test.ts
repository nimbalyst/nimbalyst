/**
 * Systematic tests for heading modifications
 * Tests: add, remove, modify headings at various levels
 */

import {describe, expect, it} from 'vitest';
import {testComprehensiveDiff} from '../utils/comprehensiveDiffTester';

describe('Heading modifications', () => {
  it('should handle simple heading text change', () => {
    const oldMarkdown = `# Title\n\nContent here.\n`;
    const newMarkdown = `# Title's\n\nContent here.\n`;

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    // Verify overall success
    expect(result.success).toBe(true);

    // With improved matching, heading text changes are marked as MODIFIED
    const modifiedHeadings = result.withDiff.nodes.filter(n =>
      n.type === 'heading' && n.diffState === 'modified'
    );
    expect(modifiedHeadings.length).toBeGreaterThanOrEqual(1);

    // CRITICAL: Verify accept produces new markdown
    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.afterAccept.markdown).toContain("Title's");

    // CRITICAL: Verify reject produces old markdown
    expect(result.rejectMatchesOld.matches).toBe(true);
    expect(result.afterReject.markdown).toContain('# Title');
    expect(result.afterReject.markdown).not.toContain("Title's");
  });

  it('should handle heading in larger document', () => {
    const oldMarkdown = `# Main Title

Intro paragraph.

## Section One

Content.

## Section Two

More content.

## Section Three

Final content.
`;
    const newMarkdown = `# Main Title's

Intro paragraph.

## Section One

Content.

## Section Two

More content.

## Section Three

Final content.
`;

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    // Verify overall success
    expect(result.success).toBe(true);

    // With improved matching, heading text changes are marked as MODIFIED
    const modifiedHeadings = result.withDiff.nodes.filter(n =>
      n.type === 'heading' && n.diffState === 'modified'
    );
    expect(modifiedHeadings.length).toBeGreaterThanOrEqual(1);

    // The modified heading should be near the start
    const modifiedPos = modifiedHeadings[0].index;
    expect(modifiedPos, 'Should be near start').toBeLessThan(5);

    // CRITICAL: Verify accept produces new markdown
    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.afterAccept.markdown).toContain("Main Title's");

    // CRITICAL: Verify reject produces old markdown
    expect(result.rejectMatchesOld.matches).toBe(true);
    expect(result.afterReject.markdown).toContain('# Main Title');
    expect(result.afterReject.markdown).not.toContain("Main Title's");
  });

  it('should handle adding a heading', () => {
    const oldMarkdown = `Content here.\n`;
    const newMarkdown = `# New Title\n\nContent here.\n`;

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    // Verify success
    expect(result.success).toBe(true);

    // Should have one added heading
    const addedHeadings = result.withDiff.nodes.filter(n =>
      n.type === 'heading' && n.diffState === 'added'
    );
    expect(addedHeadings.length).toBe(1);
    expect(addedHeadings[0].text).toContain('New Title');

    // Verify accept/reject work
    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });

  it('should handle removing a heading', () => {
    const oldMarkdown = `# Old Title\n\nContent here.\n`;
    const newMarkdown = `Content here.\n`;

    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    // Verify success
    expect(result.success).toBe(true);

    // Should have one removed heading
    const removedHeadings = result.withDiff.nodes.filter(n =>
      n.type === 'heading' && n.diffState === 'removed'
    );
    expect(removedHeadings.length).toBe(1);
    expect(removedHeadings[0].text).toContain('Old Title');

    // Verify accept/reject work
    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.rejectMatchesOld.matches).toBe(true);
  });
});
