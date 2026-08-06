/**
 * Central listener for "this window's collaboration scope may now resolve
 * differently".
 *
 * A window opened before sign-in, or before its project belonged to an
 * organization, resolves its collaboration scope once and fails permanently --
 * both of those errors are deliberately non-retryable, so the docs lifecycle
 * stops instead of polling. Nothing else re-triggers resolution, so signing in
 * or creating an organization used to leave the Shared Docs gutter button, the
 * quick-open Team tab, and "Share to team" hidden until the window was
 * reopened.
 *
 * Two things can change the answer without changing the workspace path:
 *
 * - `team:workspace-org-changed`, broadcast by main after a team is created or
 *   a project is added to one.
 * - An authentication transition, read off `stytchAuthAtom` rather than the IPC
 *   event so a burst of auth-state pushes cannot tear down a live session
 *   repeatedly (see the debounce note in stytchAuthListeners).
 */

import type { Store } from 'jotai/vanilla/store';

// The store singleton, not the `store/index` barrel, which would drag every
// renderer atom module in behind it.
import { store } from '@nimbalyst/runtime/store';
import { stytchAuthAtom } from '../atoms/stytchAuth';
import { invalidateElectronCollabScopes } from '../atoms/collabDocuments';

export function initCollabScopeListeners(targetStore: Store = store): () => void {
  const unsubscribeOrgChanged = window.electronAPI.on(
    'team:workspace-org-changed',
    () => { invalidateElectronCollabScopes(); },
  );

  // Only a real sign-in/sign-out flips the answer. The atom starts null while
  // the initial auth fetch is in flight; treating that first hydration as a
  // transition would tear down the session a signed-in window just started.
  let wasAuthenticated = targetStore.get(stytchAuthAtom)?.isAuthenticated ?? null;
  const unsubscribeAuth = targetStore.sub(stytchAuthAtom, () => {
    const isAuthenticated = targetStore.get(stytchAuthAtom)?.isAuthenticated ?? null;
    if (isAuthenticated === null || wasAuthenticated === null) {
      wasAuthenticated = isAuthenticated;
      return;
    }
    if (isAuthenticated === wasAuthenticated) return;
    wasAuthenticated = isAuthenticated;
    invalidateElectronCollabScopes();
  });

  return () => {
    unsubscribeOrgChanged();
    unsubscribeAuth();
  };
}
