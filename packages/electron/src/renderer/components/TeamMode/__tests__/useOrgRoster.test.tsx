// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useOrgRoster } from '../useOrgRoster';

function Probe({ orgId }: { orgId: string }) {
  const roster = useOrgRoster(orgId);
  return (
    <div
      data-testid="roster"
      data-caller-role={roster.callerRole ?? 'unresolved'}
      data-viewer={roster.viewerUserId ?? 'none'}
      data-loading={String(roster.loading)}
    />
  );
}

function rosterEl(): HTMLElement {
  return screen.getByTestId('roster');
}

function stubElectronAPI(value: Record<string, unknown>): void {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value });
}

describe('useOrgRoster', () => {
  afterEach(() => cleanup());

  it('leaves the role unresolved until it answers for this organization', async () => {
    let release: (() => void) | undefined;
    stubElectronAPI({
        organization: {
          listMembers: () => new Promise((resolve) => {
            release = () => resolve({
              success: true,
              callerRole: 'admin',
              members: [{ memberId: 'member-a', email: 'greg@example.com', name: 'Greg', role: 'admin' }],
            });
          }),
        },
      stytch: { getAccounts: async () => [{ email: 'greg@example.com' }] },
    });

    render(<Probe orgId="org-a" />);

    // Not "member": an unresolved role must not read as a demotion.
    expect(rosterEl().getAttribute('data-caller-role')).toBe('unresolved');

    release?.();
    await waitFor(() =>
      expect(rosterEl().getAttribute('data-caller-role')).toBe('admin'));
    expect(rosterEl().getAttribute('data-viewer')).toBe('member-a');
  });

  it('does not carry one organization\'s role or member id into the next', async () => {
    const rosters: Record<string, { callerRole: string; memberId: string }> = {
      'org-a': { callerRole: 'admin', memberId: 'member-a' },
      'org-b': { callerRole: 'member', memberId: 'member-b' },
    };
    let releaseB: (() => void) | undefined;
    stubElectronAPI({
        organization: {
          listMembers: (orgId: string) => {
            const roster = {
              success: true,
              callerRole: rosters[orgId].callerRole,
              members: [{
                memberId: rosters[orgId].memberId,
                email: 'greg@example.com',
                name: 'Greg',
                role: rosters[orgId].callerRole,
              }],
            };
            if (orgId === 'org-a') return Promise.resolve(roster);
            return new Promise((resolve) => { releaseB = () => resolve(roster); });
          },
        },
      stytch: { getAccounts: async () => [{ email: 'greg@example.com' }] },
    });

    const { rerender } = render(<Probe orgId="org-a" />);
    await waitFor(() =>
      expect(rosterEl().getAttribute('data-caller-role')).toBe('admin'));

    rerender(<Probe orgId="org-b" />);

    // Mid-switch: org A's admin role and member id must not describe org B.
    await waitFor(() =>
      expect(rosterEl().getAttribute('data-caller-role')).toBe('unresolved'));
    expect(rosterEl().getAttribute('data-viewer')).toBe('none');

    releaseB?.();
    await waitFor(() =>
      expect(rosterEl().getAttribute('data-caller-role')).toBe('member'));
    expect(rosterEl().getAttribute('data-viewer')).toBe('member-b');
  });

  it('does not demote to member when the roster read fails', async () => {
    stubElectronAPI({
        organization: {
          listMembers: () => Promise.reject(new Error('offline')),
        },
      stytch: { getAccounts: async () => [{ email: 'greg@example.com' }] },
    });

    render(<Probe orgId="org-a" />);

    await waitFor(() =>
      expect(rosterEl().getAttribute('data-loading')).toBe('false'));
    // A failed read is not evidence of a demotion: the role stays unresolved,
    // which is what keeps an admin from being bounced off their own panels.
    expect(rosterEl().getAttribute('data-caller-role')).toBe('unresolved');
  });
});
