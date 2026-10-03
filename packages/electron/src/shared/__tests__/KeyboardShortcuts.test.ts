import { describe, expect, it } from 'vitest';
import {
  KeyboardShortcuts,
  getElectronAccelerator,
  getShortcutDisplay,
} from '../KeyboardShortcuts';

describe('getShortcutDisplay', () => {
  describe('on macOS', () => {
    it('renders Cmd as ⌘ and drops the + separators', () => {
      expect(getShortcutDisplay('Cmd+Shift+L', true)).toBe('⌘⇧L');
    });

    it('renders Option as ⌥ and Alt as ⌥', () => {
      expect(getShortcutDisplay('Cmd+Option+W', true)).toBe('⌘⌥W');
      expect(getShortcutDisplay('Cmd+Alt+I', true)).toBe('⌘⌥I');
    });

    it('renders Ctrl as ⌃ when present', () => {
      expect(getShortcutDisplay('Ctrl+Cmd+F', true)).toBe('⌃⌘F');
    });

    it('handles single-modifier shortcuts', () => {
      expect(getShortcutDisplay('Cmd+S', true)).toBe('⌘S');
      expect(getShortcutDisplay('Shift+Tab', true)).toBe('⇧Tab');
    });
  });

  describe('on non-macOS platforms', () => {
    it('rewrites Cmd to Ctrl and keeps the + separators', () => {
      expect(getShortcutDisplay('Cmd+Shift+L', false)).toBe('Ctrl+Shift+L');
    });

    it('rewrites Option to Alt and keeps Alt as Alt', () => {
      expect(getShortcutDisplay('Cmd+Option+W', false)).toBe('Ctrl+Alt+W');
      expect(getShortcutDisplay('Cmd+Alt+I', false)).toBe('Ctrl+Alt+I');
    });

    it('passes Shift through unchanged', () => {
      expect(getShortcutDisplay('Cmd+Shift+A', false)).toBe('Ctrl+Shift+A');
    });

    it('does not produce any Mac glyphs', () => {
      const out = getShortcutDisplay('Cmd+Option+Shift+Ctrl+X', false);
      expect(out).not.toMatch(/[⌘⇧⌥⌃]/);
    });
  });

  describe('with the real KeyboardShortcuts constants', () => {
    it('promptQuickOpen renders correctly on each platform', () => {
      expect(
        getShortcutDisplay(KeyboardShortcuts.window.promptQuickOpen, true),
      ).toBe('⌘⇧L');
      expect(
        getShortcutDisplay(KeyboardShortcuts.window.promptQuickOpen, false),
      ).toBe('Ctrl+Shift+L');
    });

    it('toggleAIChat renders correctly on each platform', () => {
      expect(
        getShortcutDisplay(KeyboardShortcuts.view.toggleAIChat, true),
      ).toBe('⌘⇧A');
      expect(
        getShortcutDisplay(KeyboardShortcuts.view.toggleAIChat, false),
      ).toBe('Ctrl+Shift+A');
    });

    it('contentSearch renders correctly on each platform', () => {
      expect(
        getShortcutDisplay(KeyboardShortcuts.window.contentSearch, true),
      ).toBe('⌘⇧F');
      expect(
        getShortcutDisplay(KeyboardShortcuts.window.contentSearch, false),
      ).toBe('Ctrl+Shift+F');
    });

    it('pasteAsText renders correctly on each platform', () => {
      expect(
        getShortcutDisplay(KeyboardShortcuts.edit.pasteAsText, true),
      ).toBe('⌘⇧V');
      expect(
        getShortcutDisplay(KeyboardShortcuts.edit.pasteAsText, false),
      ).toBe('Ctrl+Shift+V');
    });
  });
});

describe('toggleExpandedTab binding', () => {
  // Electron silently lets a later menu accelerator shadow an earlier one, so a
  // collision would show up only as "the shortcut stopped working". Shift+Escape
  // is deliberately modifier-light; guard it against future bindings.
  it('does not collide with any other application shortcut', () => {
    const others = Object.entries(KeyboardShortcuts).flatMap(([group, shortcuts]) =>
      Object.entries(shortcuts)
        .filter(([name]) => !(group === 'view' && name === 'toggleExpandedTab'))
        .map(([name, accelerator]) => `${group}.${name}=${accelerator}`),
    );

    expect(
      others.filter((entry) => entry.endsWith(`=${KeyboardShortcuts.view.toggleExpandedTab}`)),
    ).toEqual([]);
  });

  it('survives accelerator conversion unchanged (no Cmd to remap)', () => {
    expect(getElectronAccelerator(KeyboardShortcuts.view.toggleExpandedTab))
      .toBe(KeyboardShortcuts.view.toggleExpandedTab);
  });
});

describe('terminal split bindings', () => {
  it('renders the backslash chords on each platform', () => {
    const [right, down] = [
      KeyboardShortcuts.view.splitTerminalRight,
      KeyboardShortcuts.view.splitTerminalDown,
    ];
    expect(getShortcutDisplay(right, true)).toBe('⌘\\');
    expect(getShortcutDisplay(right, false)).toBe('Ctrl+\\');
    expect(getShortcutDisplay(down, true)).toBe('⌘⇧\\');
    expect(getShortcutDisplay(down, false)).toBe('Ctrl+Shift+\\');
  });

  // The backslash chords live only in the splitTerminal* bindings; a later
  // binding on the same key would shadow them in the Electron menu silently.
  it('leaves no other declared shortcut on a backslash key', () => {
    const backslashEntries = Object.entries(KeyboardShortcuts).flatMap(([group, shortcuts]) =>
      Object.entries(shortcuts)
        .filter(([name]) => !(group === 'view' && name.startsWith('splitTerminal')))
        .filter(([, accelerator]) => accelerator.includes('\\'))
        .map(([name, accelerator]) => `${group}.${name}=${accelerator}`),
    );

    expect(backslashEntries).toEqual([]);
  });
});

describe('getElectronAccelerator', () => {
  it('rewrites Cmd to CmdOrCtrl so Electron handles platform mapping', () => {
    expect(getElectronAccelerator('Cmd+S')).toBe('CmdOrCtrl+S');
    expect(getElectronAccelerator('Cmd+Shift+L')).toBe('CmdOrCtrl+Shift+L');
  });

  it('leaves shortcuts without Cmd unchanged', () => {
    expect(getElectronAccelerator('Ctrl+`')).toBe('Ctrl+`');
    expect(getElectronAccelerator('F11')).toBe('F11');
  });
});
