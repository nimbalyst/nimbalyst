/**
 * Whether THIS renderer window is the OS-focused (key) window (NIM-849).
 *
 * Seeded and updated from the main process's per-window `browser-window-focus`/
 * `blur` events (see windowFocusListeners). Use this instead of the renderer's
 * `document.hasFocus()`, which reports true for every window while the app is the
 * active application and so cannot distinguish a background window from the
 * foreground one.
 *
 * Defaults to false: a window is treated as un-focused until main confirms it is
 * the key window, so nothing focus-gated (e.g. the genuine Claude CLI launch)
 * fires in a background window.
 */
import { atom } from 'jotai';

export const windowFocusedAtom = atom<boolean>(false);
