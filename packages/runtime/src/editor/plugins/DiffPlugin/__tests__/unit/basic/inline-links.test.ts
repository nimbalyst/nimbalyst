/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  assertApproveProducesTarget,
  assertRejectProducesOriginal,
  setupMarkdownReplaceTest,
} from '../../utils/replaceTestUtils';

describe('Inline Links with NodeState', () => {
  test('Link added to paragraph using NodeState', () => {
    const originalMarkdown = `This is a simple paragraph.`;
    const replacements = [
      {
        oldText: 'simple',
        newText: '[simple](https://example.com)',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Test that approve/reject functionality works correctly
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);

    // Debug to verify the internal structure
    console.log('\n=== LINK INLINE DEBUG ===');
    result.debugInfo();
    console.log('=========================\n');
  });

  test('Link removed from paragraph using NodeState', () => {
    const originalMarkdown = `This is a [simple](https://example.com) paragraph.`;
    const replacements = [
      {
        oldText: '[simple](https://example.com)',
        newText: 'simple',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Test that approve/reject functionality works correctly
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Link text changed using NodeState', () => {
    const originalMarkdown = `This is a [simple](https://example.com) paragraph.`;
    const replacements = [
      {
        oldText: '[simple](https://example.com)',
        newText: '[modified](https://example.com)',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Test that approve/reject functionality works correctly
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Complex paragraph with multiple inline elements', () => {
    const originalMarkdown = `This has **bold** text and [a link](https://example.com) too.`;
    const replacements = [
      {
        oldText: '**bold**',
        newText: '**very bold**',
      },
      {
        oldText: '[a link](https://example.com)',
        newText: '[an updated link](https://updated.com)',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Test that approve/reject functionality works correctly
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Link text updated but URL remains the same', () => {
    const originalMarkdown = `This is a paragraph with a [link](https://example.com) in it.`;

    const replacements = [
      {
        oldText: '[link](https://example.com)',
        newText: '[updated link](https://example.com)',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Test that approve/reject functionality works correctly
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });
});
