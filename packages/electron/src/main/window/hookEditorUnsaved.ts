/**
 * Asks before a window throws away unsaved hook editor changes.
 *
 * The hook editor tells the main process when it has unsaved changes, and it holds the page with a
 * beforeunload listener. Electron then sends will-prevent-unload for a reload, a window close or a quit,
 * and this module shows one native question. A window with no hook changes keeps its old behaviour.
 */

import { BrowserWindow, dialog, type MessageBoxSyncOptions } from 'electron';

type HookEditState = 'unsaved' | 'leaveApproved';

/** One entry per window that has unsaved hook changes, keyed by webContents id. */
const states = new Map<number, HookEditState>();

const LEAVE_BUTTON = 0;

export function setHookEditorUnsaved(webContentsId: number, unsaved: boolean): void {
  if (unsaved) states.set(webContentsId, 'unsaved');
  else states.delete(webContentsId);
}

export function leaveQuestion(action: 'leave' | 'quit'): MessageBoxSyncOptions {
  const verb = action === 'quit' ? 'quit' : 'leave';
  return {
    type: 'warning',
    title: 'Unsaved hook changes',
    message: 'Your hook changes are not saved.',
    detail: `If you ${verb} now, the changes are lost. To keep them, choose Stay, then Review and save.`,
    buttons: [action === 'quit' ? 'Quit without saving' : 'Leave without saving', 'Stay'],
    defaultId: 1,
    cancelId: 1,
  };
}

/** True when the window may go: it has no unsaved hook changes, or the user chose to leave. */
export function confirmLeaveHookEdits(window: BrowserWindow, action: 'leave' | 'quit' = 'leave'): boolean {
  const id = window.webContents.id;
  const state = states.get(id);
  if (state === undefined || state === 'leaveApproved') return true;
  // E2E tests close the app at the end of each test. A native question would stop that close.
  if (process.env.PLAYWRIGHT || dialog.showMessageBoxSync(window, leaveQuestion(action)) === LEAVE_BUTTON) {
    states.set(id, 'leaveApproved');
    return true;
  }
  return false;
}

/** Asks one time before a quit when any window has unsaved hook changes. False means the user chose Stay. */
export function confirmQuitWithHookEdits(): boolean {
  const windows = BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && states.get(window.webContents.id) === 'unsaved',
  );
  if (windows.length === 0) return true;
  const parent = windows.find((window) => window.isFocused()) ?? windows[0];
  if (!confirmLeaveHookEdits(parent, 'quit')) return false;
  for (const window of windows) states.set(window.webContents.id, 'leaveApproved');
  return true;
}

/** Restart and update paths call this: every window may go without a question. */
export function approveAllHookLeaves(): void {
  for (const id of states.keys()) states.set(id, 'leaveApproved');
}

/** A later step cancelled the quit: windows that were approved to go have unsaved changes again. */
export function withdrawHookLeaves(): void {
  for (const [id, state] of states) if (state === 'leaveApproved') states.set(id, 'unsaved');
}

/** Answers Electron when the hook editor holds the page, so the user decides. */
export function guardHookEditorUnload(window: BrowserWindow): void {
  const contents = window.webContents;
  const id = contents.id;
  // A window close asks here, before the window manager tears the window down. Stay keeps the window as it was.
  window.on('close', (event) => {
    if (event.defaultPrevented) return;
    if (!confirmLeaveHookEdits(window)) event.preventDefault();
  });
  contents.on('will-prevent-unload', (event) => {
    // No hook changes in this window: the page's own beforeunload decides, as before.
    if (!states.has(id)) return;
    // preventDefault here lets the unload go ahead.
    if (confirmLeaveHookEdits(window)) event.preventDefault();
  });
  // A page that finished loading has no hook editor open yet.
  contents.on('did-finish-load', () => states.delete(id));
  contents.once('destroyed', () => states.delete(id));
}
