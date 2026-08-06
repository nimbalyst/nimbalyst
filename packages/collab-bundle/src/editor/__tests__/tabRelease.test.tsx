import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserEditorSurface } from '../BrowserEditorSurface';

/**
 * The runtime registers `TabIndentationExtension` unconditionally, so Lexical's
 * root listener consumes Tab everywhere and the document becomes a keyboard
 * trap in a browser tab. The surface stops that event before it reaches
 * Lexical — except where indentation is meaningful. Whether a given keypress
 * gets through is invisible in the markup, which is what this pins.
 */
vi.mock('@nimbalyst/runtime/editor/NimbalystEditor', () => ({
  NimbalystEditor: () => null,
}));

interface Harness {
  editable: HTMLElement;
  reachedLexical: string[];
  container: HTMLElement;
}

function renderSurface(documentMarkup: string): Harness {
  const reachedLexical: string[] = [];
  const { container } = render(<BrowserEditorSurface config={{} as never} />);
  const surface = container.querySelector<HTMLElement>('.collab-bundle-editor')!;
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  editable.innerHTML = documentMarkup;
  // Lexical listens on the contentEditable root; anything that reaches this
  // listener is a keypress Lexical would have consumed.
  editable.addEventListener('keydown', (event) => {
    reachedLexical.push(`${event.shiftKey ? 'Shift+' : ''}${event.key}`);
  });
  surface.append(editable);
  return { editable, reachedLexical, container: surface };
}

function pressTab(target: Element, shiftKey = false): void {
  target.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  }));
}

function selectInside(node: Node): void {
  const selection = document.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
});

describe('releasing Tab from the document', () => {
  it('keeps Tab away from Lexical in ordinary prose, in both directions', () => {
    const { editable, reachedLexical } = renderSurface('<p id="prose">plain paragraph</p>');
    selectInside(document.getElementById('prose')!);

    pressTab(editable);
    pressTab(editable, true);

    expect(reachedLexical).toEqual([]);
  });

  it('does not cancel the event, so the browser still performs the focus move', () => {
    const { editable } = renderSurface('<p id="prose">plain paragraph</p>');
    selectInside(document.getElementById('prose')!);

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    editable.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('lets Tab through where indentation is meaningful', () => {
    const { editable, reachedLexical } = renderSurface(`
      <ul><li id="item">list item</li></ul>
      <table><tbody><tr><td id="cell">cell</td></tr></tbody></table>
      <code class="nim-code" id="block">fenced code</code>
      <p>prose with <code class="nim-text-code" id="inline">an inline span</code></p>
    `);

    for (const id of ['item', 'cell', 'block']) {
      selectInside(document.getElementById(id)!);
      pressTab(editable);
    }
    expect(reachedLexical).toEqual(['Tab', 'Tab', 'Tab']);

    // An inline code span sits in ordinary prose and carries no indentation
    // meaning, so it must not re-trap Tab.
    selectInside(document.getElementById('inline')!);
    pressTab(editable);
    expect(reachedLexical).toEqual(['Tab', 'Tab', 'Tab']);
  });
});
