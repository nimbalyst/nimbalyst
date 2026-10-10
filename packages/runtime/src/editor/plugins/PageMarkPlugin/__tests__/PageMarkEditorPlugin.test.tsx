import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from 'lexical';
import { describe, expect, it } from 'vitest';

import PageMarkEditorPlugin, { getPageMarkToolbarActions } from '../PageMarkEditorPlugin';
import { $createPageMarkNode, $isPageMarkNode, PageMarkNode } from '../PageMarkNode';
import { $updatePageMark } from '../pageMarkActions';

function Bridge({ onReady }: { onReady: (editor: LexicalEditor) => void }): null {
  const [editor] = useLexicalComposerContext();
  onReady(editor);
  return null;
}

function mount(): LexicalEditor {
  let editor: LexicalEditor | undefined;
  render(
    <LexicalComposer
      initialConfig={{ namespace: 'page-mark-test', nodes: [PageMarkNode], theme: {}, onError: (error) => { throw error; } }}
    >
      <RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
      <Bridge onReady={(value) => (editor = value)} />
      <PageMarkEditorPlugin />
    </LexicalComposer>,
  );
  if (!editor) throw new Error('editor not initialized');
  return editor;
}

describe('PageMarkEditorPlugin', () => {
  it('opens the mark editor when the mark chip is clicked', async () => {
    const editor = mount();
    await act(async () => {
      editor.update(() => {
        const mark = $createPageMarkNode({ kind: 'open', by: 'Ana' });
        mark.append($createTextNode('Who owns pricing?'));
        $getRoot().append($createParagraphNode().append(mark));
      }, { discrete: true });
    });

    const span = document.querySelector('.page-mark') as HTMLElement;
    fireEvent.click(span);
    await waitFor(() => expect(document.querySelector('.page-mark-editor')).not.toBeNull());
  });

  it('redraws the chip when a decision is switched to an open question', async () => {
    const editor = mount();
    let key = '';
    await act(async () => {
      editor.update(() => {
        const mark = $createPageMarkNode({ kind: 'decided', by: 'Ana' });
        mark.append($createTextNode('Use the newer model.'));
        $getRoot().append($createParagraphNode().append(mark));
        key = mark.getKey();
      }, { discrete: true });
    });

    await act(async () => {
      editor.update(() => $updatePageMark(key, { kind: 'open', by: 'Ana' }), { discrete: true });
    });

    const span = document.querySelector('.page-mark') as HTMLElement;
    expect(span.getAttribute('data-page-mark')).toBe('open');
    expect(span.classList.contains('page-mark--open')).toBe(true);
  });

  it('marks the selection as an open question and opens its editor', async () => {
    const editor = mount();
    await act(async () => {
      editor.update(() => {
        const text = $createTextNode('Pricing is unknown.');
        $getRoot().append($createParagraphNode().append(text));
        text.select(0, 7);
      }, { discrete: true });
    });

    const markOpen = getPageMarkToolbarActions(editor).find((action) => action.id === 'mark-open')!;
    await act(async () => markOpen.onSelect());

    await waitFor(() => {
      const kinds = editor.read(() => $getRoot().getAllTextNodes()
        .map((node) => node.getParent())
        .filter($isPageMarkNode)
        .map((mark) => mark.getKind()));
      expect(kinds).toEqual(['open']);
    });
    await waitFor(() => expect(document.querySelector('.page-mark-editor')).not.toBeNull());
  });
});
