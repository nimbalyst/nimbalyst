// @vitest-environment jsdom
import React from 'react';
import { Provider } from 'jotai';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';

import type { OrgSettings } from '../../../../../shared/orgSettings';
import { orgSettingsAtomFamily } from '../../../../store/atoms/orgSettings';
import { OrganizationSettingsPanel } from '../OrganizationSettingsPanel';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));

// The custody section talks to the team API on mount; this panel's own
// behaviour is what is under test.
vi.mock('../SecurityEncryptionSection', () => ({
  SecurityEncryptionSection: () => <div data-testid="security-encryption-section" />,
}));

const stored: Record<string, unknown> = {};
let setError: string | null = null;

const invoke = vi.fn(async (channel: string, request: { orgId: string; settings?: OrgSettings }) => {
  if (channel === 'org:settings:get') {
    return stored[request.orgId] ?? { version: 1, messaging: {} };
  }
  if (setError) throw new Error(setError);
  return request.settings;
});

/**
 * The panel's own hydration writes through the singleton store the app mounts
 * with, so the test renders against that store rather than a fresh one — and
 * each case uses its own org id so nothing leaks between them.
 */
function renderPanel(callerRole: string, orgId: string, onRenamed = vi.fn()) {
  return render(
    <Provider store={store}>
      <OrganizationSettingsPanel
        orgId={orgId}
        orgName="Acme"
        callerRole={callerRole}
        onRenamed={onRenamed}
      />
    </Provider>,
  );
}

function toggleInput(testId: string): HTMLInputElement {
  return screen.getByTestId(testId).querySelector('input') as HTMLInputElement;
}

describe('OrganizationSettingsPanel', () => {
  beforeEach(() => {
    invoke.mockClear();
    setError = null;
    for (const key of Object.keys(stored)) delete stored[key];
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      invoke,
      on: vi.fn(() => vi.fn()),
      organization: {
        rename: vi.fn(async (_orgId: string, name: string) => ({
          success: true,
          organization: { orgId: 'org-renamed', name },
        })),
      },
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the org name and the custody section, and loads settings', async () => {
    renderPanel('admin', 'org-load');

    expect((screen.getByTestId('organization-settings-name') as HTMLInputElement).value)
      .toBe('Acme');
    expect(screen.getByTestId('security-encryption-section')).toBeTruthy();
    await waitFor(() => expect(invoke)
      .toHaveBeenCalledWith('org:settings:get', { orgId: 'org-load' }));
    // A partial payload still renders every control, at its default.
    expect(toggleInput('organization-settings-rooms-toggle').checked).toBe(true);
  });

  it('lets an admin rename the organization through the typed client facade', async () => {
    const onRenamed = vi.fn();
    renderPanel('admin', 'org-renamed', onRenamed);

    const input = screen.getByTestId('organization-settings-name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Acme Labs' } });
    fireEvent.click(screen.getByTestId('organization-settings-name-save'));

    await waitFor(() => expect(window.electronAPI.organization.rename)
      .toHaveBeenCalledWith('org-renamed', 'Acme Labs'));
    expect(onRenamed).toHaveBeenCalledWith('Acme Labs');
  });

  it('sends the whole settings object with the changed toggle folded in', async () => {
    stored['org-patch'] = {
      version: 1,
      messaging: { roomsEnabled: true, dmsEnabled: true, roomCreation: 'admins' },
    };
    renderPanel('owner', 'org-patch');
    await waitFor(() => expect(
      (screen.getByTestId('organization-settings-room-creation') as HTMLSelectElement).value,
    ).toBe('admins'));

    fireEvent.click(toggleInput('organization-settings-rooms-toggle'));

    // The server's PUT replaces wholesale: the untouched roomCreation has to
    // travel with the one field that changed.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('org:settings:set', {
      orgId: 'org-patch',
      settings: {
        version: 1,
        messaging: { roomsEnabled: false, dmsEnabled: true, roomCreation: 'admins' },
      },
    }));
  });

  it('changes the room-creation policy', async () => {
    renderPanel('admin', 'org-creation');
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId('organization-settings-room-creation'), {
      target: { value: 'admins' },
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('org:settings:set', {
      orgId: 'org-creation',
      settings: {
        version: 1,
        messaging: { roomsEnabled: true, dmsEnabled: true, roomCreation: 'admins' },
      },
    }));
  });

  it('is read-only for a member, with an explanation', () => {
    renderPanel('member', 'org-member');

    expect(screen.getByTestId('organization-settings-readonly')).toBeTruthy();
    expect(toggleInput('organization-settings-rooms-toggle').disabled).toBe(true);
    expect(toggleInput('organization-settings-dms-toggle').disabled).toBe(true);
    expect((screen.getByTestId('organization-settings-room-creation') as HTMLSelectElement).disabled)
      .toBe(true);
    expect(screen.getByTestId('organization-settings-name').tagName).toBe('P');

    fireEvent.click(toggleInput('organization-settings-rooms-toggle'));
    expect(invoke).not.toHaveBeenCalledWith('org:settings:set', expect.anything());
  });

  // The org window's header band is gone (2026-07-28 layout decision), so this
  // panel is the only place left that says which account owns the org.
  it('states the owning account, and omits the line when there is none', () => {
    const { unmount } = render(
      <Provider store={store}>
        <OrganizationSettingsPanel
          orgId="org-owner"
          orgName="Acme"
          ownerEmail="owner@example.com"
          callerRole="owner"
        />
      </Provider>,
    );
    expect(screen.getByTestId('organization-settings-owner').textContent)
      .toContain('Owned by owner@example.com');
    unmount();

    renderPanel('owner', 'org-no-owner');
    expect(screen.queryByTestId('organization-settings-owner')).toBeNull();
  });

  it('surfaces a rejected save instead of claiming the setting changed', async () => {
    setError = 'Only organization admins may update settings';
    renderPanel('admin', 'org-rejected');
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    fireEvent.click(toggleInput('organization-settings-dms-toggle'));

    await waitFor(() => expect(screen.getByTestId('organization-settings-save-error').textContent)
      .toContain('Only organization admins may update settings'));
    // Nothing was applied optimistically; the broadcast is what writes the atom.
    expect(store.get(orgSettingsAtomFamily('org-rejected')).messaging.dmsEnabled).toBe(true);
  });
});
