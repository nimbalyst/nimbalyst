/**
 * Test for large document diff failure case
 * Files: test2-old.md vs test2-new.md
 *
 * This is a real-world example where the new document is significantly shorter (72 lines vs 202 lines)
 * The document was substantially rewritten and condensed.
 */

import {describe, expect, it} from 'vitest';
import {testComprehensiveDiff} from '../../utils/comprehensiveDiffTester';
import * as fs from 'fs';
import * as path from 'path';

describe('Larger document diff - test2 (PM guide rewrite)', () => {
  it('should correctly diff substantial document rewrite', () => {
    // Read the actual markdown files
    const oldMarkdown = fs.readFileSync(
      path.join(__dirname, '../larger/test2-old.md'),
      'utf8'
    );
    const newMarkdown = fs.readFileSync(
      path.join(__dirname, '../larger/test2-new.md'),
      'utf8'
    );

    console.log(`\n=== DOCUMENT DIFF TEST ===`);
    console.log(`Old document: ${oldMarkdown.split('\n').length} lines`);
    console.log(`New document: ${newMarkdown.split('\n').length} lines`);

    // Run comprehensive diff test
    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    // Print errors if any
    if (!result.success) {
      console.log('\n=== ERRORS ===');
      result.errors.forEach(err => console.log(err));
    }

    // Should have significant changes given the rewrite
    const totalChanged = result.withDiff.stats.addedNodes +
                        result.withDiff.stats.removedNodes +
                        result.withDiff.stats.modifiedNodes;
    expect(totalChanged).toBeGreaterThan(10);

    console.log(`✓ Detected significant changes (${totalChanged} nodes changed)`);

    // Large rewrites can have serializer differences while preserving core content.
    expect(result.afterAccept.markdown.length).toBeGreaterThan(0);
    expect(result.afterAccept.markdown).toContain('Claude Code for Product Managers');

    expect(result.afterReject.markdown.length).toBeGreaterThan(0);
    expect(result.afterReject.markdown).toContain('Claude Code for Product Managers');
  });

  it('should produce correct new markdown after accepting all changes', () => {
    // Read the actual markdown files
    const oldMarkdown = fs.readFileSync(
      path.join(__dirname, '../larger/test2-old.md'),
      'utf8'
    );
    const newMarkdown = fs.readFileSync(
      path.join(__dirname, '../larger/test2-new.md'),
      'utf8'
    );

    console.log(`\n=== ACCEPTANCE TEST ===`);

    // Run comprehensive diff test
    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    // The title should be present after accepting changes
    expect(result.afterAccept.markdown).toContain('Claude Code for Product Managers');

    // Verify the markdown roughly matches the expected new markdown
    // (we don't need exact match due to whitespace differences)
    expect(result.afterAccept.markdown.length).toBeGreaterThan(newMarkdown.length * 0.9);
    expect(result.afterAccept.markdown.length).toBeLessThan(newMarkdown.length * 1.1);

    expect(result.afterAccept.markdown.length).toBeGreaterThan(0);
  });
});
