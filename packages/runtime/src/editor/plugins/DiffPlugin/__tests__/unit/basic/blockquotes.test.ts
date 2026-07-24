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

describe('Markdown Replace - Blockquotes', () => {
  test('Updates blockquote text', () => {
    const originalMarkdown = `> Original quote text`;
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

  test('Prepends word to a blockquote line (issue #433)', () => {
    const originalMarkdown = `> Some blockquote content`;
    const replacements = [
      {
        oldText: 'Some blockquote',
        newText: 'Test Some blockquote',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    assertReplacementApplied(result, ['Test '], []);
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Multiple blockquote edits all surface as diffs', () => {
    const originalMarkdown = `> First blockquote line

> Second blockquote line

> Third blockquote line`;

    const replacements = [
      {
        oldText: 'First',
        newText: 'Test First',
      },
      {
        oldText: 'Second',
        newText: 'Test Second',
      },
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    assertReplacementApplied(result, ['Test ', 'Test '], []);
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });
});
