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

  it('stays out of the way when there is nothing to switch between', () => {
    const { container } = render(
      <OrgWindowSwitcher
        organizations={[organizations[0], organizations[2]]}
        selectedOrgId="org-a"
        onSelect={vi.fn()}
      />,
    );

    expect(container.querySelector('.org-window-switcher')).toBeNull();
  });
});
