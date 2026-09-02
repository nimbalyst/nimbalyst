// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isTabJumpShortcut, type ShortcutEvent } from '../tabShortcuts';

const event = (overrides: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key: '1',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...overrides,
});

describe('tab jump shortcut', () => {
  it('matches Cmd+1 and Ctrl+1', () => {
    expect(isTabJumpShortcut(event({ metaKey: true }))).toBe(true);
    expect(isTabJumpShortcut(event({ ctrlKey: true }))).toBe(true);
  });

  it('ignores the editor heading chords Cmd/Ctrl+Alt+1-9', () => {
    expect(isTabJumpShortcut(event({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isTabJumpShortcut(event({ metaKey: true, altKey: true }))).toBe(false);
    expect(isTabJumpShortcut(event({ key: '3', ctrlKey: true, altKey: true }))).toBe(false);
  });

  it('ignores digits without Cmd/Ctrl and non-digit keys', () => {
    expect(isTabJumpShortcut(event())).toBe(false);
    expect(isTabJumpShortcut(event({ key: '0', ctrlKey: true }))).toBe(false);
    expect(isTabJumpShortcut(event({ key: 'a', ctrlKey: true }))).toBe(false);
  });
});
