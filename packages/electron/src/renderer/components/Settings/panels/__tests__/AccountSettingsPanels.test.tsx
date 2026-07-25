// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * Every Account sub-nav item used to render the same stacked panel, so the
 * screen opened with an "Account" title immediately followed by an
 * "Account & Sync" section header. Each route now renders exactly one section.
 */

vi.mock('../../../GlobalSettings/panels/SyncPanel', () => ({
  SyncPanel: ({ section }: { section: string }) => <div data-testid="sync-panel" data-section={section} />,
}));
vi.mock('../../../GlobalSettings/panels/SharedLinksPanel', () => ({
  SharedLinksPanel: () => <div data-testid="shared-links-panel" />,
}));

import {
  AccountDevicesSettingsPanel,
  AccountSettingsPanel,
  AccountSharedLinksSettingsPanel,
  MobileAppSettingsPanel,
} from '../AccountSettingsPanel';
import {
  getSettingsRoutesForScope,
  normalizeSettingsDestination,
  validateSettingsDestination,
} from '../../settingsRoutes';

const context = { developerMode: false, showDirectChatProviders: false };

describe('Account settings panels', () => {
  afterEach(() => cleanup());

  it('renders only the accounts section, with no stacked shared-links panel', () => {
    render(<AccountSettingsPanel />);

    expect(screen.getAllByTestId('sync-panel')).toHaveLength(1);
    expect(screen.getByTestId('sync-panel').getAttribute('data-section')).toBe('accounts');
    expect(screen.queryByTestId('shared-links-panel')).toBeNull();
  });

  it('renders only the mobile section for the Mobile App route', () => {
    render(<MobileAppSettingsPanel />);

    expect(screen.getAllByTestId('sync-panel')).toHaveLength(1);
    expect(screen.getByTestId('sync-panel').getAttribute('data-section')).toBe('mobile');
  });

  it('renders only the devices section for the Devices route', () => {
    render(<AccountDevicesSettingsPanel />);

    expect(screen.getAllByTestId('sync-panel')).toHaveLength(1);
    expect(screen.getByTestId('sync-panel').getAttribute('data-section')).toBe('devices');
  });

  it('renders shared links on their own, with no sync sections', () => {
    render(<AccountSharedLinksSettingsPanel />);

    expect(screen.getByTestId('shared-links-panel')).toBeTruthy();
    expect(screen.queryByTestId('sync-panel')).toBeNull();
  });
});

describe('Account settings routes', () => {
  it('lists Accounts, Mobile App, Devices and Shared Links as separate nav items', () => {
    const routes = getSettingsRoutesForScope('account', context);

    expect(routes.map((route) => [route.id, route.label])).toEqual([
      ['account', 'Accounts'],
      ['account-mobile', 'Mobile App'],
      ['account-devices', 'Devices'],
      ['account-shared-links', 'Shared Links'],
    ]);
    expect(routes.every((route) => validateSettingsDestination({ scope: 'account', category: route.id as any })))
      .toBe(true);
  });

  it('migrates legacy personal links onto the route that now owns each section', () => {
    const cases: Array<[string, string]> = [
      ['personal-accounts', 'account'],
      // The mobile tips deep-link with 'sync' to reach pairing / prevent-sleep.
      ['sync', 'account-mobile'],
      ['personal-mobile', 'account-mobile'],
      ['personal-devices', 'account-devices'],
      ['personal-shared-links', 'account-shared-links'],
      ['shared-links', 'account-shared-links'],
    ];

    for (const [legacy, expected] of cases) {
      expect(normalizeSettingsDestination({ category: legacy, scope: 'personal' }))
        .toEqual({ scope: 'account', category: expected });
    }
  });
});
