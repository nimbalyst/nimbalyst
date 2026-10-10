// @vitest-environment node
/**
 * A brand-new collaborative document has a Lexical root with zero children
 * until someone types. An agent edit into it must insert content instead of
 * failing with "Live editor root has no children".
 */

import {describe, expect, it} from 'vitest';
import {$getRoot} from 'lexical';
import {$convertToEnhancedMarkdownString} from '../../../../../markdown';
import {createTestHeadlessEditor, MARKDOWN_TEST_TRANSFORMERS} from '../../utils/testConfig';
import {$approveDiffs, $getDiffState} from '../../../core';
import {applyMarkdownReplace} from '../../../core/exports';

describe('applyMarkdownReplace into an empty document', () => {
  it('inserts content as a pending addition when the root has no children', () => {
    const editor = createTestHeadlessEditor();
    editor.update(() => $getRoot().clear(), {discrete: true});
    expect(editor.getEditorState().read(() => $getRoot().getChildrenSize())).toBe(0);

    applyMarkdownReplace(
      editor,
      '',
      [{oldText: '', newText: '# Architecture\n\nThe system has two parts.\n'}],
      MARKDOWN_TEST_TRANSFORMERS,
    );

    const addedTexts = editor.getEditorState().read(() =>
      $getRoot()
        .getChildren()
        .filter((node) => $getDiffState(node) === 'added')
        .map((node) => node.getTextContent())
        .filter(Boolean),
    );
    expect(addedTexts).toEqual(['Architecture', 'The system has two parts.']);

    editor.update(() => $approveDiffs(), {discrete: true});
    const markdown = editor
      .getEditorState()
      .read(() => $convertToEnhancedMarkdownString(MARKDOWN_TEST_TRANSFORMERS));
    expect(markdown.trim()).toBe('# Architecture\n\nThe system has two parts.');
  });
});
