// @vitest-environment jsdom
import React from 'react';
import { createHydratedOrgStore } from './organizationTestStore';
import { Provider } from 'jotai';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgModeHost } from '../OrgModeHost';
import { ORG_WINDOW_SURFACE_ID } from '../orgWindowState';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => <span /> }));
vi.mock('../../Settings/panels/OrganizationProjectsPanel', () => ({ OrganizationProjectsPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationBillingPanel', () => ({ OrganizationBillingPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationDangerZone', () => ({ OrganizationDangerZone: () => <div /> }));
vi.mock('../../Settings/panels/ProjectSharingPanel', () => ({ ProjectSharingPanel: () => <div /> }));

const team = { orgId: 'org-1', name: 'Acme', boundPersonalOrgId: 'account-1', membershipType: 'active_member' };

function installApi(teams: unknown[]) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      team: {
        findForWorkspace: vi.fn().mockResolvedValue(null),
        resolveOrgProjectsLocalState: vi.fn().mockResolvedValue({ success: true, projects: [] }),
        openProjectWorkspace: vi.fn().mockResolvedValue({ success: true }),
      },
      organization: {
        list: vi.fn().mockResolvedValue({ success: true, teams }),
        listMembers: vi.fn().mockResolvedValue({ success: true, members: [], callerRole: 'owner' }),
      },
      stytch: { getAccounts: vi.fn().mockResolvedValue([{ personalOrgId: 'account-1', email: 'a@example.com' }]) },
      invoke: vi.fn().mockResolvedValue([]),
      on: vi.fn().mockReturnValue(() => {}),
      openExternal: vi.fn(),
      openAccountSettings: vi.fn().mockResolvedValue({ success: true }),
    },
  });
}

describe('TeamMode beta disclosure', () => {
  afterEach(() => cleanup());

  it('shows the notice only on the unbound organization surface', async () => {
    installApi([]);
    render(
      <Provider store={await createHydratedOrgStore()}>
        <OrgModeHost orgId={null} surfaceId={ORG_WINDOW_SURFACE_ID} chrome="window" />
      </Provider>,
    );

    await waitFor(() => screen.getByTestId('team-beta-notice'));
    cleanup();
    installApi([team]);
    render(
      <Provider store={await createHydratedOrgStore()}>
        <OrgModeHost orgId="org-1" surfaceId={ORG_WINDOW_SURFACE_ID} chrome="window" />
      </Provider>,
    );

    await waitFor(() => screen.getByTestId('org-sidebar'));
    expect(screen.queryByTestId('team-beta-notice')).toBeNull();
  });
});
