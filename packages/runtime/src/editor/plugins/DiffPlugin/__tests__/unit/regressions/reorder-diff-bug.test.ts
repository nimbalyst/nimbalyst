/**
 * Test for the "Small" document bug with multiple additions under headers
 */

import { describe, it, expect } from 'vitest';
import { $getRoot } from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  getEditorTransformers,
} from '../../../../../markdown/index';
import { applyMarkdownReplace } from '../../../core/diffUtils';
import { createTestHeadlessEditor } from '../../utils/testConfig';
import { expectMarkdownToMatch } from '../../utils/replaceTestUtils';

describe('Reorder diff bug', () => {
  it('should handle multiple additions under multiple headers', () => {
    const editor = createTestHeadlessEditor();
    const transformers = getEditorTransformers();

    const oldMarkdown = `# Reorder Test

This test will test what happens if an entire section is moved in a document.


## Section One

Lorem ipsum dolor sit amet, consectetur adipiscing elit.
Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

## Section Two

Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

## Section Three
Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

`;

    const newMarkdown = `# Reorder Test

This test will test what happens if an entire section is moved in a document.


## Section One

Lorem ipsum dolor sit amet, consectetur adipiscing elit.
Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

## Section Three
Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.


## Section Two

Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

`;

    // Setup: Load the old markdown
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        $convertFromEnhancedMarkdownString(oldMarkdown, transformers, undefined, true, true);
      },
      { discrete: true }
    );

    // Apply the diff (single replacement of entire document)
    // LiveNodeKeyState is set automatically by applyMarkdownReplace via parallel traversal
    editor.update(
      () => {
        const original = $convertToEnhancedMarkdownString(transformers);
        applyMarkdownReplace(
          editor,
          original,
          [{ oldText: original, newText: newMarkdown }],
          transformers
        );
      },
      { discrete: true }
    );

    // Get the final markdown and check it matches expected
    let finalMarkdown = '';
    editor.getEditorState().read(() => {
      finalMarkdown = $convertToEnhancedMarkdownString(transformers);
    });

    console.log('=== FINAL MARKDOWN ===');
    console.log(finalMarkdown);

    // Check that content appears under correct headers
    expectMarkdownToMatch(finalMarkdown, newMarkdown);

  });
});
