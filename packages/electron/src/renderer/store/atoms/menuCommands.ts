/**
 * Menu Command Atoms
 *
 * Counter atoms incremented every time a menu-driven command IPC event
 * arrives. Components watch the counters via useEffect to react.
 *
 * Updated by store/listeners/menuCommandListeners.ts.
 */

import { atom } from 'jotai';

export const menuFindCommandAtom = atom(0);
export const menuFindNextCommandAtom = atom(0);
export const menuFindPreviousCommandAtom = atom(0);
