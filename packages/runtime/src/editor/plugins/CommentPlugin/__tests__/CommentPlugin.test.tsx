import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { $wrapSelectionInMarkNode, MarkNode } from '@lexical/mark';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  type LexicalEditor,
} from 'lexical';
import { useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommentsConfig } from '../../../commenting/types';
import { INSERT_INLINE_COMMENT_COMMAND } from '../../../extensions/builtin/CommentsExtension';
import CommentsPlugin from '../index';
import { OPEN_COMMENT_COMPOSER_COMMAND } from '../commands';

function TestEditorBridge({
  onReady,
}: {
  onReady: (editor: LexicalEditor) => void;
}): null {
  const [editor] = useLexicalComposerContext();
  onReady(editor);

  useEffect(
    () =>
      editor.registerCommand(
        INSERT_INLINE_COMMENT_COMMAND,
        ({ id, isBackward }) => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $wrapSelectionInMarkNode(selection, isBackward, id);
          }
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    [editor],
  );

  return null;
}

const commentsConfig: CommentsConfig = {
  getYDoc: () => null,
  currentUser: { id: 'user-1', name: 'Test User' },
  getMembers: () => [],
  documentTitle: 'Shared document',
  documentId: 'doc-1',
  documentUri: 'collab://org:test:doc:doc-1',
};

describe('CommentsPlugin', () => {
  let paneElem: HTMLDivElement | undefined;

  afterEach(() => {
    paneElem?.remove();
    paneElem = undefined;
  });

  it('opens one new-comment composer in the docked panel', async () => {
    paneElem = document.createElement('div');
    const anchorElem = document.createElement('div');
    paneElem.append(anchorElem);
    document.body.append(paneElem);

    let editor: LexicalEditor | undefined;
    render(
      <LexicalComposer
        initialConfig={{
          namespace: 'comments-panel-test',
          nodes: [MarkNode],
          theme: {},
          onError: (error) => {
            throw error;
          },
        }}
      >
        <TestEditorBridge onReady={(value) => (editor = value)} />
        <CommentsPlugin config={commentsConfig} anchorElem={anchorElem} />
      </LexicalComposer>,
    );

    if (!editor) throw new Error('editor not initialized');
    const mountedEditor = editor;

    await act(async () => {
      mountedEditor.update(
        () => {
          const paragraph = $createParagraphNode();
          const text = $createTextNode('Selected text');
          paragraph.append(text);
          $getRoot().append(paragraph);
          text.select(0, text.getTextContentSize());
        },
        { discrete: true },
      );
    });

    await act(async () => {
      mountedEditor.dispatchCommand(OPEN_COMMENT_COMPOSER_COMMAND, undefined);
    });

    await waitFor(() => {
      expect(
        paneElem?.querySelector('[data-testid="comments-panel"]'),
      ).not.toBeNull();
    });

    expect(
      document.querySelectorAll('[data-testid="comment-composer"]'),
    ).toHaveLength(1);
    expect(document.querySelector('.nim-comment-composer-popover')).toBeNull();
    expect(
      paneElem?.querySelector('.nim-comment-btn-submit')?.textContent,
    ).toBe('Comment');
    expect(
      paneElem
        ?.querySelector('.nim-comment-composer-input')
        ?.getAttribute('aria-placeholder'),
    ).toBe('Add a comment... use @ to mention');

    fireEvent.click(
      paneElem?.querySelector('.nim-comment-btn-cancel') as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(
        paneElem?.querySelector('[data-testid="comment-thread"]'),
      ).toBeNull();
    });
    expect(
      document.querySelector('[data-testid="comment-composer"]'),
    ).toBeNull();
  });
});
