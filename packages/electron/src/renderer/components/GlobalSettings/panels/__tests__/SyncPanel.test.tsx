// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';

vi.mock('posthog-js/react', () => ({
  usePostHog: () => undefined,
}));
vi.mock('@nimbalyst/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@nimbalyst/runtime')>(),
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));
const mocks = vi.hoisted(() => ({
  dialogRef: { current: null as { open: ReturnType<typeof vi.fn> } | null },
  accountOrgListProps: [] as Array<{ group?: { personalOrgId: string }; indented?: boolean }>,
}));

/** Distinct account groups the org list was asked to render, ignoring re-renders. */
function renderedOrgGroups(): Array<{ personalOrgId: string; indented?: boolean }> {
  const byAccount = new Map<string, { personalOrgId: string; indented?: boolean }>();
  for (const props of mocks.accountOrgListProps) {
    const personalOrgId = props.group?.personalOrgId ?? '';
    byAccount.set(personalOrgId, { personalOrgId, indented: props.indented });
  }
  return [...byAccount.values()];
}

vi.mock('../../../../contexts/DialogContext', () => ({
  dialogRef: mocks.dialogRef,
  useDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('../QRPairingModal', () => ({
  QRPairingModal: () => null,
}));
vi.mock('../../../Accounts/AccountLoginForm', () => ({
  AccountLoginForm: () => null,
}));
vi.mock('../AccountOrgList', () => ({
  AccountOrgList: (props: { indented?: boolean }) => {
    mocks.accountOrgListProps.push(props);
    return null;
  },
}));

import { syncConfigAtom } from '../../../../store/atoms/appSettings';
import { stytchAuthAtom } from '../../../../store/atoms/stytchAuth';
import {
  personalAccountsAtom,
  type PersonalAccountSummary,
} from '../../../../store/atoms/settingsDomains';
import { SyncPanel } from '../SyncPanel';

function account(overrides: Partial<PersonalAccountSummary> = {}): PersonalAccountSummary {
  return {
    personalOrgId: 'personal-1',
    personalUserId: 'user-1',
    email: 'solo@example.com',
    isSyncAccount: true,
    sessionStatus: 'active',
    ...overrides,
  };
}

/** Render the Account section with the given stored accounts. */
function renderAccounts(accounts: PersonalAccountSummary[], configOverrides: Record<string, unknown> = {}) {
  const store = createStore();
  store.set(syncConfigAtom, {
    enabled: false,
    serverUrl: '',
    enabledProjects: [],
    docSyncEnabledProjects: [],
    idleTimeoutMinutes: 5,
    ...configOverrides,
  } as any);
  store.set(stytchAuthAtom, { isAuthenticated: true, user: { user_id: 'user-1' } });
  store.set(personalAccountsAtom, accounts);
  render(
    <Provider store={store}>
      <SyncPanel section="accounts" />
    </Provider>,
  );
  return store;
}

describe('SyncPanel', () => {
  beforeEach(() => {
    mocks.dialogRef.current = { open: vi.fn() };
    mocks.accountOrgListProps.length = 0;
    (window as any).electronAPI = {
      invoke: vi.fn(() => new Promise(() => {})),
      stytch: {
        refreshSession: vi.fn().mockResolvedValue(undefined),
        getAccounts: vi.fn().mockResolvedValue([]),
        setSyncAccount: vi.fn().mockResolvedValue({ success: true }),
      },
    };
  });

  afterEach(() => cleanup());

  it('does not show session and document sharing guidance in the Mobile App section', () => {
    const store = createStore();
    store.set(syncConfigAtom, {
      enabled: false,
      serverUrl: '',
      enabledProjects: [],
      docSyncEnabledProjects: [],
      idleTimeoutMinutes: 5,
    });
    store.set(stytchAuthAtom, {
      isAuthenticated: true,
      user: { user_id: 'user-1' },
    });

    render(
      <Provider store={store}>
        <SyncPanel section="mobile" />
      </Provider>,
    );

    expect(screen.queryByText('Sharing Sessions & Documents')).toBeNull();
    expect(screen.queryByText(/create an encrypted share link/i)).toBeNull();
  });

  /**
   * With exactly one stored account the Account screen should read like a
   * single-account app: nothing that only exists to tell two logins apart.
   * Adding an account stays reachable — it is the one place that can — but as a
   * quiet text action.
   */
  describe('with a single stored account', () => {
    it('drops the account-comparison chrome and states who is signed in', () => {
      renderAccounts([account()]);

      screen.getByText('solo@example.com');
      screen.getByText(/Signed in as/);
      // "Used for sync" and the sync-account highlight only mean something
      // relative to another account.
      expect(screen.queryByText('Used for sync')).toBeNull();
      const row = screen.getByTestId('sync-account-row');
      expect(row.className).not.toContain('nim-primary');
      expect(row.querySelector('.sync-account-avatar')).toBeNull();
      // Organizations are the app's organizations, not one login's.
      expect(renderedOrgGroups()).toEqual([{ personalOrgId: 'personal-1', indented: false }]);
    });

    it('keeps adding an account reachable as a quiet text action', () => {
      renderAccounts([account()]);

      const addButton = screen.getByTestId('sync-add-account');
      expect(addButton.textContent).toContain('Add another account');
      expect(addButton.className).not.toContain('border-dashed');

      fireEvent.click(addButton);
      expect(mocks.dialogRef.current?.open).toHaveBeenCalledWith(
        expect.anything(),
        { mode: 'add-account' },
      );
    });

    it('still offers reconnect when the sole account expires', () => {
      renderAccounts([account({ sessionStatus: 'expired', isSyncAccount: true })]);

      screen.getByText('Session expired');
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
      expect(mocks.dialogRef.current?.open).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ mode: 'reauth' }),
      );
    });
  });

  describe('with two stored accounts', () => {
    const twoAccounts = () => [
      account({ personalOrgId: 'personal-1', email: 'work@example.com', isSyncAccount: true }),
      account({ personalOrgId: 'personal-2', personalUserId: 'user-2', email: 'home@example.com', isSyncAccount: false }),
    ];

    it('marks which account sync uses and groups organizations under each login', () => {
      renderAccounts(twoAccounts());

      expect(screen.getAllByTestId('sync-account-row')).toHaveLength(2);
      screen.getByText('Used for sync');
      expect(screen.queryByText(/Signed in as/)).toBeNull();
      expect(renderedOrgGroups()).toEqual([
        { personalOrgId: 'personal-1', indented: true },
        { personalOrgId: 'personal-2', indented: true },
      ]);
    });

    it('switches the sync account from the non-sync row', async () => {
      renderAccounts(twoAccounts());

      fireEvent.click(screen.getByRole('button', { name: 'Set as sync account' }));

      await waitFor(() => {
        expect((window as any).electronAPI.stytch.setSyncAccount).toHaveBeenCalledWith('personal-2');
      });
    });
  });
});
