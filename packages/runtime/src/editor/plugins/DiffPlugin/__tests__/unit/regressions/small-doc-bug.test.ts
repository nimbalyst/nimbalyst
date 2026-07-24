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

describe('Small document bug', () => {
  it('should handle multiple additions under multiple headers', () => {
    const editor = createTestHeadlessEditor();
    const transformers = getEditorTransformers();

    const oldMarkdown = `# Small


## Numbers
One
Two
Three
Four

## Letters
A
B
C
D

## Nato Phonetic
Alpha
Bravo
Charlie


## Greek
Alpha
Beta
Gamma
`;

    const newMarkdown = `# Small


## Numbers
One
Two
Three
Four
Five
Six
Seven

## Letters
A
B
C
D
E
F
G

## Nato Phonetic
Alpha
Bravo
Charlie
Delta
Echo
Foxtrot


## Greek
Alpha
Beta
Gamma
Delta
Epsilon
Zeta
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
    expect(finalMarkdown).toContain('Four\nFive\nSix\nSeven');
    expect(finalMarkdown).toContain('D\nE\nF\nG');
    expect(finalMarkdown).toContain('Charlie\nDelta\nEcho\nFoxtrot');
    expect(finalMarkdown).toContain('Gamma\nDelta\nEpsilon\nZeta');
  });
});
