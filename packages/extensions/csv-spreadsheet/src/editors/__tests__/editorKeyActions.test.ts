// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolveEditorKeyAction, type EditorKeyAction } from '../editorKeyActions';

/**
 * The whole point of the fix: an arrow key inside an open cell editor must stay
 * with the caret. Everything else here is the rest of the contract it sits in,
 * so a future edit can't quietly hand one of these keys back to the grid.
 */
describe('resolveEditorKeyAction', () => {
  const cases: [string, Parameters<typeof resolveEditorKeyAction>[0], EditorKeyAction][] = [
    ['left arrow moves the caret', { key: 'ArrowLeft' }, 'caret'],
    ['right arrow moves the caret', { key: 'ArrowRight' }, 'caret'],
    ['up arrow moves the caret', { key: 'ArrowUp' }, 'caret'],
    ['down arrow moves the caret', { key: 'ArrowDown' }, 'caret'],
    ['shift+arrow selects text', { key: 'ArrowLeft', shiftKey: true }, 'caret'],
    ['home goes to line start', { key: 'Home' }, 'caret'],
    ['end goes to line end', { key: 'End' }, 'caret'],
    ['enter commits downward', { key: 'Enter' }, 'commitDown'],
    ['shift+enter commits upward', { key: 'Enter', shiftKey: true }, 'commitUp'],
    ['tab commits rightward', { key: 'Tab' }, 'commitRight'],
    ['shift+tab commits leftward', { key: 'Tab', shiftKey: true }, 'commitLeft'],
    ['escape cancels', { key: 'Escape' }, 'cancel'],
    ['typing is not ours', { key: 'a' }, 'passthrough'],
    ['backspace is not ours', { key: 'Backspace' }, 'passthrough'],
    // An IME candidate list drives itself with the arrows and commits on Enter;
    // the grid must not see any of it.
    ['enter mid-composition belongs to the IME', { key: 'Enter', isComposing: true }, 'caret'],
  ];

  it.each(cases)('%s', (_name, event, expected) => {
    expect(resolveEditorKeyAction(event)).toBe(expected);
  });
});
