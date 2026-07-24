import { atom } from 'jotai';

/**
 * Command atom for triggering a walkthrough from the Developer menu.
 * Central listener sets this; WalkthroughProvider watches and executes.
 */
export const walkthroughTriggerCommandAtom = atom<{
  walkthroughId: string;
  timestamp: number;
} | null>(null);

/**
 * Command atom for resetting all walkthrough state from the Developer menu.
 * Central listener increments this; WalkthroughProvider watches and executes.
 */
export const walkthroughResetCommandAtom = atom<number>(0);

/**
 * Command atom for triggering a tip from the Developer menu.
 * Central listener sets this; TipProvider watches and executes.
 */
export const tipTriggerCommandAtom = atom<{
  tipId: string;
  timestamp: number;
} | null>(null);

/**
 * Command atom for resetting all tip dismissed/completed state.
 * Central listener increments this; TipProvider watches and executes.
 */
export const tipResetCommandAtom = atom<number>(0);
