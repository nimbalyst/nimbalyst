// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
  copyToClipboard: vi.fn(),
}));

import {
  personalAccountsAtom,
  type PersonalAccountSummary,
} from '../../../../store/atoms/settingsDomains';
import { SharedLinksPanel } from '../SharedLinksPanel';

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

const share = {
  shareId: 'share-abcdef123',
  sessionId: 'session-1',
  title: 'Design notes',
  sizeBytes: 2048,
  createdAt: new Date(0).toISOString(),
  expiresAt: null,
  viewCount: 3,
  owningPersonalOrgId: 'personal-1',
};

async function renderPanel(accounts: PersonalAccountSummary[]) {
  const store = createStore();
  store.set(personalAccountsAtom, accounts);
  render(
    <Provider store={store}>
      <SharedLinksPanel />
    </Provider>,
  );
  // The list only renders once the IPC round-trip resolves.
  await screen.findByText('Design notes');
}

describe('SharedLinksPanel account attribution', () => {
  beforeEach(() => {
    (window as any).electronAPI = {
      listShares: vi.fn().mockResolvedValue({ success: true, shares: [share] }),
      getShareKeys: vi.fn().mockResolvedValue({}),
    };
  });

  afterEach(() => cleanup());

  it('omits "Created by" when only one account could have created the link', async () => {
    await renderPanel([account()]);

    expect(screen.queryByTestId('shared-link-owner')).toBeNull();
    // The link itself is untouched — only the attribution is dropped.
    screen.getByText(/share\.nimbalyst\.com\/share\/share-ab/);
  });

  it('names the owning account once a second account exists', async () => {
    await renderPanel([
      account(),
      account({ personalOrgId: 'personal-2', personalUserId: 'user-2', email: 'other@example.com', isSyncAccount: false }),
    ]);

    expect(screen.getByTestId('shared-link-owner').textContent).toContain('solo@example.com');
  });
});
