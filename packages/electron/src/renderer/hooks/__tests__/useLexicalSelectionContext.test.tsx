// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEditor,
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  type LexicalEditor,
} from 'lexical';
import { useLexicalSelectionContext } from '../useLexicalSelectionContext';
import { getTextSelection, clearTextSelection } from '../../components/UnifiedAI/TextSelectionIndicator';

/**
 * Build a real Lexical editor attached to a focusable DOM root so the hook's
 * focus check (document.activeElement === rootElement) passes.
 */
function mountEditor(): { editor: LexicalEditor; root: HTMLDivElement } {
  const editor = createEditor({ namespace: 'selection-test', onError: (e) => { throw e; } });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.tabIndex = 0;
  document.body.appendChild(root);
  editor.setRootElement(root);
  return { editor, root };
}

function selectText(editor: LexicalEditor, text: string, anchor: number, focus: number): void {
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      const node = $createTextNode(text);
      paragraph.append(node);
      $getRoot().clear().append(paragraph);
      node.select(anchor, focus);
    },
    { discrete: true },
  );
}

describe('useLexicalSelectionContext', () => {
  beforeEach(() => {
    clearTextSelection();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearTextSelection();
    document.body.innerHTML = '';
  });

  it('publishes a focused range selection to the AI selection store', () => {
    vi.useFakeTimers();
    const { editor, root } = mountEditor();
    root.focus();
    expect(document.activeElement).toBe(root);

    renderHook(() =>
      useLexicalSelectionContext({ editor, filePath: 'collab://doc-1', isActive: true, enabled: true }),
    );

    act(() => {
      selectText(editor, 'Hello world', 0, 5); // selects "Hello"
    });
    act(() => {
      vi.advanceTimersByTime(200); // past the 150ms debounce
    });

    const selection = getTextSelection();
    expect(selection?.text).toBe('Hello');
    expect(selection?.filePath).toBe('collab://doc-1');
  });

  it('does not publish when the editor is not focused', () => {
    vi.useFakeTimers();
    const { editor } = mountEditor();
    // Intentionally no focus() -> document.activeElement is not the editor root.

    renderHook(() =>
      useLexicalSelectionContext({ editor, filePath: 'collab://doc-1', isActive: true, enabled: true }),
    );

    act(() => {
      selectText(editor, 'Hello world', 0, 5);
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(getTextSelection()).toBeNull();
  });

  it('clears the published selection when the tab becomes inactive', () => {
    vi.useFakeTimers();
    const { editor, root } = mountEditor();
    root.focus();

    const { rerender } = renderHook(
      ({ isActive }) =>
        useLexicalSelectionContext({ editor, filePath: 'collab://doc-1', isActive, enabled: true }),
      { initialProps: { isActive: true } },
    );

    act(() => {
      selectText(editor, 'Hello world', 0, 5);
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(getTextSelection()?.text).toBe('Hello');

    act(() => {
      rerender({ isActive: false });
    });
    expect(getTextSelection()).toBeNull();
  });

  it('re-binds to a new editor instance when the editor is swapped (remount)', () => {
    // Regression: a Lexical/Monaco editor can remount after the tab is already
    // "ready" (extension reload, diff-mode swap, theme change), producing a NEW
    // editor instance. If the selection listener stays bound to the destroyed
    // editor, selections in the live editor silently stop publishing — the
    // Files-mode "+ selection" bug. The editor must be a hook dependency so the
    // listener re-registers on the current instance.
    vi.useFakeTimers();
    const first = mountEditor();
    first.root.focus();

    const { rerender } = renderHook(
      ({ editor }) =>
        useLexicalSelectionContext({ editor, filePath: 'collab://doc-1', isActive: true, enabled: true }),
      { initialProps: { editor: first.editor } },
    );

    // Simulate a remount: a brand-new editor instance replaces the first.
    const second = mountEditor();
    second.root.focus();
    act(() => {
      rerender({ editor: second.editor });
    });

    // A selection in the NEW editor must publish (listener followed the swap).
    act(() => {
      selectText(second.editor, 'Second editor text', 0, 6); // "Second"
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(getTextSelection()?.text).toBe('Second');

    // And the OLD editor must no longer publish (its listener was torn down).
    clearTextSelection();
    act(() => {
      selectText(first.editor, 'First editor text', 0, 5);
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(getTextSelection()).toBeNull();
  });
});
