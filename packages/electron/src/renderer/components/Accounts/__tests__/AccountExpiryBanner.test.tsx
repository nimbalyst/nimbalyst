// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountExpiryBanner } from '../AccountExpiryBanner';

describe('AccountExpiryBanner', () => {
  afterEach(() => cleanup());

  it('persists expired account identity and opens account-scoped re-auth', () => {
    const onReconnect = vi.fn();
    render(
      <AccountExpiryBanner
        accounts={[
          { personalOrgId: 'expired', personalUserId: 'u1', email: 'work@example.com', isSyncAccount: false, sessionStatus: 'expired' },
          { personalOrgId: 'active', personalUserId: 'u2', email: 'me@example.com', isSyncAccount: true, sessionStatus: 'active' },
        ]}
        organizations={[
          { orgId: 'org-work', name: 'Work Team', role: 'admin', sourcePersonalOrgId: 'expired' },
        ]}
        onReconnect={onReconnect}
      />,
    );

    expect(screen.getByText(/work@example.com/)).toBeTruthy();
    expect(screen.getByText(/Work Team/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect work@example.com' }));
    expect(onReconnect).toHaveBeenCalledWith(expect.objectContaining({ personalOrgId: 'expired' }));
  });
});
