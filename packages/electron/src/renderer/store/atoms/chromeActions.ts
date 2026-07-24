import { atom } from 'jotai';

/**
 * DOM slot in the window chrome (title bar) where the active mode portals its
 * "+ New" create launcher. WindowTopBar owns the slot's position (pinned to the
 * sidebar's right edge); each mode's panel fills it with its own mode-aware
 * button + menu via a React portal. Null when no slot is mounted (e.g. a mode
 * without a left sidebar), which tells panels not to portal.
 */
export const chromeNewSlotAtom = atom<HTMLElement | null>(null);
