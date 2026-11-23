// @vitest-environment node
import { EventEmitter } from 'events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ windows: [] as unknown[], showMessageBoxSync: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => electron.windows },
  dialog: { showMessageBoxSync: electron.showMessageBoxSync },
}));

import {
  approveAllHookLeaves,
  confirmLeaveHookEdits,
  confirmQuitWithHookEdits,
  guardHookEditorUnload,
  setHookEditorUnsaved,
  withdrawHookLeaves,
} from '../hookEditorUnsaved';

const LEAVE = 0;
const STAY = 1;
type FakeWindow = EventEmitter & {
  webContents: EventEmitter & { id: number };
  isDestroyed: () => boolean;
  isFocused: () => boolean;
};

let nextId = 1;
function fakeWindow(): FakeWindow {
  const webContents = Object.assign(new EventEmitter(), { id: nextId++ });
  const window = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false, isFocused: () => false });
  guardHookEditorUnload(window as never);
  return window;
}

/** Fires the event Electron sends when a page's beforeunload holds it. True means the unload goes ahead. */
function unload(window: FakeWindow): boolean {
  const event = { preventDefault: vi.fn() };
  window.webContents.emit('will-prevent-unload', event);
  return event.preventDefault.mock.calls.length > 0;
}

/** Fires a window close. True means the close ended prevented. */
function close(window: FakeWindow, alreadyPrevented = false): boolean {
  const event = {
    defaultPrevented: alreadyPrevented,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  window.emit('close', event);
  return event.defaultPrevented;
}

beforeEach(() => {
  electron.showMessageBoxSync.mockReset();
  electron.windows = [];
  vi.stubEnv('PLAYWRIGHT', '');
});
afterEach(() => vi.unstubAllEnvs());

it('asks only while a window has unsaved hook changes, and Stay keeps the page', () => {
  const window = fakeWindow();
  expect(unload(window)).toBe(false);
  expect(electron.showMessageBoxSync).not.toHaveBeenCalled();

  setHookEditorUnsaved(window.webContents.id, true);
  electron.showMessageBoxSync.mockReturnValue(STAY);
  expect(unload(window)).toBe(false);
  expect(electron.showMessageBoxSync.mock.calls[0][1].buttons).toEqual(['Leave without saving', 'Stay']);

  electron.showMessageBoxSync.mockReturnValue(LEAVE);
  expect(unload(window)).toBe(true);

  // The reloaded page has no hook editor open, so new changes ask again.
  window.webContents.emit('did-finish-load');
  expect(unload(window)).toBe(false);
  setHookEditorUnsaved(window.webContents.id, true);
  setHookEditorUnsaved(window.webContents.id, false);
  expect(unload(window)).toBe(false);
  expect(electron.showMessageBoxSync).toHaveBeenCalledTimes(2);
});

it('asks once for a quit, then lets every window with hook changes close without asking again', () => {
  const [a, b, clean] = [fakeWindow(), fakeWindow(), fakeWindow()];
  electron.windows = [a, b, clean];
  setHookEditorUnsaved(a.webContents.id, true);
  setHookEditorUnsaved(b.webContents.id, true);

  electron.showMessageBoxSync.mockReturnValue(STAY);
  expect(confirmQuitWithHookEdits()).toBe(false);
  expect(electron.showMessageBoxSync.mock.calls[0][1].buttons).toEqual(['Quit without saving', 'Stay']);
  expect(electron.showMessageBoxSync.mock.calls[0][0]).toBe(a);

  // The question attaches to the focused window when it has hook changes.
  b.isFocused = () => true;
  expect(confirmQuitWithHookEdits()).toBe(false);
  expect(electron.showMessageBoxSync.mock.calls[1][0]).toBe(b);
  b.isFocused = () => false;

  electron.showMessageBoxSync.mockReturnValue(LEAVE);
  expect(confirmQuitWithHookEdits()).toBe(true);
  expect(unload(a)).toBe(true);
  expect(unload(b)).toBe(true);
  expect(confirmLeaveHookEdits(a as never)).toBe(true);
  expect(unload(clean)).toBe(false);
  // A second quit pass (for example after a migration drain) does not ask again.
  expect(confirmQuitWithHookEdits()).toBe(true);
  expect(electron.showMessageBoxSync).toHaveBeenCalledTimes(3);
});

it('never shows a question during E2E runs, and forgets a closed window', () => {
  const window = fakeWindow();
  setHookEditorUnsaved(window.webContents.id, true);
  vi.stubEnv('PLAYWRIGHT', '1');
  expect(unload(window)).toBe(true);
  vi.stubEnv('PLAYWRIGHT', '');

  const closed = fakeWindow();
  setHookEditorUnsaved(closed.webContents.id, true);
  closed.webContents.emit('destroyed');
  expect(confirmLeaveHookEdits(closed as never)).toBe(true);
  expect(electron.showMessageBoxSync).not.toHaveBeenCalled();
});

it('approves every window for a restart, and takes the approval back when a later step cancels the quit', () => {
  const [a, b, plain] = [fakeWindow(), fakeWindow(), fakeWindow()];
  setHookEditorUnsaved(a.webContents.id, true);
  setHookEditorUnsaved(b.webContents.id, true);

  approveAllHookLeaves();
  expect(confirmLeaveHookEdits(a as never)).toBe(true);
  expect(confirmLeaveHookEdits(b as never)).toBe(true);
  expect(electron.showMessageBoxSync).not.toHaveBeenCalled();

  withdrawHookLeaves();
  electron.showMessageBoxSync.mockReturnValue(STAY);
  expect(confirmLeaveHookEdits(a as never)).toBe(false);
  expect(confirmLeaveHookEdits(b as never)).toBe(false);
  expect(electron.showMessageBoxSync).toHaveBeenCalledTimes(2);

  // A window that never had hook changes gets no state from either call.
  electron.showMessageBoxSync.mockClear();
  expect(confirmLeaveHookEdits(plain as never)).toBe(true);
  expect(electron.showMessageBoxSync).not.toHaveBeenCalled();
});

it('a window close asks before teardown and Stay keeps the close stopped', () => {
  const window = fakeWindow();
  setHookEditorUnsaved(window.webContents.id, true);

  electron.showMessageBoxSync.mockReturnValue(STAY);
  expect(close(window)).toBe(true);
  expect(electron.showMessageBoxSync).toHaveBeenCalledTimes(1);

  electron.showMessageBoxSync.mockReturnValue(LEAVE);
  expect(close(window)).toBe(false);
  expect(electron.showMessageBoxSync).toHaveBeenCalledTimes(2);
  // The page's own unload then goes ahead with no second question.
  expect(unload(window)).toBe(true);
  expect(electron.showMessageBoxSync).toHaveBeenCalledTimes(2);

  const plain = fakeWindow();
  electron.showMessageBoxSync.mockClear();
  expect(close(plain)).toBe(false);

  // A close that an earlier listener already stopped asks nothing.
  const held = fakeWindow();
  setHookEditorUnsaved(held.webContents.id, true);
  expect(close(held, true)).toBe(true);
  expect(electron.showMessageBoxSync).not.toHaveBeenCalled();
});
