import {describe, expect, it} from 'vitest';
import {testComprehensiveDiff} from '../../utils/comprehensiveDiffTester';

describe('Heading change in large document', () => {
  it('should handle apostrophe addition to first heading in large doc', () => {
    // Source markdown - larger document
    const sourceMarkdown = `# Main Title

Introduction paragraph.

## Section One

Content for section one.

- Item 1
- Item 2
- Item 3

## Section Two

Content for section two.

### Subsection A

More content here.

### Subsection B

Even more content.

## Section Three

Final section content.

- Point A
- Point B
- Point C

## Section Four

Last section.
`;

    // Target markdown - just add apostrophe to first heading
    const targetMarkdown = `# Main Title's

Introduction paragraph.

## Section One

Content for section one.

- Item 1
- Item 2
- Item 3

## Section Two

Content for section two.

### Subsection A

More content here.

### Subsection B

Even more content.

## Section Three

Final section content.

- Point A
- Point B
- Point C

## Section Four

Last section.
`;

    // Run comprehensive diff test
    const result = testComprehensiveDiff(sourceMarkdown, targetMarkdown);

    // Verify overall success
    expect(result.success).toBe(true);

    // With improved TreeMatcher, heading text changes are correctly marked as MODIFIED
    const modifiedHeadings = result.withDiff.nodes.filter(n =>
      n.type === 'heading' && n.diffState === 'modified'
    );
    expect(modifiedHeadings.length).toBeGreaterThanOrEqual(1);

    // Check that the modified heading contains the new text
    const mainHeading = modifiedHeadings.find(h => h.text.includes("Main Title"));
    expect(mainHeading).toBeDefined();
    expect(mainHeading!.text).toContain("Main Title's");

    // The modified heading should be near the start
    expect(mainHeading!.index).toBeLessThan(5);

    // CRITICAL: Verify accept produces new markdown with apostrophe
    expect(result.acceptMatchesNew.matches).toBe(true);
    expect(result.afterAccept.markdown).toContain("Main Title's");

    // CRITICAL: Verify reject produces old markdown without apostrophe
    expect(result.rejectMatchesOld.matches).toBe(true);
    expect(result.afterReject.markdown).toContain('# Main Title\n');
    expect(result.afterReject.markdown).not.toContain("Main Title's");

    // Check that other sections are NOT marked as changed
    const otherHeadingsChanged = result.withDiff.nodes.filter(n =>
      n.type === 'heading' &&
      n.diffState !== null &&
      (n.text.includes('Section One') ||
       n.text.includes('Section Two') ||
       n.text.includes('Section Three') ||
       n.text.includes('Section Four'))
    );

    expect(otherHeadingsChanged.length, 'Other sections should not be marked as changed').toBe(0);
  });
});
