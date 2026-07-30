// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgSidebar } from '../OrgSidebar';
import type { OrgSidebarModel } from '../orgSidebarViewModel';
import { visibleAdminTabs } from '../orgSidebarViewModel';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));

const model: OrgSidebarModel = {
  rooms: [
    { conversationId: 'general', kind: 'orgRoom', label: 'General', isPrivate: false, isGeneral: true, unreadCount: 0 },
    { conversationId: 'design', kind: 'orgRoom', label: 'design', isPrivate: true, isGeneral: false, unreadCount: 1 },
  ],
  dms: [
    { conversationId: 'dm-1', kind: 'dm', label: 'Karl', isPrivate: true, isGeneral: false, unreadCount: 2 },
  ],
  gating: {
    roomsVisible: true,
    dmsVisible: true,
    canCreateRoom: true,
    canCreateDirectMessage: true,
  },
  adminTabs: visibleAdminTabs(true),
};

describe('OrgSidebar', () => {
  afterEach(() => cleanup());

  it('lists rooms, DMs and the admin group with stable markers', () => {
    const { container } = render(
      <OrgSidebar model={model} inboxUnread={3} onNavigate={vi.fn()} />,
    );

    expect(container.querySelectorAll('.org-room-item')).toHaveLength(2);
    expect(container.querySelectorAll('.org-dm-item')).toHaveLength(1);
    // The administration entries keep the ids the rest of the suite addresses.
    expect(screen.getByTestId('team-tab-members')).toBeTruthy();
    expect(screen.getByTestId('team-tab-danger')).toBeTruthy();
  });

  it('pins bottomContent below the scrolling sections', () => {
    // This footer is the org user indicator's only home (it used to live in the
    // rail). It must sit outside the scroll container, or the identity scrolls
    // away with the conversation list.
    const { container } = render(
      <OrgSidebar
        model={model}
        inboxUnread={0}
        onNavigate={vi.fn()}
        bottomContent={<div data-testid="sidebar-footer-probe" />}
      />,
    );

    const footer = screen.getByTestId('sidebar-footer-probe');
    expect(footer.closest('[data-testid="org-sidebar"]')).toBeTruthy();
    expect(footer.closest('.org-sidebar-scroll')).toBeNull();
    // Last child of the nav, so nothing renders under the identity.
    expect(container.querySelector('[data-testid="org-sidebar"]')?.lastElementChild).toBe(footer);
  });

  it('shows unread counts on the inbox and on each unread conversation', () => {
    render(<OrgSidebar model={model} inboxUnread={3} onNavigate={vi.fn()} />);

    expect(screen.getByTestId('team-tab-inbox').textContent).toContain('3');
    expect(screen.getByTestId('org-room-item-design').textContent).toContain('1');
    expect(screen.getByTestId('org-room-item-general').getAttribute('data-unread')).toBe('false');
    expect(screen.getByTestId('org-dm-item-dm-1').getAttribute('data-unread')).toBe('true');
  });

  it('navigates by route, not by tab id', () => {
    const onNavigate = vi.fn();
    render(<OrgSidebar model={model} inboxUnread={0} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByTestId('org-room-item-design'));
    expect(onNavigate).toHaveBeenCalledWith({ view: 'conversation', conversationId: 'design' });

    // The directory lives in the rooms + menu rather than in a row of its own.
    fireEvent.click(screen.getByTestId('org-rooms-section-add'));
    fireEvent.click(screen.getByTestId('org-browse-rooms'));
    expect(onNavigate).toHaveBeenCalledWith({ view: 'directory' });

    fireEvent.click(screen.getByTestId('team-tab-projects'));
    expect(onNavigate).toHaveBeenCalledWith({ view: 'admin', adminTab: 'projects' });
  });

  // A failed directory read used to render "No rooms yet. Create one with + or
  // browse below." — telling a member to create rooms the org may already have.
  it('says the directory could not be loaded instead of claiming it is empty', () => {
    const onRetryDirectory = vi.fn();
    render(
      <OrgSidebar
        model={{ ...model, rooms: [], dms: [] }}
        inboxUnread={0}
        directoryError="Directory unavailable"
        onRetryDirectory={onRetryDirectory}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('org-rooms-empty')).toBeNull();
    expect(screen.queryByTestId('org-dms-empty')).toBeNull();
    expect(screen.getByTestId('org-rooms-error').textContent).toContain('load rooms');
    expect(screen.getByTestId('org-dms-error').textContent).toContain('load direct messages');

    fireEvent.click(screen.getByTestId('org-rooms-error-retry'));
    fireEvent.click(screen.getByTestId('org-dms-error-retry'));
    expect(onRetryDirectory).toHaveBeenCalledTimes(2);
  });

  // A refresh that fails over rows already on screen: the rows stay, but the
  // sidebar says it may be stale rather than silently showing old state.
  it('keeps already-loaded rows and still reports the failed refresh', () => {
    const { container } = render(
      <OrgSidebar
        model={model}
        inboxUnread={0}
        directoryError="Directory unavailable"
        onNavigate={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('.org-room-item')).toHaveLength(2);
    expect(screen.getByTestId('org-rooms-error')).toBeTruthy();
    // No retry affordance offered when the host supplies no refresh.
    expect(screen.queryByTestId('org-rooms-error-retry')).toBeNull();
  });

  it('collapses the admin group and disables the create controls until they exist', () => {
    render(<OrgSidebar model={model} inboxUnread={0} onNavigate={vi.fn()} />);

    // The rooms + opens a menu, so the trigger stays live and the create item
    // inside it carries the restriction.
    expect((screen.getByTestId('org-rooms-section-add') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('org-rooms-section-add'));
    expect((screen.getByTestId('org-create-room') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect((screen.getByTestId('org-dms-section-add') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('org-admin-toggle'));
    expect(screen.queryByTestId('team-tab-members')).toBeNull();
  });

  it('hides the rooms section and browse entry when rooms are turned off', () => {
    render(
      <OrgSidebar
        model={{ ...model, rooms: [], gating: { ...model.gating, roomsVisible: false, canCreateRoom: false } }}
        inboxUnread={0}
        onNavigate={vi.fn()}
        onCreateRoom={vi.fn()}
        onCreateDirectMessage={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('org-rooms-section')).toBeNull();
    // With the section gone there is no + to open, so the directory entry that
    // now lives in its menu is unreachable too.
    expect(screen.queryByTestId('org-rooms-section-add')).toBeNull();
    expect(screen.queryByTestId('org-browse-rooms')).toBeNull();
    // The inbox and the admin group are never gated.
    expect(screen.getByTestId('team-tab-inbox')).toBeTruthy();
    expect(screen.getByTestId('team-tab-settings')).toBeTruthy();
    expect(screen.getByTestId('org-dms-section')).toBeTruthy();
  });

  it('hides the direct-messages section when DMs are turned off', () => {
    render(
      <OrgSidebar
        model={{ ...model, dms: [], gating: { ...model.gating, dmsVisible: false, canCreateDirectMessage: false } }}
        inboxUnread={0}
        onNavigate={vi.fn()}
        onCreateRoom={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('org-dms-section')).toBeNull();
    expect(screen.getByTestId('org-rooms-section')).toBeTruthy();
  });

  it('drops the administration-only entries for a member', () => {
    render(
      <OrgSidebar
        model={{ ...model, adminTabs: visibleAdminTabs(false) }}
        inboxUnread={0}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByTestId('team-tab-members')).toBeTruthy();
    expect(screen.getByTestId('team-tab-settings')).toBeTruthy();
    expect(screen.queryByTestId('team-tab-billing')).toBeNull();
    expect(screen.queryByTestId('team-tab-danger')).toBeNull();
  });

  it('points an empty rooms section at the way out of it', () => {
    const { rerender } = render(
      <OrgSidebar
        model={{ ...model, rooms: [] }}
        inboxUnread={0}
        onNavigate={vi.fn()}
        onCreateRoom={vi.fn()}
      />,
    );
    expect(screen.getByTestId('org-rooms-empty').textContent).toContain('Create one with +');

    // A member who may not create rooms is sent to the directory instead.
    rerender(
      <OrgSidebar
        model={{ ...model, rooms: [], gating: { ...model.gating, canCreateRoom: false } }}
        inboxUnread={0}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByTestId('org-rooms-empty').textContent).toContain('browse the directory');

    // Still loading is not the same as empty, and must not read like it.
    rerender(
      <OrgSidebar
        model={{ ...model, rooms: [] }}
        inboxUnread={0}
        directoryLoading
        onNavigate={vi.fn()}
        onCreateRoom={vi.fn()}
      />,
    );
    expect(screen.getByTestId('org-rooms-empty').textContent).toContain('Loading rooms');
  });

  it('points an empty direct-messages section at the [+] that fills it', () => {
    render(
      <OrgSidebar
        model={{ ...model, dms: [] }}
        inboxUnread={0}
        onNavigate={vi.fn()}
        onCreateDirectMessage={vi.fn()}
      />,
    );

    expect(screen.getByTestId('org-dms-empty').textContent).toContain('Start one with +');
  });

  it('disables the room [+] for a member when creation is admins-only', () => {
    render(
      <OrgSidebar
        model={{ ...model, gating: { ...model.gating, canCreateRoom: false } }}
        inboxUnread={0}
        onNavigate={vi.fn()}
        onCreateRoom={vi.fn()}
        onCreateDirectMessage={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('org-rooms-section-add'));
    const create = screen.getByTestId('org-create-room') as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(create.title).toBe('Only organization admins can create rooms');
    // A member who may not create can still reach the directory from the menu.
    expect((screen.getByTestId('org-browse-rooms') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(document, { key: 'Escape' });
    // Rooms stay readable: only creation is restricted.
    expect(screen.getByTestId('org-room-item-design')).toBeTruthy();
    expect((screen.getByTestId('org-dms-section-add') as HTMLButtonElement).disabled).toBe(false);
  });
});
