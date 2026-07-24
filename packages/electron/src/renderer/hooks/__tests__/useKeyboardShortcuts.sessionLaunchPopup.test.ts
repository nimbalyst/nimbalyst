// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isSessionLaunchPopupShortcut } from '../useKeyboardShortcuts';

describe('session launch popup shortcut', () => {
  it('matches Cmd+Shift+N on macOS', () => {
    expect(isSessionLaunchPopupShortcut({
      key: 'N',
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    }, true)).toBe(true);
  });

  it('matches Ctrl+Shift+N outside macOS and rejects adjacent chords', () => {
    expect(isSessionLaunchPopupShortcut({
      key: 'n',
      metaKey: false,
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
    }, false)).toBe(true);
    expect(isSessionLaunchPopupShortcut({
      key: 'n',
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
    }, false)).toBe(false);
    expect(isSessionLaunchPopupShortcut({
      key: 'n',
      metaKey: false,
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
    }, false)).toBe(false);
  });
});
