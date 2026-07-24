/**
 * Jotai atoms for Walkthrough Guide System
 *
 * These atoms manage walkthrough state across the application.
 * State is synced with the main process store for persistence.
 */

import { atom } from 'jotai';
import type { WalkthroughState } from './types';

/**
 * Walkthrough state from main process.
 * Initialized on app load, updated when walkthroughs are completed/dismissed.
 */
export const walkthroughStateAtom = atom<WalkthroughState | null>(null);

/**
 * Whether walkthroughs are globally enabled.
 * Derived from walkthroughStateAtom for convenience.
 */
export const walkthroughsEnabledAtom = atom(
  (get) => get(walkthroughStateAtom)?.enabled ?? true
);

/**
 * ID of the currently active walkthrough (if any).
 * null means no walkthrough is showing.
 */
export const activeWalkthroughIdAtom = atom<string | null>(null);

/**
 * Current step index within the active walkthrough.
 */
export const currentStepIndexAtom = atom(0);

/**
 * Derived atom: whether any walkthrough is currently active.
 */
export const isWalkthroughActiveAtom = atom(
  (get) => get(activeWalkthroughIdAtom) !== null
);

/**
 * Completed walkthrough IDs (for quick lookup).
 */
export const completedWalkthroughsAtom = atom(
  (get) => new Set(get(walkthroughStateAtom)?.completed ?? [])
);

/**
 * Dismissed walkthrough IDs (for quick lookup).
 */
export const dismissedWalkthroughsAtom = atom(
  (get) => new Set(get(walkthroughStateAtom)?.dismissed ?? [])
);
