import {describe, expect, it} from 'vitest';
import {$getRoot} from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
} from '../../../../../markdown';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../../utils/testConfig';
import {$approveDiffs, applyMarkdownReplace} from '../../../core/exports';

describe('sequential replacements', () => {
  it('applies replacements against the latest markdown state', () => {
    const originalMarkdown = `# Test

First section.
`;
    const expectedMarkdown = `# Test

FINAL section.
`;

    const editor = createTestHeadlessEditor();

    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(originalMarkdown, MARKDOWN_TEST_TRANSFORMERS);
    }, {discrete: true});

    applyMarkdownReplace(
      editor,
      originalMarkdown,
      [
        {oldText: 'First section.', newText: 'UPDATED section.'},
        {oldText: 'UPDATED section.', newText: 'FINAL section.'},
      ],
      MARKDOWN_TEST_TRANSFORMERS,
    );

    editor.update(() => {
      $approveDiffs();
    }, {discrete: true});

    const finalMarkdown = editor.getEditorState().read(() =>
      $convertToEnhancedMarkdownString(MARKDOWN_TEST_TRANSFORMERS),
    );

    expect(finalMarkdown).toBe(expectedMarkdown);
  });
});
