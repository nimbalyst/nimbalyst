/**
 * Test matching the exact scenario from the screenshot
 */

import {describe, it} from 'vitest';
import {$getRoot} from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
} from '../../../../markdown';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../utils/testConfig';
import {applyMarkdownDiffToDocument} from '../../core/diffUtils';
import {collectDiffNodes, generateDiffReport} from './diffTestFramework';

describe('Screenshot Scenario Test', () => {
  it('should not mark identical risk entries as modified', () => {
    // This is the EXACT content from the screenshot
    const oldMarkdown = `# Risks and Mitigation

**Risk:** Zhang-Shasha might be slow on large documents
**Mitigation:** Profile with 500+ node documents, optimize if needed

**Risk:** Tree structure conversion might be complex
**Mitigation:** Start with simple cases, add complexity incrementally

**Risk:** Tests might not catch all edge cases
**Mitigation:** Systematic matrix ensures comprehensive coverage
`;

    // Same content - NO CHANGES
    const newMarkdown = oldMarkdown;

    const editor = createTestHeadlessEditor();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\n=== IDENTICAL DOCUMENTS TEST ===');

    // Apply diff (should find NO differences)
    applyMarkdownDiffToDocument(editor, oldMarkdown, newMarkdown, MARKDOWN_TEST_TRANSFORMERS);

    const nodesAfter = collectDiffNodes(editor);
    const report = generateDiffReport(nodesAfter);

    console.log(report);

    const stats = {
      added: nodesAfter.filter(n => n.diffState === 'added').length,
      removed: nodesAfter.filter(n => n.diffState === 'removed').length,
      modified: nodesAfter.filter(n => n.diffState === 'modified').length,
      unchanged: nodesAfter.filter(n => n.diffState === null).length,
    };

    console.log('\n=== RESULTS ===');
    console.log(`Added: ${stats.added} (should be 0)`);
    console.log(`Removed: ${stats.removed} (should be 0)`);
    console.log(`Modified: ${stats.modified} (should be 0)`);
    console.log(`Unchanged: ${stats.unchanged} (should be ALL nodes)`);

    if (stats.modified > 0) {
      console.log('\n❌ IDENTICAL CONTENT IS BEING MARKED AS MODIFIED!');
      nodesAfter.filter(n => n.diffState === 'modified').forEach(n => {
        console.log(`  - ${n.type}: "${n.text.substring(0, 50)}"`);
      });
    } else {
      console.log('\n✓ All identical content correctly unmarked');
    }

    // These should all be 0 for identical documents
    if (stats.added !== 0) throw new Error(`Expected 0 added, got ${stats.added}`);
    if (stats.removed !== 0) throw new Error(`Expected 0 removed, got ${stats.removed}`);
    if (stats.modified !== 0) throw new Error(`Expected 0 modified, got ${stats.modified}`);
  });

  it('should test with ONE small change added', () => {
    const oldMarkdown = `# Risks and Mitigation

**Risk:** Zhang-Shasha might be slow on large documents
**Mitigation:** Profile with 500+ node documents, optimize if needed

**Risk:** Tree structure conversion might be complex
**Mitigation:** Start with simple cases, add complexity incrementally

**Risk:** Tests might not catch all edge cases
**Mitigation:** Systematic matrix ensures comprehensive coverage
`;

    // Add ONE new risk at the end
    const newMarkdown = oldMarkdown + `
**Risk:** New risk added
**Mitigation:** Handle it properly
`;

    const editor = createTestHeadlessEditor();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\n=== ONE CHANGE ADDED TEST ===');

    applyMarkdownDiffToDocument(editor, oldMarkdown, newMarkdown, MARKDOWN_TEST_TRANSFORMERS);

    const nodesAfter = collectDiffNodes(editor);
    const report = generateDiffReport(nodesAfter);

    console.log(report);

    const stats = {
      added: nodesAfter.filter(n => n.diffState === 'added').length,
      removed: nodesAfter.filter(n => n.diffState === 'removed').length,
      modified: nodesAfter.filter(n => n.diffState === 'modified').length,
      unchanged: nodesAfter.filter(n => n.diffState === null).length,
    };

    console.log('\n=== RESULTS ===');
    console.log(`Added: ${stats.added} (should be ~2-3 for new risk)`);
    console.log(`Removed: ${stats.removed} (should be 0)`);
    console.log(`Modified: ${stats.modified} (should be 0 - old risks unchanged!)`);
    console.log(`Unchanged: ${stats.unchanged} (should be most nodes)`);

    if (stats.modified > 0) {
      console.log('\n❌ OLD CONTENT IS BEING MARKED AS MODIFIED!');
      nodesAfter.filter(n => n.diffState === 'modified').forEach(n => {
        console.log(`  - ${n.type}: "${n.text.substring(0, 50)}"`);
      });
    }

    // OLD content should NOT be modified
    if (stats.modified !== 0) throw new Error(`Expected 0 modified, got ${stats.modified} - old content should be unchanged!`);
  });
});
