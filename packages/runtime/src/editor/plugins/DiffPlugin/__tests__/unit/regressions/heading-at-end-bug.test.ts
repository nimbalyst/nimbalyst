/**
 * Test for heading appearing at end of document bug
 *
 * When adding a heading to the beginning of a document by replacing the first line,
 * the heading appears at the end of the document instead of at the beginning.
 *
 * Bug reproduction:
 * - Old: "All notable changes..."
 * - New: "# Crystal Changelog\n\nAll notable changes..."
 * - Expected: Heading at top
 * - Actual: Heading at bottom
 */

import {describe, expect, it} from 'vitest';
import {$getRoot} from 'lexical';
import {$isHeadingNode} from '@lexical/rich-text';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
} from '../../../../../markdown/index';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../../utils/testConfig';
import {applyMarkdownDiffToDocument} from '../../../core/diffUtils';
import {$getDiffState, $clearDiffState} from '../../../core/DiffState';
import {testComprehensiveDiff, printDiffReport} from '../../utils/comprehensiveDiffTester';

describe('Heading at end bug - heading appears at end instead of beginning', () => {
  it('should place added heading at beginning of document, not at end', () => {
    // Simple old markdown - just a paragraph at the start
    const oldMarkdown = `All notable changes to the Crystal application will be documented in this file.

## [0.3.3] - 2025-10-12

### Added
- Feature 1
- Feature 2

### Changed
- Change 1
- Change 2

## [0.3.2] - 2025-10-10

### Fixed
- Fix 1
- Fix 2
`;

    // New markdown - add H1 title before the first paragraph
    const newMarkdown = `# Crystal Changelog

All notable changes to the Crystal application will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2025-10-12

### Added
- Feature 1
- Feature 2

### Changed
- Change 1
- Change 2

## [0.3.2] - 2025-10-10

### Fixed
- Fix 1
- Fix 2
`;

    const editor = createTestHeadlessEditor();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\n=== HEADING AT END BUG TEST ===');

    // Apply diff
    applyMarkdownDiffToDocument(editor, oldMarkdown, newMarkdown, MARKDOWN_TEST_TRANSFORMERS);

    // Collect all nodes and their positions
    const allNodes: Array<{
      index: number;
      type: string;
      text: string;
      diffState: any;
      isHeading: boolean;
      headingTag?: string;
    }> = [];

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      children.forEach((child, index) => {
        const diffState = $getDiffState(child);
        const text = child.getTextContent();
        const isHeading = $isHeadingNode(child);
        const headingTag = isHeading ? child.getTag() : undefined;

        allNodes.push({
          index,
          type: child.getType(),
          text: text.substring(0, 60).replace(/\n/g, ' '),
          diffState,
          isHeading,
          headingTag,
        });
      });
    });

    console.log(`\nTotal nodes: ${allNodes.length}`);

    // Find the H1 "Crystal Changelog" heading
    const h1Node = allNodes.find(n =>
      n.isHeading &&
      n.headingTag === 'h1' &&
      n.text.includes('Crystal Changelog')
    );

    // Find the first H2 heading
    const firstH2 = allNodes.find(n =>
      n.isHeading &&
      n.headingTag === 'h2'
    );

    console.log('\n=== NODE POSITIONS ===');
    if (h1Node) {
      console.log(`H1 "Crystal Changelog" at index: ${h1Node.index} (diffState: ${h1Node.diffState})`);
    } else {
      console.log('H1 "Crystal Changelog" NOT FOUND!');
    }

    if (firstH2) {
      console.log(`First H2 "${firstH2.text}" at index: ${firstH2.index}`);
    }

    console.log('\n=== ADDED NODES ===');
    allNodes
      .filter(n => n.diffState === 'added')
      .forEach(n => {
        const icon = n.isHeading ? `📌 H${n.headingTag?.substring(1)}` : '➕';
        console.log(`[${n.index}] ${icon} ${n.type}: "${n.text}"`);
      });

    // Verify H1 exists
    expect(h1Node).toBeDefined();
    expect(h1Node?.diffState).toBe('added');

    // THE BUG: H1 should come BEFORE the first H2, not after it
    if (h1Node && firstH2) {
      console.log('\n=== BUG CHECK ===');
      console.log(`H1 index: ${h1Node.index}, H2 index: ${firstH2.index}`);
      console.log(`H1 before H2? ${h1Node.index < firstH2.index}`);

      if (h1Node.index > firstH2.index) {
        console.log('❌ BUG CONFIRMED: H1 appears AFTER H2 (at end of document)');
      } else {
        console.log('✓ H1 correctly appears before H2 (at beginning)');
      }

      expect(h1Node.index).toBeLessThan(firstH2.index);
    }

    // Additional check: H1 should be in the first few nodes (0-3)
    // Since we're adding it at the very beginning
    expect(h1Node?.index).toBeLessThanOrEqual(3);

    // Verify the final markdown structure
    let finalMarkdown = '';
    editor.getEditorState().read(() => {
      finalMarkdown = $convertToEnhancedMarkdownString(MARKDOWN_TEST_TRANSFORMERS);
    });

    console.log('\n=== FINAL MARKDOWN PREVIEW ===');
    console.log(finalMarkdown.substring(0, 300));

    // The H1 should appear within the first 100 characters
    const h1Position = finalMarkdown.indexOf('# Crystal Changelog');
    console.log(`\nH1 position in markdown: ${h1Position}`);
    expect(h1Position).toBeGreaterThanOrEqual(0);
    expect(h1Position).toBeLessThan(100);
  });

  it('should handle minimal case - adding H1 to simple document', () => {
    const oldMarkdown = `First paragraph.

Second paragraph.`;

    const newMarkdown = `# Title

First paragraph.

Second paragraph.`;

    const editor = createTestHeadlessEditor();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\n=== MINIMAL HEADING BUG TEST ===');

    applyMarkdownDiffToDocument(editor, oldMarkdown, newMarkdown, MARKDOWN_TEST_TRANSFORMERS);

    const allNodes: Array<{index: number; type: string; text: string; isHeading: boolean}> = [];

    editor.getEditorState().read(() => {
      const root = $getRoot();
      root.getChildren().forEach((child, index) => {
        allNodes.push({
          index,
          type: child.getType(),
          text: child.getTextContent(),
          isHeading: $isHeadingNode(child),
        });
      });
    });

    console.log(`\nTotal nodes: ${allNodes.length}`);
    allNodes.forEach(n => {
      const icon = n.isHeading ? '📌' : '  ';
      console.log(`[${n.index}] ${icon} ${n.type}: "${n.text}"`);
    });

    const h1 = allNodes.find(n => n.isHeading && n.text.includes('Title'));
    const firstPara = allNodes.find(n => n.text.includes('First paragraph'));

    console.log(`\nH1 index: ${h1?.index}`);
    console.log(`First paragraph index: ${firstPara?.index}`);

    expect(h1).toBeDefined();
    expect(h1!.index).toBeLessThan(firstPara!.index);
    expect(h1!.index).toBeLessThanOrEqual(1); // Should be at position 0 or 1
  });

  it('comprehensive workflow: verify diff application and structure', () => {
    const oldMarkdown = `All notable changes to the Crystal application will be documented in this file.

## [0.3.3] - 2025-10-12

### Added
- Feature 1
- Feature 2
`;

    const newMarkdown = `# Crystal Changelog

All notable changes to the Crystal application will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2025-10-12

### Added
- Feature 1
- Feature 2
`;

    const editor = createTestHeadlessEditor();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(oldMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, { discrete: true });

    console.log('\n=== COMPREHENSIVE DIFF APPLICATION TEST ===');

    // Apply diff
    console.log('\n--- Applying Diff ---');
    applyMarkdownDiffToDocument(editor, oldMarkdown, newMarkdown, MARKDOWN_TEST_TRANSFORMERS);

    // Verify H1 is at the beginning
    let h1Index = -1;
    let h2Index = -1;
    let addedCount = 0;
    let modifiedCount = 0;
    let removedCount = 0;

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      children.forEach((child, index) => {
        const diffState = $getDiffState(child);
        if (diffState === 'added') addedCount++;
        if (diffState === 'modified') modifiedCount++;
        if (diffState === 'removed') removedCount++;

        if ($isHeadingNode(child)) {
          if (child.getTag() === 'h1') {
            h1Index = index;
          } else if (child.getTag() === 'h2' && h2Index === -1) {
            h2Index = index;
          }
        }
      });
    });

    console.log(`\nH1 position: ${h1Index}`);
    console.log(`H2 position: ${h2Index}`);
    console.log(`Added nodes: ${addedCount}`);
    console.log(`Modified nodes: ${modifiedCount}`);
    console.log(`Removed nodes: ${removedCount}`);

    // Verify H1 is at the beginning (position 0 or 1)
    expect(h1Index).toBeLessThanOrEqual(1);
    expect(h1Index).toBeGreaterThanOrEqual(0);

    // Verify H1 comes before H2
    if (h2Index !== -1) {
      expect(h1Index).toBeLessThan(h2Index);
    }

    // Verify we have added nodes (the new H1 and paragraphs)
    expect(addedCount).toBeGreaterThan(0);

    console.log('✓ All verifications passed');
    console.log('\n=== TEST COMPLETE ===');
  });

  it('using comprehensive diff tester: full workflow with three editors', () => {
    const oldMarkdown = `All notable changes to the Crystal application will be documented in this file.

## [0.3.3] - 2025-10-12

### Added
- Feature 1
- Feature 2
`;

    const newMarkdown = `# Crystal Changelog

All notable changes to the Crystal application will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2025-10-12

### Added
- Feature 1
- Feature 2
`;

    console.log('\n=== COMPREHENSIVE DIFF TESTER ===');

    // Run comprehensive test - creates three editors
    const result = testComprehensiveDiff(oldMarkdown, newMarkdown);

    // Print detailed report
    console.log(printDiffReport(result));

    // Verify overall success
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);

    // Verify diff was applied correctly
    expect(result.withDiff.stats.addedNodes).toBeGreaterThan(0);
    console.log(`\nAdded nodes in diff state: ${result.withDiff.stats.addedNodes}`);

    // Verify H1 is at the beginning in diff state
    const h1InDiff = result.withDiff.nodes.find(n =>
      n.type === 'heading' && n.diffState === 'added' && n.text.includes('Crystal Changelog')
    );
    expect(h1InDiff).toBeDefined();
    expect(h1InDiff!.index).toBeLessThanOrEqual(1);
    console.log(`H1 position in diff: ${h1InDiff!.index}`);

    // Verify first H2 comes after H1
    const firstH2 = result.withDiff.nodes.find(n =>
      n.type === 'heading' && n.text.includes('[0.3.3]')
    );
    if (firstH2) {
      expect(h1InDiff!.index).toBeLessThan(firstH2.index);
      console.log(`First H2 position: ${firstH2.index}`);
    }

    // Verify accept path produces new markdown
    expect(result.acceptMatchesNew.matches).toBe(true);
    console.log('✓ Accept path matches new markdown');

    // Verify reject path produces old markdown
    expect(result.rejectMatchesOld.matches).toBe(true);
    console.log('✓ Reject path matches old markdown');

    // Verify accept cleared all diff states
    expect(result.afterAccept.stats.addedNodes).toBe(0);
    expect(result.afterAccept.stats.removedNodes).toBe(0);
    expect(result.afterAccept.stats.modifiedNodes).toBe(0);
    console.log('✓ Accept cleared all diff markers');

    // Verify reject cleared all diff states
    expect(result.afterReject.stats.addedNodes).toBe(0);
    expect(result.afterReject.stats.removedNodes).toBe(0);
    expect(result.afterReject.stats.modifiedNodes).toBe(0);
    console.log('✓ Reject cleared all diff markers');

    console.log('\n=== COMPREHENSIVE TEST COMPLETE ===');
  });
});
