/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable @typescript-eslint/no-explicit-any, lexical/no-optional-chaining */

import type {Transformer} from '@lexical/markdown';

import {TRANSFORMERS} from '@lexical/markdown';

import {applyMarkdownReplace, type TextReplacement} from '../../../core/diffUtils';
import {
  assertApproveProducesTarget,
  assertRejectProducesOriginal,
  assertReplacementApplied,
  setupMarkdownReplaceTest,
} from '../../utils/replaceTestUtils';

describe('Converting characters', () => {
  test('p', () => {
    // Test replacement where 'p' might cause regex issues with word boundaries
    const originalMarkdown = `The app is peppered with problems`;
    const replacements: TextReplacement[] = [{oldText: 'p', newText: 'P'}];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // The word-level diff (LCS-based) marks only the changed words, leaving
    // the unchanged "The is with" untouched. Each case-changed word becomes
    // its own add/remove pair instead of one whole-line replacement.
    assertReplacementApplied(
      result,
      ['aPP', 'PePPered', 'Problems'],
      ['app', 'peppered', 'problems'],
    );

    // Test approve/reject functionality
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('b', () => {
    // Test replacement where 'b' might cause regex issues
    const originalMarkdown = `Bob bought a big bottle of beer`;
    const replacements: TextReplacement[] = [{oldText: 'b', newText: 'B'}];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Word-level (LCS) diff: each case-changed word becomes its own
    // insert/delete pair; "a", "of" and the surrounding spaces stay
    // unchanged.
    assertReplacementApplied(
      result,
      ['BoB', 'Bought', 'Big', 'Bottle', 'Beer'],
      ['Bob', 'bought', 'big', 'bottle', 'beer'],
    );

    // Test approve/reject functionality
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('strong', () => {
    // Test replacement where 'strong' might be part of a longer word
    const originalMarkdown = `He has strong muscles and stronghold defenses`;
    const replacements: TextReplacement[] = [
      {oldText: 'strong', newText: 'STRONG'},
    ];

    const result = setupMarkdownReplaceTest(originalMarkdown, replacements);

    // Word-level diff marks only the two case-changed tokens.
    // "He has", "muscles and", and "defenses" stay unchanged.
    assertReplacementApplied(
      result,
      ['STRONG', 'STRONGhold'],
      ['strong', 'stronghold'],
    );

    // Test approve/reject functionality
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });
});
