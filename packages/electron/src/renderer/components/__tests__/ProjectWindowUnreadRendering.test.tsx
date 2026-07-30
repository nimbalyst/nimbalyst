// @vitest-environment jsdom
import React from 'react';
import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OrgSwitcher } from '../OrgSwitcher';
import { ProjectWindowStatusBar } from '../ProjectWindowStatusBar';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { teamInboxSnapshotAtom } from '../../store/atoms/teamInbox';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon, className }: { icon: string; className?: string }) => (
    <span data-icon={icon} className={className} aria-hidden="true">{icon}</span>
  ),
}));

const openManagementWindow = vi.fn();
const findForWorkspace = vi.fn();
const organizationList = vi.fn();

function installApi() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      organization: {
        list: organizationList,
      },
      team: {
        findForWorkspace,
        openManagementWindow,
      },
    },
  });
}

function snapshot(
  deliveries: TeamInboxSnapshot['deliveries'],
): TeamInboxSnapshot {
  return {
    status: 'ready',
    deliveries,
    organizations: [
      { orgId: 'org-a', orgName: 'Acme', status: 'ready' },
      { orgId: 'org-b', orgName: 'Beta', status: 'ready' },
    ],
  };
}

function delivery(
  id: string,
  orgId: string,
  orgName: string,
  overrides: Partial<TeamInboxSnapshot['deliveries'][number]> = {},
): TeamInboxSnapshot['deliveries'][number] {
  return {
    id,
    recipientUserId: 'member-a',
    orgId,
    orgName,
    createdAt: 10,
    hasUnreadActivity: false,
    ...overrides,
  };
}

function renderWithStore(ui: React.ReactElement, inbox: TeamInboxSnapshot) {
  const store = createStore();
  store.set(activeWorkspacePathAtom, '/workspace/acme');
  store.set(teamInboxSnapshotAtom, inbox);
  return render(<Provider store={store}>{ui}</Provider>);
}

describe('project window unread rendering', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('renders the aggregate org switcher badge and per-org unread rows', async () => {
    installApi();
    organizationList.mockResolvedValue({
      teams: [
        { orgId: 'org-a', name: 'Acme', role: 'admin', membershipType: 'active_member' },
        { orgId: 'org-b', name: 'Beta', role: 'member', membershipType: 'active_member' },
      ],
    });
    findForWorkspace.mockResolvedValue({ team: { orgId: 'org-a' } });

    renderWithStore(
      <OrgSwitcher />,
      snapshot([
        delivery('a-1', 'org-a', 'Acme'),
        delivery('a-2', 'org-a', 'Acme'),
        delivery('b-1', 'org-b', 'Beta'),
        delivery('read', 'org-b', 'Beta', { readAt: 12 }),
      ]),
    );

    await waitFor(() => expect(screen.getByTestId('org-switcher-unread-badge').textContent).toBe('3'));

    fireEvent.click(screen.getByTestId('org-switcher'));

    expect(screen.getByTestId('org-switcher-org-row-org-a').textContent).toContain('2 unread');
    expect(screen.getByTestId('org-switcher-org-row-org-b').textContent).toContain('1 unread');

    fireEvent.click(screen.getByTestId('org-switcher-org-row-org-b'));
    expect(openManagementWindow).toHaveBeenCalledWith({
      orgId: 'org-b',
      workspacePath: '/workspace/acme',
    });
  });

  it('renders the project status-bar chip and opens the active workspace org inbox first', async () => {
    installApi();
    findForWorkspace.mockResolvedValue({ team: { orgId: 'org-b' } });

    renderWithStore(
      <ProjectWindowStatusBar workspacePath="/workspace/window-root" />,
      snapshot([
        delivery('a-1', 'org-a', 'Acme'),
        delivery('a-2', 'org-a', 'Acme'),
        delivery('b-1', 'org-b', 'Beta'),
      ]),
    );

    await waitFor(() => {
      expect(findForWorkspace).toHaveBeenCalledWith('/workspace/acme');
      expect(screen.getByTestId('project-window-unread-chip').textContent).toBe('3 unread');
    });

    fireEvent.click(screen.getByTestId('project-window-unread-chip'));

    expect(openManagementWindow).toHaveBeenCalledWith({
      orgId: 'org-b',
      workspacePath: '/workspace/acme',
    });
  });

  it('hides the status-bar chip when there are no unread deliveries', () => {
    installApi();
    renderWithStore(
      <ProjectWindowStatusBar />,
      snapshot([delivery('read', 'org-a', 'Acme', { readAt: 12 })]),
    );

    expect(screen.queryByTestId('project-window-unread-chip')).toBeNull();
  });
});
