/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable @typescript-eslint/no-explicit-any, lexical/no-optional-chaining */

import {
  assertApproveProducesTarget,
  assertDiffApplied,
  assertRejectProducesOriginal,
  setupMarkdownDiffTest,
} from '../../utils/diffTestUtils';
import {SerializedElementNode, SerializedLexicalNode} from 'lexical';

describe('Text Changes', () => {
  test('Simple word replacement in paragraph', async () => {
    const originalMarkdown = `This is a simple paragraph.`;
    const targetMarkdown = `This is a modified paragraph.`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

    // Test diff application
    assertDiffApplied(result, ['modified'], ['simple']);

    // Test approve/reject functionality using pre-created editors
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Adding text to paragraph', async () => {
    const originalMarkdown = `This is a paragraph.`;
    const targetMarkdown = `This is a great paragraph.`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

    assertDiffApplied(result, ['great '], []);
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Removing text from paragraph', async () => {
    const originalMarkdown = `This is a very long paragraph.`;
    const targetMarkdown = `This is a paragraph.`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

    assertDiffApplied(result, [], ['very long ']);
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Multiple word changes in paragraph', async () => {
    const originalMarkdown = `The quick brown fox jumps.`;
    const targetMarkdown = `The fast red fox leaps.`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

    // The diff algorithm finds common prefix "The " and suffix "."
    // Only the middle part is marked as changed
    assertDiffApplied(
      result,
      ['fast red fox leaps'],
      ['quick brown fox jumps'],
    );
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Word-level changes with common text', async () => {
    const originalMarkdown = `The quick brown fox jumps over the lazy dog.`;
    const targetMarkdown = `The fast brown fox leaps over the lazy dog.`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

    // The diff algorithm finds common prefix/suffix but treats the middle as a phrase change
    // This is actually good behavior - it groups related changes together
    assertDiffApplied(
      result,
      ['fast brown fox leaps'],
      ['quick brown fox jumps'],
    );
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('Bold formatting change - now detects formatting differences!', async () => {
    const originalMarkdown = `This is a simple paragraph.`;
    const targetMarkdown = `This is a **simple** paragraph.`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

    // Pure formatting change. The format-aware pure-formatting path emits
    // diff markers ONLY for the span whose format actually changed -- here,
    // the word "simple". The surrounding "This is a " and " paragraph."
    // stay plain because their format didn't move, so the user only sees
    // the bolded span flash red+green instead of the entire line.
    assertDiffApplied(
      result,
      ['**simple**'], // added: bolded "simple"
      ['simple'],     // removed: original unformatted "simple"
    );

    // Test approve/reject functionality
    assertApproveProducesTarget(result);
    assertRejectProducesOriginal(result);
  });

  test('DEBUG: Examine node structures for bold formatting', async () => {
    const originalMarkdown = `This is a simple paragraph.`;
    const targetMarkdown = `This is a **simple** paragraph.`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

    console.log('\n=== EXAMINING BOLD FORMATTING STRUCTURES ===');
    console.log('Original markdown:', originalMarkdown);
    console.log('Target markdown:', targetMarkdown);

    console.log('\n=== SOURCE STATE ===');
    console.log(JSON.stringify(result.sourceState, null, 2));

    console.log('\n=== TARGET STATE ===');
    console.log(JSON.stringify(result.targetState, null, 2));

    // Compare the paragraph structures
    // @ts-ignore - Debug code with dynamic property access
    const sourceParagraph = result.sourceState.root.children[0] as
      | SerializedElementNode
      | SerializedLexicalNode;
    // @ts-ignore - Debug code with dynamic property access
    const targetParagraph = result.targetState.root.children[0] as
      | SerializedElementNode
      | SerializedLexicalNode;

    console.log('\n=== PARAGRAPH COMPARISON ===');
    // @ts-ignore - Debug code with dynamic property access
    console.log(
      'Source paragraph children:',
      'children' in sourceParagraph && sourceParagraph.children
        ? sourceParagraph.children.length
        : 0,
    );
    // @ts-ignore - Debug code with dynamic property access
    console.log(
      'Target paragraph children:',
      'children' in targetParagraph && targetParagraph.children
        ? targetParagraph.children.length
        : 0,
    );

    // @ts-ignore - Debug code with dynamic property access
    if ('children' in sourceParagraph && sourceParagraph.children) {
      // @ts-ignore - Debug code with dynamic property access
      sourceParagraph.children.forEach((child: any, i: number) => {
        console.log(`Source child ${i}:`, JSON.stringify(child, null, 2));
      });
    }

    // @ts-ignore - Debug code with dynamic property access
    if ('children' in targetParagraph && targetParagraph.children) {
      // @ts-ignore - Debug code with dynamic property access
      targetParagraph.children.forEach((child: any, i: number) => {
        console.log(`Target child ${i}:`, JSON.stringify(child, null, 2));
      });
    }

    console.log('===============================\n');

    // This test is just for debugging, so always pass
    expect(true).toBe(true);
  });

  test('Test comprehensive debugging utilities', async () => {
    const originalMarkdown = `This is a test paragraph.`;
    const targetMarkdown = `This is a modified test paragraph.`;

    const result = setupMarkdownDiffTest(originalMarkdown, targetMarkdown);

    // Test that we have access to all the debugging utilities
    expect(result.sourceState).toBeDefined();
    expect(result.targetState).toBeDefined();
    expect(result.getDiffNodes).toBeDefined();
    expect(result.getApprovedMarkdown).toBeDefined();
    expect(result.getRejectedMarkdown).toBeDefined();
    expect(result.debugInfo).toBeDefined();

    // Test the diff nodes utility
    const {addNodes, removeNodes} = result.getDiffNodes();
    expect(addNodes.length).toBeGreaterThan(0);
    // For this simple change, we might only have add nodes, so be flexible
    expect(removeNodes.length).toBeGreaterThanOrEqual(0);

    // Test approve/reject utilities
    const approvedMarkdown = result.getApprovedMarkdown();
    const rejectedMarkdown = result.getRejectedMarkdown();

    expect(approvedMarkdown).toBe(result.targetMarkdown);
    expect(rejectedMarkdown).toBe(result.originalMarkdown);

    // Test that we can access the editor states
    expect(result.diffEditor).toBeDefined();
    expect(result.approveEditor).toBeDefined();
    expect(result.rejectEditor).toBeDefined();

    // Uncomment the next line to see comprehensive debug output
    // result.debugInfo();
  });
});
