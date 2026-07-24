/**
 * History Dialog Atom
 *
 * Tracks which file (if any) is being viewed in the global file-history dialog.
 * `null` means the dialog is closed.
 *
 * Any entry point that wants to open the dialog (editor header bar, tab context
 * menu, file tree context menu, keyboard shortcut, etc.) sets this atom directly
 * with the file path. The dialog is mounted once at the app root and reads from
 * here, so no callback prop drilling is needed.
 */

import { atom } from 'jotai';

export const historyDialogFileAtom = atom<string | null>(null);
