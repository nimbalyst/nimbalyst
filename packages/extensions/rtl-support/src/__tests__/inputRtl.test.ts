/**
 * Tests for input RTL handling.
 *
 * Since 0.68 the composer renders visible text in a sibling overlay over a
 * transparent textarea. These tests verify that detected direction is mirrored
 * onto that overlay, not just the textarea itself.
 *
 * Note: Persian sample strings below are intentional — real RTL text used to
 * verify the direction is detected correctly.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { startInputRtl, stopInputRtl } from '../inputRtl';
import type { RtlSettings } from '../settings';

const SETTINGS: RtlSettings = {
  enabled: true,
  mode: 'auto',
  threshold: 0.3,
  perBlock: true,
  inputRtl: true,
  inlineDetect: false,
  debug: false,
};

/** Build a DOM structure matching the 0.68 composer. */
function buildComposer(): HTMLTextAreaElement {
  document.body.innerHTML = `
    <div class="ai-chat-input-textarea-wrap">
      <textarea class="ai-chat-input-field"></textarea>
      <div class="command-pill-overlay">
        <span class="command-pill-overlay-text"></span>
      </div>
    </div>`;
  return document.querySelector<HTMLTextAreaElement>('.ai-chat-input-field')!;
}

function typeAndDispatch(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('inputRtl overlay mirroring', () => {
  afterEach(() => {
    stopInputRtl();
    document.body.innerHTML = '';
  });

  it('mirrors RTL direction onto the composer overlay', () => {
    const textarea = buildComposer();
    startInputRtl(document.body, SETTINGS);

    typeAndDispatch(textarea, 'سلام دنیا');

    expect(textarea.getAttribute('dir')).toBe('rtl');
    expect(document.querySelector('.command-pill-overlay')!.getAttribute('dir')).toBe('rtl');
    expect(document.querySelector('.command-pill-overlay-text')!.getAttribute('dir')).toBe('rtl');
  });

  it('mirrors LTR direction onto the composer overlay', () => {
    const textarea = buildComposer();
    startInputRtl(document.body, SETTINGS);

    typeAndDispatch(textarea, 'Hello world');

    expect(textarea.getAttribute('dir')).toBe('ltr');
    expect(document.querySelector('.command-pill-overlay')!.getAttribute('dir')).toBe('ltr');
    expect(document.querySelector('.command-pill-overlay-text')!.getAttribute('dir')).toBe('ltr');
  });

  it('flips the overlay direction when the input language switches', () => {
    const textarea = buildComposer();
    startInputRtl(document.body, SETTINGS);

    typeAndDispatch(textarea, 'سلام دنیا');
    expect(document.querySelector('.command-pill-overlay')!.getAttribute('dir')).toBe('rtl');

    typeAndDispatch(textarea, 'Hello world');
    expect(document.querySelector('.command-pill-overlay')!.getAttribute('dir')).toBe('ltr');
  });

  it('leaves the overlay untouched when inputRtl is disabled', () => {
    const textarea = buildComposer();
    startInputRtl(document.body, { ...SETTINGS, inputRtl: false });

    typeAndDispatch(textarea, 'سلام دنیا');

    expect(textarea.getAttribute('dir')).toBeNull();
    expect(document.querySelector('.command-pill-overlay')!.getAttribute('dir')).toBeNull();
  });
});
