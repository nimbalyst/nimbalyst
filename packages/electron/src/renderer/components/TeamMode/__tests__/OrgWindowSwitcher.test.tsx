// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));

import { OrgWindowSwitcher } from '../OrgWindowSwitcher';
import type { OrgChoice } from '../defaultOrg';

const organizations: OrgChoice[] = [
  { orgId: 'org-a', name: 'Acme', role: 'owner' },
  { orgId: 'org-b', name: 'Beta', role: 'member', membershipType: 'active_member' },
  { orgId: 'org-invited', name: 'Invited', role: 'member', membershipType: 'invited_member' },
];

describe('OrgWindowSwitcher', () => {
  afterEach(() => cleanup());

  it('lists active memberships only and retargets on selection', () => {
    const onSelect = vi.fn();
    render(<OrgWindowSwitcher organizations={organizations} selectedOrgId="org-a" onSelect={onSelect} />);

    expect(screen.getByTestId('org-window-switcher-button').textContent).toContain('Acme');
    fireEvent.click(screen.getByTestId('org-window-switcher-button'));

    const items = screen.getAllByTestId('org-window-switcher-item');
    expect(items.map((item) => item.getAttribute('data-org-id'))).toEqual(['org-a', 'org-b']);

    fireEvent.click(items[1]);
    expect(onSelect).toHaveBeenCalledWith('org-b');
  });

  it('does not re-select the organization already being administered', () => {
    const onSelect = vi.fn();
    render(<OrgWindowSwitcher organizations={organizations} selectedOrgId="org-a" onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId('org-window-switcher-button'));
    fireEvent.click(screen.getAllByTestId('org-window-switcher-item')[0]);

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('org-window-switcher-menu')).toBeNull();
  });

  // The row is the window's org header now, so it stays even with a single
  // organization — dropping it would leave the window with no org identity.
  it('shows the org identity when there is nothing to switch between', () => {
    render(
      <OrgWindowSwitcher
        organizations={[organizations[0], organizations[2]]}
        selectedOrgId="org-a"
        selectedOrgName="Acme"
        onSelect={vi.fn()}
      />,
    );

    const button = screen.getByTestId('org-window-switcher-button');
    expect(button.textContent).toContain('Acme');
    // Initials avatar and the alpha chip that used to live in the header band.
    expect(button.querySelector('.org-window-switcher-avatar')?.textContent).toBe('AC');
    expect(screen.getByTestId('alpha-badge')).toBeTruthy();

    fireEvent.click(button);
    expect(screen.queryAllByTestId('org-window-switcher-item')).toHaveLength(0);
  });

  it('prefers the bound organization name so a rename shows immediately', () => {
    render(
      <OrgWindowSwitcher
        organizations={organizations}
        selectedOrgId="org-a"
        selectedOrgName="Acme Renamed"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId('org-window-switcher-button').textContent).toContain('Acme Renamed');
  });

  it('offers the web console from the menu, replacing the header button', () => {
    const onOpenWebConsole = vi.fn();
    render(
      <OrgWindowSwitcher
        organizations={organizations}
        selectedOrgId="org-a"
        onSelect={vi.fn()}
        onOpenWebConsole={onOpenWebConsole}
      />,
    );

    fireEvent.click(screen.getByTestId('org-window-switcher-button'));
    fireEvent.click(screen.getByTestId('org-window-switcher-console'));

    expect(onOpenWebConsole).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('org-window-switcher-menu')).toBeNull();
  });

  it('renders nothing with no organization to identify or switch to', () => {
    const { container } = render(
      <OrgWindowSwitcher organizations={[organizations[2]]} selectedOrgId={null} onSelect={vi.fn()} />,
    );

    expect(container.querySelector('.org-window-switcher')).toBeNull();
  });
});
