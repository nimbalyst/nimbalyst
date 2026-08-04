import { describe, it, expect } from 'vitest';
import { resolveMatchRange } from '../resolveMatchRange';

function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
}

describe('resolveMatchRange', () => {
  it('resolves a match nested inside a wrapper element (inline code)', () => {
    // Lexical renders inline code as <code><span class="nim-text-code">…</span></code>,
    // so the match text is not the element's first child.
    const code = el('<code><span class="nim-text-code">src/ai/AIService.ts</span></code>');
    const range = resolveMatchRange(code, 'src/ai/'.length, 'AIService'.length);

    expect(range?.toString()).toBe('AIService');
  });

  it('resolves a match in a plain text element', () => {
    const range = resolveMatchRange(el('<span>hello world</span>'), 6, 5);
    expect(range?.toString()).toBe('world');
  });

  it('spans several descendant text nodes', () => {
    const range = resolveMatchRange(el('<span>foo<b>bar</b>baz</span>'), 2, 5);
    expect(range?.toString()).toBe('obarb');
  });

  it('clamps a match that runs past the element text', () => {
    const range = resolveMatchRange(el('<span>abc</span>'), 1, 99);
    expect(range?.toString()).toBe('bc');
  });

  it('returns null when the offset is past the element text', () => {
    expect(resolveMatchRange(el('<span>abc</span>'), 5, 2)).toBeNull();
    expect(resolveMatchRange(el('<span>abc</span>'), 0, 0)).toBeNull();
  });
});
