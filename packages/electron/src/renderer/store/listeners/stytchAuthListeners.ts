/**
 * Central Stytch Auth State Listener
 *
 * Subscribes to `electronAPI.stytch.onAuthStateChange` ONCE at app startup
 * and writes the latest snapshot to `stytchAuthAtom`. Components read from
 * the atom and MUST NOT subscribe to the IPC event directly (see IPC_LISTENERS.md).
 *
 * Also performs the initial `getAuthState()` fetch so consumers can render
 * synchronously off the atom without each one re-fetching.
 *
 * Call initStytchAuthListeners() once in App.tsx on mount.
 */

import { store } from '@nimbalyst/runtime/store';
import { stytchAuthAtom, type StytchAuthSnapshot } from '../atoms/stytchAuth';
import {
  organizationDirectoryAtom,
  personalAccountsAtom,
  type OrganizationDirectoryEntry,
  type PersonalAccountSummary,
} from '../atoms/settingsDomains';

let initialized = false;

export async function refreshPersonalAccountsDirectory(): Promise<PersonalAccountSummary[]> {
  const stytch = window.electronAPI?.stytch;
  if (!stytch) {
    store.set(personalAccountsAtom, []);
    return [];
  }
  try {
    const accounts = (await stytch.getAccounts() ?? []) as PersonalAccountSummary[];
    store.set(personalAccountsAtom, accounts);
    return accounts;
  } catch {
    store.set(personalAccountsAtom, []);
    return [];
  }
}

export function initStytchAuthListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const stytch = window.electronAPI?.stytch;
  if (!stytch) {
    return () => {
      initialized = false;
    };
  }

  const loadIdentityDirectory = async () => {
    await refreshPersonalAccountsDirectory();
    try {
      const result = await window.electronAPI?.team?.list?.();
      store.set(
        organizationDirectoryAtom,
        result?.success && Array.isArray(result.teams)
          ? result.teams as OrganizationDirectoryEntry[]
          : [],
      );
    } catch {
      store.set(organizationDirectoryAtom, []);
    }
  };

  // Initial fetch -- atom stays null until this resolves so the UI can
  // distinguish "still loading" from "loaded and signed out".
  stytch.getAuthState()
    .then((state) => {
      store.set(stytchAuthAtom, {
        isAuthenticated: !!state?.isAuthenticated,
        user: state?.user ?? null,
      } satisfies StytchAuthSnapshot);
      void loadIdentityDirectory();
    })
    .catch(() => {
      // Treat fetch failure as signed-out rather than leaving the atom null
      // forever -- otherwise the UI never resolves out of its loading state.
      store.set(stytchAuthAtom, { isAuthenticated: false, user: null });
    });

  const unsubscribe = stytch.onAuthStateChange?.((state: { isAuthenticated?: boolean; user?: StytchAuthSnapshot['user'] }) => {
    store.set(stytchAuthAtom, {
      isAuthenticated: !!state?.isAuthenticated,
      user: state?.user ?? null,
    });
    void loadIdentityDirectory();
  });

  void stytch.subscribeAuthState?.();
  const handleOrganizationsChanged = () => { void loadIdentityDirectory(); };
  window.addEventListener('nimbalyst:organizations-changed', handleOrganizationsChanged);

  return () => {
    initialized = false;
    unsubscribe?.();
    window.removeEventListener('nimbalyst:organizations-changed', handleOrganizationsChanged);
  };
}
