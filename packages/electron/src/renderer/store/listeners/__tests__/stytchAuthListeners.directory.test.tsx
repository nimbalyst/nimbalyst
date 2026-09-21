// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider, useAtomValue } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { initStytchAuthListeners, refreshOrganizationDirectory } from '../stytchAuthListeners';
import { organizationDirectoryAtom, organizationDirectoryStateAtom, personalAccountsAtom } from '../../atoms/settingsDomains';
import { stytchAuthAtom } from '../../atoms/stytchAuth';
import { AccountOrgList } from '../../../components/GlobalSettings/panels/AccountOrgList';
import { groupOrganizationsByAccount } from '../../../components/GlobalSettings/panels/accountOrganizations';

vi.mock('../../../utils/teamAnalytics', () => ({ trackTeamAnalyticsEvent: vi.fn() }));
vi.mock('../../../hooks/useProjectOrg', () => ({ useProjectOrg: () => ({ org: null }) }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));

const account = { personalOrgId: 'account-a', personalUserId: 'user-a', email: 'a@example.com', isSyncAccount: true, sessionStatus: 'active' };
const org = { orgId: 'org-a', name: 'Acme', role: 'owner', sourcePersonalOrgId: 'account-a', sourceEmail: 'a@example.com' };
const auth = { isAuthenticated: true, user: { user_id: 'user-a' } };
let dispose: (() => void) | undefined;
let onAuth: (state: any) => void;
const list = vi.fn();

function AccountOrganizations() {
  const groups = groupOrganizationsByAccount(useAtomValue(personalAccountsAtom), useAtomValue(organizationDirectoryAtom));
  return <>{groups.map((group) => <AccountOrgList key={group.personalOrgId} group={group} />)}</>;
}

async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }

describe('organization directory startup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.set(stytchAuthAtom, null);
    store.set(organizationDirectoryAtom, []);
    store.set(personalAccountsAtom, []);
    list.mockReset();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      stytch: {
        getAuthState: vi.fn().mockResolvedValue(auth),
        getAccounts: vi.fn().mockResolvedValue([account]),
        onAuthStateChange: vi.fn((callback) => { onAuth = callback; return vi.fn(); }),
        subscribeAuthState: vi.fn(),
      },
      team: { list, claimSignInAttribution: vi.fn().mockResolvedValue(false) },
      invoke: vi.fn(),
    } });
  });
  afterEach(() => { dispose?.(); cleanup(); vi.useRealTimers(); });

  it('never advertises no organizations during the auth race and recovers without another auth event', async () => {
    list.mockResolvedValueOnce({ success: false, complete: false, teams: [], retryable: true, error: 'Directory unavailable' })
      .mockResolvedValue({ success: true, complete: true, teams: [org] });
    dispose = initStytchAuthListeners();
    render(<Provider store={store}><AccountOrganizations /></Provider>);
    await settle();
    expect(screen.queryByTestId('account-org-empty')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    screen.getByText('Acme');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('retains known memberships on a partial multi-account failure, then replaces them on complete empty discovery', async () => {
    list.mockResolvedValue({ success: true, complete: true, teams: [org] });
    dispose = initStytchAuthListeners();
    await settle();
    list.mockResolvedValue({ success: false, complete: false, teams: [{ ...org, orgId: 'org-b', name: 'Beta' }], retryable: true, error: 'One account unavailable' });
    refreshOrganizationDirectory();
    await settle();
    expect(store.get(organizationDirectoryAtom).map((entry) => entry.orgId)).toEqual(['org-a', 'org-b']);
    expect(store.get(organizationDirectoryStateAtom).complete).toBe(false);
    list.mockResolvedValue({ success: true, complete: true, teams: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    render(<Provider store={store}><AccountOrganizations /></Provider>);
    screen.getByTestId('account-org-empty');
    expect(store.get(organizationDirectoryAtom)).toEqual([]);
  });

  it('exhausts retries, ignores routine auth broadcasts, and permits manual recovery', async () => {
    list.mockResolvedValue({ success: false, complete: false, teams: [], retryable: true, error: 'Network unavailable' });
    dispose = initStytchAuthListeners();
    render(<Provider store={store}><AccountOrganizations /></Provider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(70000); });
    expect(list).toHaveBeenCalledTimes(8);
    expect(store.get(organizationDirectoryStateAtom).status).toBe('error');
    screen.getByText('Network unavailable');
    expect(screen.queryByTestId('account-org-empty')).toBeNull();
    onAuth(auth);
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(list).toHaveBeenCalledTimes(8);
    list.mockResolvedValue({ success: true, complete: true, teams: [org] });
    refreshOrganizationDirectory();
    await settle();
    screen.getByText('Acme');
    expect(list).toHaveBeenLastCalledWith({ forceRefresh: true });
  });

  it('clears on sign-out and rejects an outstanding membership response', async () => {
    let resolveList!: (value: unknown) => void;
    list.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));
    dispose = initStytchAuthListeners();
    await settle();
    const signedOut = { isAuthenticated: false, user: null };
    vi.mocked(window.electronAPI.stytch.getAuthState).mockResolvedValue(signedOut as never);
    onAuth(signedOut);
    resolveList({ success: true, complete: true, teams: [org] });
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(store.get(organizationDirectoryStateAtom)).toMatchObject({ status: 'signed-out', entries: [] });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('replaces the account context before publishing a newer refresh and rejects the old result', async () => {
    let resolveList!: (value: unknown) => void;
    list.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));
    dispose = initStytchAuthListeners();
    await settle();
    vi.mocked(window.electronAPI.stytch.getAccounts).mockResolvedValue([{ ...account, personalOrgId: 'account-b' }] as never);
    list.mockResolvedValue({ success: false, complete: false, teams: [], retryable: false, error: 'New account unavailable' });
    refreshOrganizationDirectory();
    resolveList({ success: true, complete: true, teams: [org] });
    await settle();
    expect(store.get(organizationDirectoryStateAtom)).toMatchObject({ status: 'error', entries: [] });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('coalesces auth broadcasts during a request into one follow-up', async () => {
    let resolveList!: (value: unknown) => void;
    list.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }))
      .mockResolvedValue({ success: true, complete: true, teams: [org] });
    dispose = initStytchAuthListeners();
    await settle();
    onAuth(auth); onAuth(auth); onAuth(auth);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(list).toHaveBeenCalledTimes(1);
    resolveList({ success: true, complete: true, teams: [] });
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(store.get(organizationDirectoryAtom)).toEqual([org]);
  });

  it('keeps failed auth hydration unknown and recovers on its own', async () => {
    vi.mocked(window.electronAPI.stytch.getAuthState).mockRejectedValueOnce(new Error('Auth unavailable'));
    list.mockResolvedValue({ success: true, complete: true, teams: [org] });
    dispose = initStytchAuthListeners();
    await settle();
    expect(store.get(stytchAuthAtom)).toBeNull();
    expect(store.get(organizationDirectoryStateAtom)).toMatchObject({ status: 'loading', complete: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(store.get(organizationDirectoryAtom)).toEqual([org]);
  });

  it('disposes retries and prevents old initialization from overwriting a remount', async () => {
    let resolveAuth!: (value: unknown) => void;
    vi.mocked(window.electronAPI.stytch.getAuthState).mockImplementationOnce(() => new Promise((resolve) => { resolveAuth = resolve; }) as never);
    list.mockResolvedValue({ success: true, complete: true, teams: [org] });
    dispose = initStytchAuthListeners();
    dispose();
    dispose = initStytchAuthListeners();
    await settle();
    resolveAuth({ isAuthenticated: false, user: null });
    await settle();
    expect(store.get(organizationDirectoryAtom)).toEqual([org]);
    list.mockRejectedValue(new Error('Network down'));
    refreshOrganizationDirectory();
    await settle();
    dispose();
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(list).toHaveBeenCalledTimes(2);
  });

});
