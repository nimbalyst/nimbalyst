export type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>;

// Alt is excluded because the editor binds Cmd/Ctrl+Alt+1-3 to heading levels.
// On Linux and Windows those chords still report the digit in `key`, so without
// this guard the tab jump fires alongside the heading change; macOS is spared
// only because Option rewrites `key` to a non-digit character.
export const isTabJumpShortcut = (event: ShortcutEvent): boolean =>
  (event.metaKey || event.ctrlKey) && !event.altKey && /^[1-9]$/.test(event.key);
