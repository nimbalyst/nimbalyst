import { describe, it, expect } from 'vitest';
import { resizeTitleField, sanitizeTitleInput, TITLE_MAX_HEIGHT_PX } from '../trackerTitleAutoSize';

/** jsdom has no layout, so scrollHeight is stubbed per element. */
function makeTextarea(scrollHeight: number): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  return el;
}

describe('sanitizeTitleInput', () => {
  it('collapses pasted newlines into spaces', () => {
    expect(sanitizeTitleInput('first line\nsecond line')).toBe('first line second line');
    expect(sanitizeTitleInput('a\r\n\r\nb')).toBe('a b');
  });

  it('leaves single-line titles untouched', () => {
    expect(sanitizeTitleInput('Tracker titles do not wrap')).toBe('Tracker titles do not wrap');
  });
});

describe('resizeTitleField', () => {
  it('grows the field to fit a wrapped title', () => {
    const el = makeTextarea(72);
    resizeTitleField(el);
    expect(el.style.height).toBe('72px');
    expect(el.style.overflowY).toBe('hidden');
  });

  it('caps the height and scrolls once the title is very long', () => {
    const el = makeTextarea(TITLE_MAX_HEIGHT_PX + 200);
    resizeTitleField(el);
    expect(el.style.height).toBe(`${TITLE_MAX_HEIGHT_PX}px`);
    expect(el.style.overflowY).toBe('auto');
  });

  it('shrinks back when the title gets shorter', () => {
    const el = makeTextarea(96);
    resizeTitleField(el);
    expect(el.style.height).toBe('96px');

    Object.defineProperty(el, 'scrollHeight', { value: 24, configurable: true });
    resizeTitleField(el);
    expect(el.style.height).toBe('24px');
  });

  it('is a no-op without an element', () => {
    expect(() => resizeTitleField(null)).not.toThrow();
  });
});
