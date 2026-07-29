/**
 * Window Menu Bar Atom
 *
 * Holds the serialized application menu that the in-window menu bar renders on
 * Windows/Linux (macOS keeps its system menu bar and this stays empty).
 *
 * Written by store/listeners/windowMenuListeners.ts, which fetches the initial
 * model and then applies every `window-menu:changed` push from main. Components
 * read it; they never subscribe to the IPC event themselves.
 */

import { atom } from 'jotai';
import { EMPTY_MENU_BAR, type SerializedMenuBar } from '../../../shared/menuBar';

export const windowMenuBarAtom = atom<SerializedMenuBar>(EMPTY_MENU_BAR);
