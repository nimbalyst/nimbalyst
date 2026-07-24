/**
 * Theme Fallback Atom
 *
 * Mirrors the `pendingThemeFallback` value in the main app-settings store.
 * Set when the active theme disappeared and the runtime applied a fallback;
 * cleared when the user explicitly applies a theme or dismisses the banner.
 *
 * Updated by store/listeners/themeFallbackListeners.ts.
 */

import { atom } from 'jotai';

export interface PendingThemeFallback {
  missingId: string;
  appliedId: string;
}

export const pendingThemeFallbackAtom = atom<PendingThemeFallback | null>(null);
