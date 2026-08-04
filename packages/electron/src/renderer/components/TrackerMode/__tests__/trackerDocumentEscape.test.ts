/**
 * Escape exits the focused document view -- but only when nothing else on
 * screen has a claim on the key.
 */
import { describe, expect, it } from 'vitest';
import { shouldExitDocumentViewOnEscape } from '../trackerDocumentEscape';

function doc(overrides: {
  activeElement?: { tagName?: string } | null;
  overlay?: boolean;
} = {}) {
  return {
    activeElement: overrides.activeElement ?? null,
    querySelector: () => (overrides.overlay ? {} : null),
  };
}

describe('shouldExitDocumentViewOnEscape', () => {
  it('exits on a plain Escape', () => {
    expect(shouldExitDocumentViewOnEscape({ key: 'Escape' }, doc())).toBe(true);
  });

  it('ignores other keys', () => {
    expect(shouldExitDocumentViewOnEscape({ key: 'Enter' }, doc())).toBe(false);
  });

  it('leaves Escape alone once something else has handled it', () => {
    expect(
      shouldExitDocumentViewOnEscape({ key: 'Escape', defaultPrevented: true }, doc()),
    ).toBe(false);
  });

  it('leaves Escape to a text field being edited', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(
        shouldExitDocumentViewOnEscape({ key: 'Escape' }, doc({ activeElement: { tagName } })),
      ).toBe(false);
    }
  });

  it('leaves Escape to an open dialog or menu', () => {
    expect(shouldExitDocumentViewOnEscape({ key: 'Escape' }, doc({ overlay: true }))).toBe(false);
  });

  it('still exits from inside the body editor', () => {
    // The document editor's contenteditable holds focus nearly all the time and
    // has no Escape behaviour of its own -- excluding it would strand the
    // shortcut.
    expect(
      shouldExitDocumentViewOnEscape({ key: 'Escape' }, doc({ activeElement: { tagName: 'DIV' } })),
    ).toBe(true);
  });
});
