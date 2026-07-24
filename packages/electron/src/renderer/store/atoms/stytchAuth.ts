/**
 * Stytch Auth State Atom
 *
 * Holds the latest auth snapshot pushed from the main process via the
 * `stytch:auth-state-change` IPC event (wired through `electronAPI.stytch.onAuthStateChange`).
 *
 * Updated by store/listeners/stytchAuthListeners.ts -- components MUST NOT
 * subscribe to onAuthStateChange directly. Read from this atom instead.
 *
 * `null` means "not yet loaded" -- distinguish from "loaded and signed out"
 * so the UI can avoid flashing the logged-out state during startup.
 */

import { atom } from 'jotai';

export interface StytchAuthSnapshot {
  isAuthenticated: boolean;
  user: {
    user_id: string;
    emails?: Array<{ email_id?: string; email: string; verified?: boolean }>;
    name?: { first_name?: string; last_name?: string };
  } | null;
}

export const stytchAuthAtom = atom<StytchAuthSnapshot | null>(null);

/** Convenience: true once the initial fetch has resolved AND the user is signed in. */
export const stytchIsSignedInAtom = atom<boolean | null>((get) => {
  const snap = get(stytchAuthAtom);
  if (snap === null) return null;
  return snap.isAuthenticated;
});
