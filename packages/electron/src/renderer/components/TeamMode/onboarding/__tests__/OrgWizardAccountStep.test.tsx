// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stytchAuthAtom } from '../../../../store/atoms/stytchAuth';
import type { PersonalAccountSummary } from '../../../../store/atoms/settingsDomains';
import { OrgWizardAccountStep } from '../OrgWizardAccountStep';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));

const sendMagicLink = vi.fn(async () => ({ success: true }));
const signInWithGoogle = vi.fn(async () => ({ success: true }));
const getAccounts = vi.fn(async (): Promise<PersonalAccountSummary[]> => []);

function storedAccount(overrides: Partial<PersonalAccountSummary> = {}): PersonalAccountSummary {
  return {
    personalOrgId: 'personal-sync',
    personalUserId: 'member-sync',
    email: 'sync@example.com',
    isSyncAccount: true,
    sessionStatus: 'expired',
    ...overrides,
  };
}

beforeEach(() => {
  sendMagicLink.mockClear();
  signInWithGoogle.mockClear();
  getAccounts.mockClear().mockResolvedValue([]);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { stytch: { sendMagicLink, signInWithGoogle, getAccounts } },
  });
});

afterEach(() => cleanup());

describe('OrgWizardAccountStep', () => {
  it('advances without user action when auth flips to authenticated', async () => {
    const store = createStore();
    const onAuthenticated = vi.fn();
    store.set(stytchAuthAtom, { isAuthenticated: false, user: null });

    render(
      <Provider store={store}>
        <OrgWizardAccountStep onAuthenticated={onAuthenticated} />
      </Provider>,
    );
    expect(onAuthenticated).not.toHaveBeenCalled();

    act(() => {
      store.set(stytchAuthAtom, {
        isAuthenticated: true,
        user: {
          user_id: 'user-1',
          emails: [{ email: 'member@example.com', verified: true }],
        },
      });
    });

    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalledWith('member@example.com');
    });
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  /**
   * A magic link is read in a mail client, possibly on another device. The step
   * has to look like it is still working, and a link that never arrives must
   * not be the end of the flow.
   */
  it('waits explicitly once a magic link is sent, and can resend or start over', async () => {
    const store = createStore();
    store.set(stytchAuthAtom, { isAuthenticated: false, user: null });
    render(
      <Provider store={store}>
        <OrgWizardAccountStep onAuthenticated={vi.fn()} />
      </Provider>,
    );

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'greg@acme.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send magic link' }));

    const waiting = await screen.findByTestId('account-login-waiting');
    expect(waiting.textContent).toContain('Waiting for you to finish');
    expect(waiting.textContent).toContain('greg@acme.com');
    // The method picker is gone while waiting.
    expect(screen.queryByLabelText('Email')).toBeNull();

    fireEvent.click(screen.getByTestId('account-login-resend'));
    await waitFor(() => expect(sendMagicLink).toHaveBeenCalledTimes(2));
    expect((await screen.findByTestId('account-login-resend-notice')).textContent)
      .toContain('greg@acme.com');

    fireEvent.click(screen.getByTestId('account-login-restart'));
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.queryByTestId('account-login-waiting')).toBeNull();
  });

  it('waits after handing off to the browser for Google', async () => {
    const store = createStore();
    store.set(stytchAuthAtom, { isAuthenticated: false, user: null });
    render(
      <Provider store={store}>
        <OrgWizardAccountStep onAuthenticated={vi.fn()} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));

    const waiting = await screen.findByTestId('account-login-waiting');
    expect(waiting.textContent).toContain('Waiting for you to finish');
    expect(screen.getByTestId('account-login-resend').textContent)
      .toContain('Open sign-in again');
  });

  /**
   * With an expired sync account the step resolves an `add-account` intent, and
   * authenticating a *different* email leaves the singleton auth state signed
   * out — main only refreshes it for the sync account. The step used to watch
   * only that singleton, so the wizard sat on "waiting" forever. The add still
   * broadcasts an auth-state change, which is the cue to re-read the accounts.
   */
  it('advances when a different account is added and the singleton stays signed out', async () => {
    getAccounts.mockResolvedValue([storedAccount()]);
    const store = createStore();
    const onAuthenticated = vi.fn();
    store.set(stytchAuthAtom, { isAuthenticated: false, user: null });

    render(
      <Provider store={store}>
        <OrgWizardAccountStep onAuthenticated={onAuthenticated} />
      </Provider>,
    );
    expect(onAuthenticated).not.toHaveBeenCalled();

    getAccounts.mockResolvedValue([
      storedAccount(),
      storedAccount({
        personalOrgId: 'personal-new',
        personalUserId: 'member-new',
        email: 'new@example.com',
        isSyncAccount: false,
        sessionStatus: 'active',
      }),
    ]);
    act(() => {
      // The add-account broadcast: still signed out as far as the singleton goes.
      store.set(stytchAuthAtom, { isAuthenticated: false, user: null });
    });

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('new@example.com'));
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });

  // The same broadcast with nothing usable stored must leave the step waiting.
  it('keeps waiting when no stored account has a live session', async () => {
    getAccounts.mockResolvedValue([storedAccount()]);
    const store = createStore();
    const onAuthenticated = vi.fn();
    store.set(stytchAuthAtom, { isAuthenticated: false, user: null });

    render(
      <Provider store={store}>
        <OrgWizardAccountStep onAuthenticated={onAuthenticated} />
      </Provider>,
    );

    act(() => {
      store.set(stytchAuthAtom, { isAuthenticated: false, user: null });
    });

    await waitFor(() => expect(getAccounts).toHaveBeenCalled());
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  // The step serves sign-up and sign-in identically, so it must never tell a
  // first-time user to sign in to an account they do not have.
  it('offers account creation in its heading', () => {
    const store = createStore();
    store.set(stytchAuthAtom, { isAuthenticated: false, user: null });
    render(
      <Provider store={store}>
        <OrgWizardAccountStep onAuthenticated={vi.fn()} />
      </Provider>,
    );

    expect(screen.getByTestId('org-wizard-account-step').textContent)
      .toContain('Sign in, or create your account');
  });
});
