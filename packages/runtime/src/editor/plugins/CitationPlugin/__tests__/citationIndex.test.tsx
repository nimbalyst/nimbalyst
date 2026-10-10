import { StrictMode } from 'react';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { LexicalComposerContext, createLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createParagraphNode, $getRoot, createEditor, type LexicalEditor } from 'lexical';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { $createCitationNode, CitationNode } from '../CitationNodeCore';
import CitationSourcesSummary from '../CitationSourcesSummary';
import { useCitationIndex } from '../citationIndex';

const editors: LexicalEditor[] = [];

function setSources(editor: LexicalEditor, targets: string[]) {
  editor.update(() => {
    $getRoot().clear().append($createParagraphNode().append(
      ...targets.map((target) => $createCitationNode({ kind: 'source', target, label: target })),
    ));
  }, { discrete: true });
}

function makeEditor(target: string) {
  const editor = createEditor({ nodes: [CitationNode], onError: (error) => { throw error; } });
  editor.setRootElement(document.createElement('div'));
  editors.push(editor);
  setSources(editor, [target]);
  return editor;
}

afterEach(() => {
  cleanup();
  editors.splice(0).forEach((editor) => editor.setRootElement(null));
  vi.restoreAllMocks();
});

describe('citation index subscriptions', () => {
  it('mounts the sole Sources subscriber without a render loop and tracks citation edits', () => {
    const editor = makeEditor('https://example.com/first');
    const register = vi.spyOn(editor, 'registerMutationListener');
    const summary = (
      <StrictMode>
        <LexicalComposerContext.Provider value={[editor, createLexicalComposerContext(null, null)]}>
          <CitationSourcesSummary />
        </LexicalComposerContext.Provider>
      </StrictMode>
    );
    const view = render(summary);
    expect(view.getByTestId('citation-sources-line').textContent).toContain('1 link');
    register.mockClear();

    act(() => setSources(editor, ['https://example.com/first', 'https://example.org/second']));
    expect(view.getByTestId('citation-sources-line').textContent).toContain('2 links');
    act(() => setSources(editor, []));
    expect(view.queryByTestId('citation-sources-line')).toBeNull();
    // Citation-driven renders must keep the existing Lexical subscription.
    expect(register).not.toHaveBeenCalled();
  });

  it('switches editors and catches up after all subscribers unmount', () => {
    const first = makeEditor('https://first.example');
    const second = makeEditor('https://second.example');
    const { result, rerender, unmount } = renderHook(
      ({ editor }: { editor: LexicalEditor | null }) => useCitationIndex(editor),
      { initialProps: { editor: first as LexicalEditor | null } },
    );
    expect(result.current.citations[0]).toMatchObject({ target: 'https://first.example' });
    rerender({ editor: second });
    expect(result.current.citations[0]).toMatchObject({ target: 'https://second.example' });
    act(() => setSources(first, ['https://updated.example']));
    expect(result.current.citations[0]).toMatchObject({ target: 'https://second.example' });
    rerender({ editor: null });
    expect(result.current.citations).toEqual([]);
    unmount();

    const remounted = renderHook(() => useCitationIndex(first));
    expect(remounted.result.current.citations[0]).toMatchObject({ target: 'https://updated.example' });
  });
});
