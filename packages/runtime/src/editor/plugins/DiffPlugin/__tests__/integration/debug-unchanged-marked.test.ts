/**
 * Debug test to reproduce the issue where unchanged content is marked as changed
 */

import {describe, it} from 'vitest';
import {$getRoot} from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
} from '../../../../markdown';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../utils/testConfig';
import {applyMarkdownDiffToDocument} from '../../core/diffUtils';
import {collectDiffNodes, generateDiffReport} from './diffTestFramework';

describe('Debug: Unchanged Content Marked as Changed', () => {
  it('should show what gets marked when only small changes exist', () => {
    // Simulate a document where we add one risk entry but other risks are unchanged
    const oldMarkdown = `# Risks and Mitigation

**Risk**: Zhang-Shasha might be slow on large documents
**Mitigation**: Profile with 500+ node documents, optimize if needed

**Risk**: Tree structure conversion might be complex
**Mitigation**: Start with simple cases, add complexity incrementally

**Risk**: Tests might not catch all edge cases
**Mitigation**: Systematic matrix ensures comprehensive coverage
`;

    const newMarkdown = `# Risks and Mitigation

**Risk**: Zhang-Shasha might be slow on large documents
**Mitigation**: Profile with 500+ node documents, optimize if needed

**Risk**: Tree structure conversion might be complex
**Mitigation**: Start with simple cases, add complexity incrementally

**Risk**: Tests might not catch all edge cases
**Mitigation**: Systematic matrix ensures comprehensive coverage

**Risk**: Performance regression on large diffs
**Mitigation**: Benchmark before and after algorithm changes
`;

    const editor = createTestHeadlessEditor();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\n=== BEFORE APPLYING DIFF ===');
    const nodesBefore = collectDiffNodes(editor);
    console.log(`Total nodes: ${nodesBefore.length}`);

    // Apply diff
    applyMarkdownDiffToDocument(editor, oldMarkdown, newMarkdown, MARKDOWN_TEST_TRANSFORMERS);

    console.log('\n=== AFTER APPLYING DIFF ===');
    const nodesAfter = collectDiffNodes(editor);
    console.log(generateDiffReport(nodesAfter));

    // Export to see what's in the editor
    let afterMarkdown = '';
    editor.getEditorState().read(() => {
      afterMarkdown = $convertToEnhancedMarkdownString(MARKDOWN_TEST_TRANSFORMERS);
    });

    console.log('\n=== EXPORTED MARKDOWN ===');
    console.log(afterMarkdown.substring(0, 500));

    // Count unchanged vs changed
    const unchangedCount = nodesAfter.filter(n => n.diffState === null).length;
    const modifiedCount = nodesAfter.filter(n => n.diffState === 'modified').length;
    const addedCount = nodesAfter.filter(n => n.diffState === 'added').length;

    console.log(`\n=== SUMMARY ===`);
    console.log(`Unchanged: ${unchangedCount} (should be most of them)`);
    console.log(`Modified: ${modifiedCount} (should be 0 or very few)`);
    console.log(`Added: ${addedCount} (should be 2 for the new risk)`);
  });

  it('should test exact match with bold formatting', () => {
    const oldMarkdown = `**Risk**: Something
**Mitigation**: Do it
`;

    const newMarkdown = `**Risk**: Something
**Mitigation**: Do it

**Risk**: New thing
`;

    const editor = createTestHeadlessEditor();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    applyMarkdownDiffToDocument(editor, oldMarkdown, newMarkdown, MARKDOWN_TEST_TRANSFORMERS);

    const nodesAfter = collectDiffNodes(editor);
    console.log('\n=== BOLD TEXT TEST ===');
    console.log(generateDiffReport(nodesAfter));
  });
});
