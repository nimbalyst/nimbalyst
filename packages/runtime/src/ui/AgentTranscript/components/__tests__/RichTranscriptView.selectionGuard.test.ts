// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { hasActiveTranscriptSelection } from '../RichTranscriptView';

// jsdom's Selection implementation is a stub, so we drive window.getSelection
// directly: the unit under test is "given a selection, is it a non-collapsed
// range anchored inside the transcript root?" — pure DOM containment logic.
function stubSelection(value: Partial<Selection> | null) {
  const original = window.getSelection;
  window.getSelection = () => value as Selection | null;
  return () => {
    window.getSelection = original;
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('hasActiveTranscriptSelection (#1162 selection-drag fix)', () => {
  it('is true for a non-collapsed selection anchored inside the transcript root', () => {
    const root = document.createElement('div');
    const inner = document.createElement('span');
    inner.textContent = 'copy me';
    root.appendChild(inner);
    document.body.appendChild(root);
    const restore = stubSelection({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: inner.firstChild,
    });
    expect(hasActiveTranscriptSelection(root)).toBe(true);
    restore();
  });

  it('is false for a collapsed selection (just a caret, no highlight)', () => {
    const root = document.createElement('div');
    root.textContent = 'text';
    document.body.appendChild(root);
    const restore = stubSelection({
      isCollapsed: true,
      rangeCount: 1,
      anchorNode: root.firstChild,
    });
    expect(hasActiveTranscriptSelection(root)).toBe(false);
    restore();
  });

  it('is false when the selection lives outside the transcript (e.g. the composer)', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const outside = document.createElement('div');
    outside.textContent = 'elsewhere';
    document.body.appendChild(outside);
    const restore = stubSelection({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: outside.firstChild,
    });
    expect(hasActiveTranscriptSelection(root)).toBe(false);
    restore();
  });

  it('is false when there is no selection or no root', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const restore = stubSelection(null);
    expect(hasActiveTranscriptSelection(root)).toBe(false);
    expect(hasActiveTranscriptSelection(null)).toBe(false);
    restore();
  });
});
