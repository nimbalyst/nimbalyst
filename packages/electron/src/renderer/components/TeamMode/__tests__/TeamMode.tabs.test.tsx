// @vitest-environment jsdom
import React from 'react';
import { createHydratedOrgStore } from './organizationTestStore';
import { Provider } from 'jotai';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import { OrgModeHost } from '../OrgModeHost';
import { ORG_WINDOW_SURFACE_ID } from '../orgWindowState';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => <span /> }));
vi.mock('../Inbox', () => ({ InboxSection: () => <div data-testid="inbox" /> }));
vi.mock('../../Settings/panels/OrganizationProjectsPanel', () => ({ OrganizationProjectsPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationBillingPanel', () => ({ OrganizationBillingPanel: () => <div /> }));
vi.mock('../../Settings/panels/OrganizationDangerZone', () => ({ OrganizationDangerZone: () => <div /> }));
vi.mock('../../Settings/panels/ProjectSharingPanel', () => ({ ProjectSharingPanel: () => <div /> }));

const team = { orgId: 'org-1', name: 'Acme', boundPersonalOrgId: 'account-1', membershipType: 'active_member' };

function installApi() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      team: {
        findForWorkspace: vi.fn().mockResolvedValue(null),
        resolveOrgProjectsLocalState: vi.fn().mockResolvedValue({ success: true, projects: [] }),
        openProjectWorkspace: vi.fn().mockResolvedValue({ success: true }),
      },
      organization: {
        list: vi.fn().mockResolvedValue({ success: true, teams: [team] }),
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

describe('TeamMode org window navigation', () => {
  afterEach(() => cleanup());

  it('opens the rooms directory from the sidebar', async () => {
    installApi();
    render(
      <Provider store={await createHydratedOrgStore()}>
        <OrgModeHost orgId="org-1" surfaceId={ORG_WINDOW_SURFACE_ID} chrome="window" />
      </Provider>,
    );

    await waitFor(() => screen.getByTestId('org-rooms-section-add'));
    screen.getByTestId('org-rooms-section-add').click();
    await waitFor(() => screen.getByTestId('org-browse-rooms'));
    screen.getByTestId('org-browse-rooms').click();

    await waitFor(() => screen.getByTestId('org-rooms-directory'));
  });
});
