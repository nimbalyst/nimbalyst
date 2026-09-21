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
  organizationDirectoryStateAtom,
  personalAccountsAtom,
  type PersonalAccountSummary,
} from '../atoms/settingsDomains';
import { createOrganizationDirectoryLoader } from './organizationDirectoryLoader';
import { bucketOrganizationCount } from '../../../shared/analytics/teamAnalytics';
import { trackTeamAnalyticsEvent } from '../../utils/teamAnalytics';

let initialized = false;
let directoryLoader: ReturnType<typeof createOrganizationDirectoryLoader> | undefined;

export function refreshOrganizationDirectory(): void {
  directoryLoader?.refresh();
}

async function trackMembershipSignInCompleted(userId: string | null): Promise<void> {
  // The auth broadcast reaches every project window, so the sign-in has to be
  // attributed once. Main arbitrates (see SignInAttribution): sign-in completes
  // in an external browser, so gating on this window's focus dropped the event
  // whenever the app was still in the background -- and `document.hasFocus()`
  // is true in every window at once anyway, so it never deduplicated either.
  const claim = window.electronAPI?.team?.claimSignInAttribution;
  if (claim && await claim(userId ?? 'unknown-user') === false) return;
  const result = await window.electronAPI?.team?.list?.({ forceRefresh: true });
  if (!result?.success || !result.teams?.length) return;

  const hasActive = result.teams.some((team: { membershipType?: string }) => (
    !team.membershipType || team.membershipType === 'active_member'
  ));
  const hasPending = result.teams.some((team: { membershipType?: string }) => (
    !!team.membershipType && team.membershipType !== 'active_member'
  ));
  trackTeamAnalyticsEvent('team_sign_in_completed', {
    surface: 'desktop',
    membershipState: hasActive && hasPending ? 'mixed' : hasActive ? 'active' : 'pending',
    organizationCountBucket: bucketOrganizationCount(result.teams.length),
  });
}

export async function refreshPersonalAccountsDirectory(): Promise<PersonalAccountSummary[]> {
  const stytch = window.electronAPI?.stytch;
  if (!stytch) {
    store.set(personalAccountsAtom, []);
    return [];
  }
  const accounts = await stytch.getAccounts();
  if (!Array.isArray(accounts)) throw new Error('Accounts could not be loaded.');
  store.set(personalAccountsAtom, accounts as PersonalAccountSummary[]);
  // Explicit account changes also invalidate any directory request in flight.
  directoryLoader?.refresh();
  return accounts as PersonalAccountSummary[];
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

  const loader = createOrganizationDirectoryLoader({
    getAuth: async () => {
      const state = await stytch.getAuthState();
      if (!state) throw new Error('Account status could not be loaded.');
      return { isAuthenticated: !!state.isAuthenticated, user: state.user ?? null };
    },
    getAccounts: async () => {
      const accounts = await stytch.getAccounts();
      if (!Array.isArray(accounts)) throw new Error('Accounts could not be loaded.');
      return accounts as PersonalAccountSummary[];
    },
    list: (options) => window.electronAPI.team.list(options),
    setAuth: (auth) => store.set(stytchAuthAtom, auth),
    setAccounts: (accounts) => store.set(personalAccountsAtom, accounts),
    publish: (snapshot) => store.set(organizationDirectoryStateAtom, snapshot),
  });
  directoryLoader = loader;

  const unsubscribe = stytch.onAuthStateChange?.((state: { isAuthenticated?: boolean; user?: StytchAuthSnapshot['user'] }) => {
    const wasAuthenticated = store.get(stytchAuthAtom)?.isAuthenticated ?? false;
    const isAuthenticated = !!state?.isAuthenticated;
    store.set(stytchAuthAtom, {
      isAuthenticated,
      user: state?.user ?? null,
    });
    if (isAuthenticated && !wasAuthenticated) {
      void trackMembershipSignInCompleted(state?.user?.user_id ?? null).catch(() => {});
    }
    loader.authChanged({ isAuthenticated, user: state.user ?? null });
  });

  void stytch.subscribeAuthState?.();
  const handleOrganizationsChanged = () => { loader.organizationsChanged(); };
  window.addEventListener('nimbalyst:organizations-changed', handleOrganizationsChanged);

  return () => {
    initialized = false;
    loader.dispose();
    if (directoryLoader === loader) directoryLoader = undefined;
    unsubscribe?.();
    window.removeEventListener('nimbalyst:organizations-changed', handleOrganizationsChanged);
  };
}
