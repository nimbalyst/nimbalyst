// @vitest-environment jsdom
import React from 'react';
import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OrgSwitcher } from '../OrgSwitcher';
import { AccountInspectorPopover } from '../Accounts/AccountInspectorPopover';
import { WindowTopBar } from '../WindowTopBar';
import { dialogRef } from '../../contexts/DialogContext';
import { DIALOG_IDS } from '../../dialogs/registry';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { teamInboxSnapshotAtom } from '../../store/atoms/teamInbox';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon, className }: { icon: string; className?: string }) => (
    <span data-icon={icon} className={className} aria-hidden="true">{icon}</span>
  ),
}));

const openManagementWindow = vi.fn();
const findForWorkspace = vi.fn();
const organizationList = vi.fn();
const openDialog = vi.fn();

function installApi() {
  dialogRef.current = { open: openDialog } as unknown as typeof dialogRef.current;
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
    teamMemberId: asTeamMemberId('member-a'),
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

  // The top-bar badge counts only the project's own organization, so it can
  // never report unread that belongs to an inbox the user isn't working in.
  it('badges the top-bar inbox with the project org count and opens that org', async () => {
    installApi();
    findForWorkspace.mockResolvedValue({ team: { orgId: 'org-b', name: 'Beta' } });

    renderWithStore(
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Files"
        gitStatus={null}
        gitActions={{ onPull: () => {}, onPush: () => {}, onOpenLog: () => {} }}
        workspacePath="/workspace/window-root"
      />,
      snapshot([
        delivery('a-1', 'org-a', 'Acme'),
        delivery('a-2', 'org-a', 'Acme'),
        delivery('b-1', 'org-b', 'Beta'),
      ]),
    );

    await waitFor(() => {
      expect(screen.getByTestId('window-top-bar-inbox-unread').textContent).toBe('1');
    });
    expect(findForWorkspace).toHaveBeenCalledWith('/workspace/acme');

    fireEvent.click(screen.getByTestId('window-top-bar-inbox'));

    expect(openManagementWindow).toHaveBeenCalledWith({
      orgId: 'org-b',
      workspacePath: '/workspace/window-root',
    });
  });

  it('keeps the top-bar inbox with no badge at zero unread, and drops it without an org', async () => {
    installApi();
    findForWorkspace.mockResolvedValue({ team: { orgId: 'org-b', name: 'Beta' } });

    const withOrg = renderWithStore(
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Files"
        gitStatus={null}
        gitActions={{ onPull: () => {}, onPush: () => {}, onOpenLog: () => {} }}
        workspacePath="/workspace/window-root"
      />,
      snapshot([delivery('b-read', 'org-b', 'Beta', { readAt: 12 })]),
    );

    await waitFor(() => screen.getByTestId('window-top-bar-inbox'));
    expect(screen.queryByTestId('window-top-bar-inbox-unread')).toBeNull();
    withOrg.unmount();

    findForWorkspace.mockResolvedValue({ team: null });
    renderWithStore(
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Files"
        gitStatus={null}
        gitActions={{ onPull: () => {}, onPush: () => {}, onOpenLog: () => {} }}
        workspacePath="/workspace/window-root"
      />,
      snapshot([]),
    );

    await waitFor(() => expect(findForWorkspace).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('window-top-bar-inbox')).toBeNull();
  });

  // The rows above are the menu's unread list, so they open the messages
  // window. Everything below the divider is administration, which is a dialog
  // in this window since NIM-2322 — no second OS window for it.
  it('opens the management dialog from Manage organization and from a pending invite', async () => {
    installApi();
    organizationList.mockResolvedValue({
      teams: [
        { orgId: 'org-a', name: 'Acme', role: 'admin', membershipType: 'active_member' },
        { orgId: 'org-invite', name: 'Invited', role: 'member', membershipType: 'invited_member' },
      ],
    });
    findForWorkspace.mockResolvedValue({ team: { orgId: 'org-a' } });

    renderWithStore(<OrgSwitcher />, snapshot([]));

    await waitFor(() => screen.getByTestId('org-switcher'));
    fireEvent.click(screen.getByTestId('org-switcher'));

    await waitFor(() => screen.getByTestId('org-switcher-manage-organization'));
    fireEvent.click(screen.getByTestId('org-switcher-manage-organization'));
    expect(openDialog).toHaveBeenCalledWith(DIALOG_IDS.ORG_MANAGEMENT, {
      orgId: 'org-a',
      initialTab: undefined,
    });

    fireEvent.click(screen.getByTestId('org-switcher'));
    // An invitation is acted on in the Members panel, so it lands there.
    fireEvent.click(screen.getByTestId('org-switcher-pending-invites'));
    expect(openDialog).toHaveBeenCalledWith(DIALOG_IDS.ORG_MANAGEMENT, {
      orgId: 'org-invite',
      initialTab: 'members',
    });
    expect(openManagementWindow).not.toHaveBeenCalled();
  });

  // Messaging is reachable from the account popover as well as the top bar, but
  // only where there is an organization whose inbox to open.
  it('offers Messages in the account popover for an org project, and not otherwise', () => {
    installApi();
    const onOpenMessages = vi.fn();
    const props = {
      accounts: [],
      anchorEl: null,
      onClose: () => {},
      onOpenAccount: () => {},
      onManageOrganization: () => {},
      onOpenApplicationSettings: () => {},
      onOpenProjectSettings: () => {},
      onOpenMessages,
    };

    const withOrg = renderWithStore(
      <AccountInspectorPopover
        {...props}
        projectOrg={{ orgId: 'org-b', name: 'Beta' }}
        messagesUnreadCount={140}
      />,
      snapshot([]),
    );

    expect(screen.getByTestId('account-inspector-messages-unread').textContent).toBe('99+');
    fireEvent.click(screen.getByTestId('account-inspector-messages-row'));
    expect(onOpenMessages).toHaveBeenCalledWith('org-b');
    withOrg.unmount();

    renderWithStore(
      <AccountInspectorPopover {...props} projectOrg={null} messagesUnreadCount={0} />,
      snapshot([]),
    );
    expect(screen.queryByTestId('account-inspector-messages-row')).toBeNull();
  });
});
