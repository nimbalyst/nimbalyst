// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';

vi.mock('posthog-js/react', () => ({
  usePostHog: () => undefined,
}));
vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));
vi.mock('../../../../contexts/DialogContext', () => ({
  dialogRef: { current: null },
  useDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('../QRPairingModal', () => ({
  QRPairingModal: () => null,
}));
vi.mock('../../../Accounts/AccountLoginForm', () => ({
  AccountLoginForm: () => null,
}));
vi.mock('../AccountOrgList', () => ({
  AccountOrgList: () => null,
}));

import { syncConfigAtom } from '../../../../store/atoms/appSettings';
import { stytchAuthAtom } from '../../../../store/atoms/stytchAuth';
import { SyncPanel } from '../SyncPanel';

describe('SyncPanel', () => {
  beforeEach(() => {
    (window as any).electronAPI = {
      invoke: vi.fn(() => new Promise(() => {})),
      stytch: {
        refreshSession: vi.fn().mockResolvedValue(undefined),
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
});
