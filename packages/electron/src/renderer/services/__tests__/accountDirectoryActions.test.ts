// @vitest-environment jsdom
import { store } from '@nimbalyst/runtime/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { personalAccountsAtom } from '../../store/atoms/settingsDomains';
import { setSyncAccountAndRefresh } from '../accountDirectoryActions';

describe('account directory actions', () => {
  afterEach(() => {
    store.set(personalAccountsAtom, []);
  });

  it('refreshes the account atom immediately after switching the sync account', async () => {
    const refreshed = [
      { personalOrgId: 'first', personalUserId: 'user-1', email: 'first@example.com', isSyncAccount: false, sessionStatus: 'active' as const },
      { personalOrgId: 'second', personalUserId: 'user-2', email: 'second@example.com', isSyncAccount: true, sessionStatus: 'active' as const },
    ];
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        stytch: {
          setSyncAccount: vi.fn().mockResolvedValue({ success: true }),
          getAccounts: vi.fn().mockResolvedValue(refreshed),
        },
      },
    });
    store.set(personalAccountsAtom, [{ ...refreshed[0], isSyncAccount: true }, { ...refreshed[1], isSyncAccount: false }]);

    await setSyncAccountAndRefresh('second');

    expect(store.get(personalAccountsAtom)).toEqual(refreshed);
  });
});

