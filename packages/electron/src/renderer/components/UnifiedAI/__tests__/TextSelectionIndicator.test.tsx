// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { getTextSelection, setTextSelection, clearTextSelection } from '../TextSelectionIndicator';

const DOC_A = '/test/a.md';
const DOC_B = '/test/b.md';

afterEach(() => {
  clearTextSelection();
});

describe('clearTextSelection scoping', () => {
  it('does not wipe a selection owned by a different file', () => {
    // Regression: with Files/Collab/Agent modes all mounted, a background
    // editor's activation/cleanup effect used to clear the focused editor's
    // freshly-published selection 1ms after it was set.
    setTextSelection('hello world', DOC_A);
    clearTextSelection(DOC_B); // a different editor tearing down must not clobber
    expect(getTextSelection()?.text).toBe('hello world');
    expect(getTextSelection()?.filePath).toBe(DOC_A);
  });

  it('clears when the owning file matches', () => {
    setTextSelection('hello world', DOC_A);
    clearTextSelection(DOC_A);
    expect(getTextSelection()).toBeNull();
  });

  it('clears unconditionally when no owner file is given (explicit remove / send)', () => {
    setTextSelection('hello world', DOC_A);
    clearTextSelection();
    expect(getTextSelection()).toBeNull();
  });
});
