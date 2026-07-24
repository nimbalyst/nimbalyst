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
  assertReplacementApplied,
  setupMarkdownReplaceTest,
} from '../../utils/replaceTestUtils';

describe('Markdown Replace - Headings', () => {
  test('Updates heading text', () => {
    const originalMarkdown = `# Original Heading`;
    const replacements = [
      {
        oldText: 'Original',
        newText: 'Updated',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    assertReplacementApplied(result, ['Updated'], ['Original']);
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Adds word to heading', () => {
    const originalMarkdown = `# Simple Heading`;
    const replacements = [
      {
        oldText: 'Simple Heading',
        newText: 'Simple Great Heading',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    assertReplacementApplied(result, ['Great '], []);
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Removes word from heading', () => {
    const originalMarkdown = `# Very Simple Heading`;
    const replacements = [
      {
        oldText: 'Very Simple',
        newText: 'Simple',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    assertReplacementApplied(result, [], ['Very ']);
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Multiple word replacements in different headings', () => {
    const originalMarkdown = `# First Title
## Second Title
### Third Title`;

    const replacements = [
      {
        oldText: 'First',
        newText: 'Updated',
      },
      {
        oldText: 'Second',
        newText: 'Modified',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    assertReplacementApplied(
      result,
      ['Updated', 'Modified'],
      ['First', 'Second'],
    );
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Bold formatting in heading - KNOWN LIMITATION', () => {
    const originalMarkdown = `# Simple Heading`;
    const replacements = [
      {
        oldText: 'Simple',
        newText: '**Simple**',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // What actually matters: does it work when approved/rejected?
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);

    // Verify that we actually have some diff nodes (so the diff was applied)
    const {addNodes, removeNodes} = result.getDiffNodes();
    expect(addNodes.length).toBeGreaterThan(0);
    expect(removeNodes.length).toBeGreaterThan(0);
  });
});
