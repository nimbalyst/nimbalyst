/**
 * Central Menu Command Listeners
 *
 * Subscribes to find-related menu IPC events ONCE and bumps counter atoms.
 * useIPCHandlers reads the counters and routes the command (editor mode vs
 * agent mode).
 *
 * Call initMenuCommandListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import {
  menuFindCommandAtom,
  menuFindNextCommandAtom,
  menuFindPreviousCommandAtom,
} from '../atoms/menuCommands';

let initialized = false;

export function initMenuCommandListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const cleanups: Array<() => void> = [];

  const u1 = window.electronAPI?.on?.('menu:find', () => {
    store.set(menuFindCommandAtom, (v) => v + 1);
  });
  if (typeof u1 === 'function') cleanups.push(u1);

  const u2 = window.electronAPI?.on?.('menu:find-next', () => {
    store.set(menuFindNextCommandAtom, (v) => v + 1);
  });
  if (typeof u2 === 'function') cleanups.push(u2);

  const u3 = window.electronAPI?.on?.('menu:find-previous', () => {
    store.set(menuFindPreviousCommandAtom, (v) => v + 1);
  });
  if (typeof u3 === 'function') cleanups.push(u3);

  return () => {
    initialized = false;
    cleanups.forEach((c) => c());
  };
}
