/**
 * Sheet-level shortcuts the grid key controller does not own: history,
 * text styles, number formats, insert date and link, the shortcut sheet, and the
 * paste-values flag. Pure, so the key table is testable without a DOM.
 */

import type { GridKeyEvent, KeyboardPlatform } from './types';

export type SheetShortcut =
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'formatCurrency'
  | 'formatPercent'
  | 'formatNumber'
  | 'insertDate'
  | 'insertLink'
  | 'showShortcuts'
  | 'pasteValues';

export interface ShortcutKeyEvent extends GridKeyEvent {
  /** Physical key; Shift+4 is `$` on US layouts and something else elsewhere. */
  readonly code?: string;
}

export function resolveSheetShortcut(event: ShortcutKeyEvent, platform: KeyboardPlatform): SheetShortcut | null {
  if (event.isComposing) return null;
  const primary = platform.isMac ? !!event.metaKey : !!event.ctrlKey;
  if (!primary || event.altKey) return null;
  const key = event.key.toLowerCase();
  const shift = !!event.shiftKey;

  if (key === 'z') return shift ? 'redo' : 'undo';
  if (key === 'y' && !platform.isMac && !shift) return 'redo';
  if (shift) {
    if (event.code === 'Digit4') return 'formatCurrency';
    if (event.code === 'Digit5') return 'formatPercent';
    if (event.code === 'Digit1') return 'formatNumber';
    if (key === 'v') return 'pasteValues';
    return null;
  }
  if (key === 'b') return 'bold';
  if (key === 'i') return 'italic';
  if (key === 'u') return 'underline';
  if (key === ';') return 'insertDate';
  if (key === 'k') return 'insertLink';
  if (key === '/') return 'showShortcuts';
  return null;
}

/** Today as `YYYY-MM-DD`, the date shape fill series and typed columns both read. */
export function todayIso(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The list the Cmd+/ sheet shows. `mod` renders as Cmd or Ctrl. */
export const SHORTCUT_SHEET: readonly { readonly group: string; readonly items: readonly (readonly [string, string])[] }[] = [
  {
    group: 'Navigate',
    items: [
      ['Arrows', 'Move'],
      ['mod+Arrow', 'Jump to the edge of the data'],
      ['Shift+Arrow / mod+Shift+Arrow', 'Extend the selection'],
      ['Home / End', 'Start / end of the row'],
      ['mod+Home / mod+End', 'First cell / last used cell'],
      ['PageUp / PageDown', 'Move by a page'],
      ['Shift+Space / Ctrl+Space', 'Select rows / columns'],
      ['mod+A', 'Select all'],
    ],
  },
  {
    group: 'Edit',
    items: [
      ['Enter / F2', 'Edit the cell'],
      ['Enter / Tab', 'Commit and move down / right'],
      ['Escape', 'Cancel the edit'],
      ['Alt+Enter', 'New line in the cell'],
      ['mod+Enter', 'Fill the selection with the value being typed'],
      ['mod+D / mod+R', 'Fill down / right'],
      ['Delete', 'Clear the selection'],
      ['mod+;', 'Insert today\'s date'],
      ['mod+K', 'Insert or edit a link'],
      ['mod+Z / mod+Shift+Z', 'Undo / redo'],
    ],
  },
  {
    group: 'Clipboard',
    items: [
      ['mod+C / mod+X / mod+V', 'Copy / cut / paste'],
      ['mod+Shift+V', 'Paste values only'],
    ],
  },
  {
    group: 'Format',
    items: [
      ['mod+B / mod+I / mod+U', 'Bold / italic / underline'],
      ['mod+Shift+4', 'Currency'],
      ['mod+Shift+5', 'Percent'],
      ['mod+Shift+1', 'Number'],
      ['mod+/', 'Show this list'],
    ],
  },
];
