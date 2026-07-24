/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {TextReplacement} from '../../../core/diffUtils';
import {$getRoot} from 'lexical';
import {
  assertApproveProducesTarget,
  assertRejectProducesOriginal,
  assertReplacementApplied,
  setupMarkdownReplaceTest,
} from '../../utils/replaceTestUtils';

describe.skip('NBSP matching in text replacement', () => {
  // KNOWN LIMITATION: NBSP normalization is not currently implemented
  // These tests expect that non-breaking spaces (NBSP) should be treated as
  // equivalent to regular spaces during text replacement
  // This would require space normalization in the text matching logic

  const NBSP = '\u00A0'; // Non-breaking space character

  test('should match NBSP with regular spaces in text replacement', () => {
    // Create markdown with text containing NBSP
    const originalMarkdown = `Hello${NBSP}world${NBSP}with${NBSP}non-breaking${NBSP}spaces`;

    // Try to replace the text using regular spaces instead of NBSP
    const replacements: TextReplacement[] = [
      {
        oldText: 'Hello world with non-breaking spaces',
        newText: 'Hello normal spaces',
      },
    ];

    // Apply the replacement
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // The replacement should succeed - check that the target markdown is correct
    expect(result.targetMarkdown).toBe('Hello normal spaces');
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('should match regular spaces with NBSP in text replacement', () => {
    // Create markdown with text containing regular spaces
    const originalMarkdown = 'Hello world with regular spaces';

    // Try to replace the text using NBSP instead of regular spaces
    const replacements: TextReplacement[] = [
      {
        oldText: `Hello${NBSP}world${NBSP}with${NBSP}regular${NBSP}spaces`,
        newText: 'Hello NBSP replacement',
      },
    ];

    // Apply the replacement
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // The replacement should succeed even though we used NBSP to match regular spaces
    expect(result.targetMarkdown).toBe('Hello NBSP replacement');
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('should handle mixed NBSP and regular spaces in matching', () => {
    // Create markdown with mixed spaces
    const originalMarkdown = `Hello${NBSP}world with${NBSP}mixed spaces`;

    // Try to replace using all regular spaces
    const replacements: TextReplacement[] = [
      {oldText: 'Hello world with mixed spaces', newText: 'Replaced text'},
    ];

    // Apply the replacement
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // The replacement should succeed
    expect(result.targetMarkdown).toBe('Replaced text');
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('should treat NBSP as regular space in paragraph diff matching', () => {
    // Create content with NBSP
    const originalMarkdown = `First${NBSP}paragraph`;

    // Replace using regular space
    const replacements: TextReplacement[] = [
      {oldText: 'First paragraph', newText: 'First modified paragraph'},
    ];

    // Apply the replacement
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // The replacement should match despite NBSP/space difference
    expect(result.targetMarkdown).toBe('First modified paragraph');
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('should handle NBSP in multi-word replacements', () => {
    // Create markdown with NBSP between some words
    const originalMarkdown = `The${NBSP}quick brown${NBSP}fox jumps`;

    // Replace with regular spaces
    const replacements: TextReplacement[] = [
      {oldText: 'The quick brown fox', newText: 'A fast red fox'},
    ];

    // Apply the replacement
    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Should match and replace despite mixed spacing
    expect(result.targetMarkdown).toBe('A fast red fox jumps');
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });
});
