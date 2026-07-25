import { describe, it, expect, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { LexicalEditor } from 'lexical';
import { $getRoot, $createTextNode } from 'lexical';
import { $createCodeNode, $isCodeNode } from '@lexical/code';

import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import CodeHighlightPlugin from '../index';

/**
 * Regression guard for the theme-switch freeze (NIM-1810).
 *
 * The old CodeHighlightPlugin re-themed every CodeNode on theme change, which
 * marked each node dirty and forced a synchronous Prism re-tokenization of every
 * code block in every mounted editor -- a ~30s freeze on doc-heavy sessions.
 * Code colors already follow the app theme via the editor's `nim-token-*`
 * classes (`--nim-code-*` CSS variables), so no re-tokenization is needed.
 *
 * This test asserts that flipping the DOM theme does NOT mutate code nodes.
 * Against the old code it fails (the code node's stored theme changes and an
 * editor update fires); against the current code it passes (the theme switch
 * schedules no editor update and leaves the code node untouched).
 */

function CaptureEditor({ onReady }: { onReady: (editor: LexicalEditor) => void }): null {
  const [editor] = useLexicalComposerContext();
  onReady(editor);
  return null;
}

const CODE = `function greet(name) {
  const msg = "hello, " + name; // comment
  return msg.length > 0 ? msg : null;
}`;

function setDomTheme(theme: 'light' | 'dark'): void {
  const root = document.documentElement;
  root.classList.remove('dark-theme', 'light-theme');
  root.classList.add(theme === 'dark' ? 'dark-theme' : 'light-theme');
  root.setAttribute('data-theme', theme);
}

describe('CodeHighlightPlugin theme switching', () => {
  beforeEach(() => {
    setDomTheme('light');
  });

  it('does not dirty (re-tokenize) code nodes when the DOM theme changes', async () => {
    let editor: LexicalEditor | undefined;

    render(
      <LexicalComposer
        initialConfig={{
          namespace: 'code-theme-test',
          nodes: [...HeadlessBodyNodes],
          theme: {},
          onError: (e) => {
            throw e;
          },
        }}
      >
        <CodeHighlightPlugin />
        <CaptureEditor onReady={(e) => (editor = e)} />
      </LexicalComposer>
    );

    if (!editor) throw new Error('editor not initialized');
    const ed = editor;

    // Seed a real, syntax-highlightable code block.
    await act(async () => {
      ed.update(
        () => {
          const code = $createCodeNode('javascript');
          code.append($createTextNode(CODE));
          $getRoot().clear().append(code);
        },
        { discrete: true }
      );
      // Let initial highlighting / language loading settle.
      await new Promise((r) => setTimeout(r, 300));
    });

    const readCodeTheme = () =>
      ed.getEditorState().read(() => {
        const c = $getRoot().getFirstChild();
        return $isCodeNode(c) ? c.getTheme() : '(not-code)';
      });

    // Snapshot the code node's stored theme, then count any editor updates the
    // theme switch triggers. The old plugin re-themed code nodes here (mutating
    // stored theme + forcing re-tokenization); the current plugin does nothing.
    const themeBefore = readCodeTheme();
    let updatesFromSwitch = 0;
    const unregUpd = ed.registerUpdateListener(() => {
      updatesFromSwitch++;
    });

    // Flip the theme the same way applyThemeToDOM does.
    await act(async () => {
      setDomTheme('dark');
      // Allow the MutationObserver-driven useTheme re-render + any effects.
      await new Promise((r) => setTimeout(r, 200));
    });

    unregUpd();
    const themeAfter = readCodeTheme();

    // The switch must not mutate the code node (no re-theme -> no re-tokenize)...
    expect(themeAfter).toBe(themeBefore);
    // ...and must not schedule any editor update at all.
    expect(updatesFromSwitch).toBe(0);
  });
});
