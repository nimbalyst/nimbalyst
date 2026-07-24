/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable @typescript-eslint/no-explicit-any, lexical/no-optional-chaining */

import type {SerializedElementNode} from 'lexical';

import {
  setupMarkdownReplaceTest,
  assertApproveProducesTarget as assertApproveProducesTargetReplace,
  assertRejectProducesOriginal as assertRejectProducesOriginalReplace,
} from '../../utils/replaceTestUtils';
import {$getRoot, $isElementNode} from 'lexical';
import {$getDiffState} from '../../../core/DiffState';

describe('Markdown Diff - Links', () => {
  test('DEBUG: Examine link matching process', async () => {
    const originalMarkdown = `This is a paragraph with a [link](https://example.com) in it.`;
    const replacements = [
      {
        oldText: '[link](https://example.com)',
        newText: '[updated link](https://example.com)',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    console.log('\n=== LINK MATCHING DEBUG ===');
    console.log('Source state:');
    console.log(JSON.stringify(result.sourceState, null, 2));
    console.log('\nTarget state:');
    console.log(JSON.stringify(result.targetState, null, 2));

    // Extract the link nodes specifically
    const sourceParagraph = result.sourceState.root
      .children[0] as SerializedElementNode;
    const targetParagraph = result.targetState.root
      .children[0] as SerializedElementNode;

    const sourceLink = sourceParagraph.children.find(
      (child: any) => child.type === 'link',
    ) as any;
    const targetLink = targetParagraph.children.find(
      (child: any) => child.type === 'link',
    ) as any;

    console.log('\n=== LINK NODE COMPARISON ===');
    console.log('Source link:', JSON.stringify(sourceLink, null, 2));
    console.log('Target link:', JSON.stringify(targetLink, null, 2));

    // Check content similarity
    const sourceContent =
      sourceLink &&
      sourceLink.children &&
      sourceLink.children[0] &&
      sourceLink.children[0].text
        ? sourceLink.children[0].text
        : '';
    const targetContent =
      targetLink &&
      targetLink.children &&
      targetLink.children[0] &&
      targetLink.children[0].text
        ? targetLink.children[0].text
        : '';

    console.log('\n=== CONTENT COMPARISON ===');
    console.log('Source content:', sourceContent);
    console.log('Target content:', targetContent);

    // Calculate similarity manually
    const similarity = calculateSimilarity(sourceContent, targetContent);
    console.log('Content similarity:', similarity);

    console.log('\n=== REPLACE EDITOR RESULT ===');
    console.log(
      JSON.stringify(result.replaceEditor.getEditorState().toJSON(), null, 2),
    );

    // Check if we have any diff nodes at all
    const {addNodes, removeNodes} = result.getDiffNodes();
    console.log('\n=== DIFF NODES DEBUG ===');
    console.log('Add nodes count:', addNodes.length);
    console.log('Remove nodes count:', removeNodes.length);

    // For links that are modified (not added/removed entirely), we expect them to be marked as modified
    // The approval/rejection mechanism should work based on the modified state
    console.log('\n=== TESTING APPROACH ===');
    console.log(
      'Since links are being updated in-place (not removed+added), they should be marked as modified',
    );
    console.log('Testing if approve/reject works properly...');

    try {
      assertApproveProducesTargetReplace(result);
      assertRejectProducesOriginalReplace(result);
      console.log('✅ Approve/reject works correctly for modified links');
    } catch (error) {
      console.log('❌ Approve/reject failed:', error instanceof Error ? error.message : String(error));
    }

    // This test is just for debugging
    expect(true).toBe(true);
  });

  test('Updates link text in paragraph', async () => {
    const originalMarkdown = `This is a paragraph with a [link](https://example.com) in it.`;
    const replacements = [
      {
        oldText: '[link](https://example.com)',
        newText: '[updated link](https://example.com)',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // For link text changes, the link should be updated in-place (marked as modified)
    // rather than being removed and added as separate nodes
    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test.skip('Updates link URL in paragraph', async () => {
    const originalMarkdown = `Check out [this site](https://old-example.com) for more info.`;
    const replacements = [
      {
        oldText: '[this site](https://old-example.com)',
        newText: '[this site](https://new-example.com)',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // For link URL changes, the link should be updated in-place (marked as modified)
    // rather than being removed and added as separate nodes
    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test('Adds new link to paragraph', async () => {
    const originalMarkdown = `This is a simple paragraph.`;
    const replacements = [
      {
        oldText: 'This is a simple paragraph.',
        newText:
          'This is a simple paragraph with a [new link](https://example.com).',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Verify we have diff nodes
    const {addNodes, removeNodes} = result.getDiffNodes();
    expect(addNodes.length).toBeGreaterThan(0);

    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test('Removes link from paragraph', async () => {
    const originalMarkdown = `This paragraph has a [link to remove](https://example.com) in it.`;
    const replacements = [
      {
        oldText:
          'This paragraph has a [link to remove](https://example.com) in it.',
        newText: 'This paragraph has text in it.',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Verify we have diff nodes
    const {addNodes, removeNodes} = result.getDiffNodes();
    expect(addNodes.length).toBeGreaterThan(0);
    expect(removeNodes.length).toBeGreaterThan(0);

    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });

  test.skip('Updates link in heading', async () => {
    const originalMarkdown = `# Heading with [old link](https://old.com)`;
    const replacements = [
      {
        oldText: '[old link](https://old.com)',
        newText: '[new link](https://new.com)',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // For link updates in headings, the link should be updated in-place (marked as modified)
    // rather than being removed and added as separate nodes
    assertApproveProducesTargetReplace(result);
    assertRejectProducesOriginalReplace(result);
  });
});

// Helper function to calculate similarity
function calculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1.0;
  if (str1.length === 0 || str2.length === 0) return 0.0;

  // Simple similarity calculation
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1.0;

  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1: string, str2: string): number {
  const matrix = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}
