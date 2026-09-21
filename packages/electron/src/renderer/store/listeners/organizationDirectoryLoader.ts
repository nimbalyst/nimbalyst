import type { OrganizationDirectoryResult, OrganizationDirectorySnapshot } from '../../../shared/organizationDirectory';
import type { PersonalAccountSummary } from '../atoms/settingsDomains';
import type { StytchAuthSnapshot } from '../atoms/stytchAuth';

// Match Inbox's bounded startup recovery; a token-ready event is not guaranteed.
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];

interface Dependencies {
  getAuth: () => Promise<StytchAuthSnapshot>;
  getAccounts: () => Promise<PersonalAccountSummary[]>;
  list: (options?: { forceRefresh?: boolean }) => Promise<OrganizationDirectoryResult>;
  setAuth: (auth: StytchAuthSnapshot) => void;
  setAccounts: (accounts: PersonalAccountSummary[]) => void;
  publish: (snapshot: OrganizationDirectorySnapshot) => void;
}

export function createOrganizationDirectoryLoader(deps: Dependencies) {
  let snapshot: OrganizationDirectorySnapshot = { entries: [], status: 'loading', complete: false };
  let disposed = false;
  let generation = 0;
  let inFlight = false;
  let queued = false;
  let forceRefresh = false;
  let attempts = 0;
  let exhausted = false;
  let context: string | undefined;
  let authIdentity: string | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const publish = (next: OrganizationDirectorySnapshot) => {
    snapshot = next;
    deps.publish(next);
  };
  const clearRetry = () => { clearTimeout(retryTimer); retryTimer = undefined; };
  const resetRecovery = () => { clearRetry(); attempts = 0; exhausted = false; };
  const identity = (auth: StytchAuthSnapshot) => JSON.stringify([auth.isAuthenticated, auth.user?.user_id]);
  const signOut = () => {
    resetRecovery();
    context = undefined;
    publish({ entries: [], status: 'signed-out', complete: false });
  };

  const unavailable = (error: string, retryable = true) => {
    const delay = RETRY_DELAYS_MS[attempts];
    clearRetry();
    if (!retryable || delay === undefined) {
      exhausted = true;
      publish({ ...snapshot, status: 'error', complete: false, error });
      return;
    }
    attempts += 1;
    publish({ ...snapshot, status: 'loading', complete: false, error });
    retryTimer = setTimeout(() => { retryTimer = undefined; void load(); }, delay);
  };

  async function load(): Promise<void> {
    if (disposed) return;
    if (inFlight) { queued = true; return; }
    inFlight = true;
    const version = generation;
    const current = () => !disposed && version === generation;
    try {
      const [auth, accounts] = await Promise.all([deps.getAuth(), deps.getAccounts()]);
      if (!current()) return;
      deps.setAuth(auth);
      deps.setAccounts(accounts);
      const nextIdentity = identity(auth);
      const nextContext = JSON.stringify([nextIdentity, accounts.map((account) =>
        [account.personalOrgId, account.sessionStatus]).sort()]);
      if (nextContext !== context) {
        resetRecovery();
        context = nextContext;
        publish({ entries: [], status: 'loading', complete: false });
      }
      authIdentity = nextIdentity;
      if (!auth.isAuthenticated) { signOut(); return; }
      // Routine JWT broadcasts may probe account changes, but cannot turn a
      // bounded retry schedule into an endless loop (or bypass its backoff).
      if ((exhausted || retryTimer) && !forceRefresh) return;
      const fresh = forceRefresh;
      forceRefresh = false;
      publish({ ...snapshot, status: 'loading', complete: false });
      const result = await deps.list(fresh ? { forceRefresh: true } : undefined);
      if (!current()) return;
      if (result?.success && result.complete && accounts.length > 0) {
        resetRecovery();
        publish({ entries: result.teams, status: 'ready', complete: true });
      } else {
        const entries = new Map(snapshot.entries.map((entry) => [entry.orgId, entry]));
        for (const entry of result?.teams ?? []) entries.set(entry.orgId, entry);
        snapshot = { ...snapshot, entries: [...entries.values()] };
        unavailable(result && !result.success ? result.error : 'Organizations could not be loaded.',
          result && !result.success ? result.retryable : true);
      }
    } catch (error) {
      if (current()) unavailable(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight = false;
      if (queued && !disposed) { queued = false; void load(); }
    }
  }

  function refresh(): void {
    generation += 1;
    resetRecovery();
    forceRefresh = true;
    clearTimeout(debounceTimer);
    void load();
  }

  function organizationsChanged(): void {
    generation += 1;
    resetRecovery();
    forceRefresh = true;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void load(); }, 400);
  }

  function authChanged(auth: StytchAuthSnapshot): void {
    generation += 1;
    const nextIdentity = identity(auth);
    if (authIdentity !== nextIdentity) {
      resetRecovery();
      context = undefined;
      publish({ entries: [], status: 'loading', complete: false });
    }
    authIdentity = nextIdentity;
    if (!auth.isAuthenticated) signOut();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void load(); }, 400);
  }

  publish(snapshot);
  void load();
  return {
    refresh,
    organizationsChanged,
    authChanged,
    dispose: () => {
      disposed = true;
      generation += 1;
      clearRetry();
      clearTimeout(debounceTimer);
    },
  };
}
