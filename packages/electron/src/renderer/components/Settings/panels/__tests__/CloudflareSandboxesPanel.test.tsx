// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CLOUDFLARE_SANDBOX_CHANNELS } from '../../../../../shared/cloudflareSandbox';
import { CloudflareSandboxesPanel } from '../CloudflareSandboxesPanel';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

type Handler = (payload?: unknown, updates?: any) => unknown;

const handlers = new Map<string, Handler>();

function setHandler(channel: string, handler: Handler): void {
  handlers.set(channel, handler);
}

const readyPrerequisites = {
  wrangler: { installed: true, version: '4.125.0', supportsProfiles: true },
  ready: true,
};

const profiles = [
  { name: 'personal', identity: 'me@example.com', authenticated: true, boundDirectories: [] },
  { name: 'work', identity: 'me@work.example', authenticated: true, boundDirectories: [] },
];

beforeEach(() => {
  handlers.clear();
  setHandler(CLOUDFLARE_SANDBOX_CHANNELS.getPrerequisites, () => ({ success: true, data: readyPrerequisites }));
  setHandler(CLOUDFLARE_SANDBOX_CHANNELS.listProfiles, () => ({ success: true, data: profiles }));
  setHandler(CLOUDFLARE_SANDBOX_CHANNELS.getDeployment, () => ({ success: true, data: null }));

  (window as unknown as { electronAPI: { invoke: Handler } }).electronAPI = {
    invoke: ((channel: string, payload?: unknown, updates?: any) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Unexpected channel ${channel}`);
      return Promise.resolve(handler(payload, updates));
    }) as unknown as Handler,
  };
});

afterEach(cleanup);

function accountOptionValues(): string[] {
  const select = screen.getByTestId('cloudflare-account-select') as HTMLSelectElement;
  return Array.from(select.options).map((option) => option.value);
}

describe('CloudflareSandboxesPanel', () => {
  it('restores explicit profile/account choices on remount and isolates projects', async () => {
    const saved = new Map<string, unknown>();
    setHandler('workspace:get-state', path => saved.get(path as string) ?? {});
    setHandler('workspace:update-state', (path, updates) => { saved.set(path as string, updates); return updates; });
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.listAccounts, () => ({success: true, data: [{id: 'account-a', name: 'Account A'}]}));
    const first = render(<CloudflareSandboxesPanel workspacePath="/project-a" />);
    fireEvent.click(await screen.findByTestId('cloudflare-profile-personal'));
    await screen.findByTestId('cloudflare-account-select');
    fireEvent.change(screen.getByTestId('cloudflare-account-select'), {target: {value: 'account-a'}});
    await waitFor(() => expect(saved.get('/project-a')).toEqual({cloudflareSandboxSelection: {profileName: 'personal', accountId: 'account-a'}}));
    first.unmount();
    const second = render(<CloudflareSandboxesPanel workspacePath="/project-a" />);
    await waitFor(() => expect((screen.getByTestId('cloudflare-account-select') as HTMLSelectElement).value).toBe('account-a'));
    expect((screen.getByTestId('cloudflare-deploy') as HTMLButtonElement).disabled).toBe(true);
    second.unmount();
    render(<CloudflareSandboxesPanel workspacePath="/project-b" />);
    await screen.findByTestId('cloudflare-profile-personal');
    expect(screen.queryByTestId('cloudflare-account-select')).toBeNull();
  });

  it('ignores an account response that belongs to a profile the user already left', async () => {
    const pending: { resolvePersonal?: (value: unknown) => void } = {};
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.listAccounts, (payload) => {
      const { profileName } = payload as { profileName: string };
      if (profileName === 'personal') {
        return new Promise((resolve) => {
          pending.resolvePersonal = resolve;
        });
      }
      return { success: true, data: [{ id: 'work-account', name: 'Work Account' }] };
    });

    render(<CloudflareSandboxesPanel />);
    await screen.findByTestId('cloudflare-profile-personal');

    fireEvent.click(screen.getByTestId('cloudflare-profile-personal'));
    fireEvent.click(screen.getByTestId('cloudflare-profile-work'));

    await waitFor(() => expect(accountOptionValues()).toEqual(['', 'work-account']));

    // The superseded request finishes last; it must not repopulate the list.
    await act(async () => {
      pending.resolvePersonal?.({ success: true, data: [{ id: 'personal-account', name: 'Personal Account' }] });
      await Promise.resolve();
    });

    expect(accountOptionValues()).toEqual(['', 'work-account']);
  });

  it('never preselects an account even when the profile has exactly one', async () => {
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.listAccounts, () => ({
      success: true,
      data: [{ id: 'only-account', name: 'Only Account' }],
    }));

    render(<CloudflareSandboxesPanel />);
    await screen.findByTestId('cloudflare-profile-personal');
    fireEvent.click(screen.getByTestId('cloudflare-profile-personal'));

    await waitFor(() => expect(accountOptionValues()).toEqual(['', 'only-account']));
    expect((screen.getByTestId('cloudflare-account-select') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('cloudflare-review-deployment') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('cloudflare-deploy') as HTMLButtonElement).disabled).toBe(true);
  });

  it('requires a reviewed, acknowledged plan for the current selection before deploying', async () => {
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.listAccounts, () => ({
      success: true,
      data: [
        { id: 'account-a', name: 'Account A' },
        { id: 'account-b', name: 'Account B' },
      ],
    }));
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.planDeployment, (payload) => {
      const { profileName, accountId } = payload as { profileName: string; accountId: string };
      return {
        success: true,
        data: {
          planId: `plan-${accountId}`,
          profileName,
          account: { id: accountId, name: accountId === 'account-a' ? 'Account A' : 'Account B' },
          resources: [{ kind: 'Worker', name: 'nimbalyst-sandbox', action: 'create' }],
          container: { instanceType: 'standard-3', maxInstances: 1, sleepAfterMinutes: 5 },
          costNotes: ['Charged per request.'],
          requiresPaidPlan: true,
        },
      };
    });
    const deploy = vi.fn((_payload?: unknown) => ({
      success: true,
      data: {
        deploymentId: 'dep-1',
        revision: 'rev-1',
        status: 'deployed',
        container: { status: 'stopped', observedAt: null, message: null },
        profileName: 'personal',
        account: { id: 'account-b', name: 'Account B' },
        access: 'private-rpc',
        url: null,
        deployedAt: '2026-09-09T00:00:00.000Z',
        errorMessage: null,
      },
    }));
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.deploy, deploy);

    render(<CloudflareSandboxesPanel />);
    await screen.findByTestId('cloudflare-profile-personal');
    fireEvent.click(screen.getByTestId('cloudflare-profile-personal'));
    await waitFor(() => expect(accountOptionValues()).toEqual(['', 'account-a', 'account-b']));

    fireEvent.change(screen.getByTestId('cloudflare-account-select'), { target: { value: 'account-a' } });
    // Selecting an account is not consent to deploy.
    expect((screen.getByTestId('cloudflare-deploy') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('cloudflare-review-deployment'));
    await screen.findByTestId('cloudflare-deployment-plan');
    // A reviewed but unacknowledged plan is still not consent.
    expect((screen.getByTestId('cloudflare-deploy') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('cloudflare-acknowledge-plan'));
    expect((screen.getByTestId('cloudflare-deploy') as HTMLButtonElement).disabled).toBe(false);

    // Switching accounts invalidates the acknowledged plan rather than
    // carrying consent over to an account the user never reviewed.
    fireEvent.change(screen.getByTestId('cloudflare-account-select'), { target: { value: 'account-b' } });
    expect(screen.queryByTestId('cloudflare-deployment-plan')).toBeNull();
    expect((screen.getByTestId('cloudflare-deploy') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('cloudflare-review-deployment'));
    await screen.findByTestId('cloudflare-deployment-plan');
    fireEvent.click(screen.getByTestId('cloudflare-acknowledge-plan'));
    fireEvent.click(screen.getByTestId('cloudflare-deploy'));

    await waitFor(() => expect(deploy).toHaveBeenCalledTimes(1));
    expect(deploy.mock.calls[0][0]).toEqual({
      planId: 'plan-account-b',
      profileName: 'personal',
      accountId: 'account-b',
    });

    // A successful deploy is a deployment, not a warm container.
    const status = await screen.findByTestId('cloudflare-deployment-status');
    expect(status.textContent).toContain('Deployed');
    expect(screen.getByTestId('cloudflare-container-status').textContent).toContain('Stopped');
    expect(screen.getByTestId('cloudflare-access').textContent).toContain('no public endpoint');
  });

  it('discards a deployment review whose account the user changed while it was in flight', async () => {
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.listAccounts, () => ({
      success: true,
      data: [
        { id: 'account-a', name: 'Account A' },
        { id: 'account-b', name: 'Account B' },
      ],
    }));
    const pending: { resolvePlan?: (value: unknown) => void } = {};
    setHandler(
      CLOUDFLARE_SANDBOX_CHANNELS.planDeployment,
      () => new Promise((resolve) => {
        pending.resolvePlan = resolve;
      }),
    );

    render(<CloudflareSandboxesPanel />);
    await screen.findByTestId('cloudflare-profile-personal');
    fireEvent.click(screen.getByTestId('cloudflare-profile-personal'));
    await waitFor(() => expect(accountOptionValues()).toEqual(['', 'account-a', 'account-b']));

    fireEvent.change(screen.getByTestId('cloudflare-account-select'), { target: { value: 'account-a' } });
    fireEvent.click(screen.getByTestId('cloudflare-review-deployment'));
    fireEvent.change(screen.getByTestId('cloudflare-account-select'), { target: { value: 'account-b' } });

    await act(async () => {
      pending.resolvePlan?.({
        success: true,
        data: {
          planId: 'plan-account-a',
          profileName: 'personal',
          account: { id: 'account-a', name: 'Account A' },
          resources: [{ kind: 'Worker', name: 'nimbalyst-sandbox', action: 'create' }],
          container: { instanceType: 'standard-3', maxInstances: 1, sleepAfterMinutes: 5 },
          costNotes: [],
          requiresPaidPlan: false,
        },
      });
      await Promise.resolve();
    });

    // Account A's review must not present itself as a review of Account B.
    expect(screen.queryByTestId('cloudflare-deployment-plan')).toBeNull();
    expect((screen.getByTestId('cloudflare-deploy') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the last known sandbox when a refresh fails, and offers a retry', async () => {
    const saved = {
      deploymentId: 'dep-1',
      revision: 'rev-1',
      status: 'deployed',
      container: { status: 'running', observedAt: '2026-09-09T12:00:00.000Z', message: null },
      profileName: 'personal',
      account: { id: 'account-a', name: 'Account A' },
      access: 'private-rpc',
      url: null,
      deployedAt: '2026-09-09T00:00:00.000Z',
      errorMessage: null,
    };
    let getCalls = 0;
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.getDeployment, () => {
      getCalls += 1;
      if (getCalls === 1) return { success: true, data: saved };
      if (getCalls === 2) {
        return { success: false, error: { code: 'unknown', message: 'IPC timed out.' } };
      }
      return { success: true, data: saved };
    });

    render(<CloudflareSandboxesPanel />);
    await screen.findByTestId('cloudflare-status-section');

    fireEvent.click(screen.getByTestId('cloudflare-refresh-status'));

    // A failed read must not be rendered as "no deployment".
    const failure = await screen.findByTestId('cloudflare-deployment-load-error');
    expect(failure.textContent).toContain('IPC timed out.');
    expect(screen.getByTestId('cloudflare-deployment-status').textContent).toContain('Account A');

    fireEvent.click(screen.getByTestId('cloudflare-retry-deployment-load'));
    await waitFor(() => expect(screen.queryByTestId('cloudflare-deployment-load-error')).toBeNull());
    expect(screen.getByTestId('cloudflare-status-section')).toBeDefined();
  });

  it('does not let a slow read resurrect a sandbox that was just deleted', async () => {
    const saved = {
      deploymentId: 'dep-1',
      revision: 'rev-1',
      status: 'deployed',
      container: { status: 'running', observedAt: null, message: null },
      profileName: 'personal',
      account: { id: 'account-a', name: 'Account A' },
      access: 'private-rpc',
      url: null,
      deployedAt: '2026-09-09T00:00:00.000Z',
      errorMessage: null,
    };
    const pending: { resolveGet?: (value: unknown) => void } = {};
    let getCalls = 0;
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.getDeployment, () => {
      getCalls += 1;
      if (getCalls === 1) return { success: true, data: saved };
      return new Promise((resolve) => {
        pending.resolveGet = resolve;
      });
    });
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.deleteDeployment, () => ({ success: true, data: null }));

    render(<CloudflareSandboxesPanel />);
    await screen.findByTestId('cloudflare-status-section');

    // A refresh is in flight when the user deletes the sandbox.
    fireEvent.click(screen.getByTestId('cloudflare-refresh-status'));
    fireEvent.click(screen.getByTestId('cloudflare-delete-deployment'));
    fireEvent.click(screen.getByTestId('cloudflare-delete-confirmed'));
    await waitFor(() => expect(screen.queryByTestId('cloudflare-status-section')).toBeNull());

    await act(async () => {
      pending.resolveGet?.({ success: true, data: saved });
      await Promise.resolve();
    });

    // The read predates the delete; applying it would bring the sandbox back.
    expect(screen.queryByTestId('cloudflare-status-section')).toBeNull();
  });

  it('refuses to request a profile name Wrangler reserves', async () => {
    const createProfile = vi.fn((_payload?: unknown) => ({ success: true, data: profiles[0] }));
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.createProfile, createProfile);

    render(<CloudflareSandboxesPanel />);
    await screen.findByTestId('cloudflare-profile-personal');

    // `wrangler auth create default` always fails: default is managed by login.
    fireEvent.change(screen.getByTestId('cloudflare-new-profile-name'), {
      target: { value: 'default' },
    });
    expect(screen.getByTestId('cloudflare-new-profile-name-error').textContent).toContain('reserved');
    expect((screen.getByTestId('cloudflare-sign-in') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('cloudflare-new-profile-name'), {
      target: { value: 'work laptop' },
    });
    expect((screen.getByTestId('cloudflare-sign-in') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('cloudflare-new-profile-name'), {
      target: { value: 'work-laptop' },
    });
    expect(screen.queryByTestId('cloudflare-new-profile-name-error')).toBeNull();
    expect((screen.getByTestId('cloudflare-sign-in') as HTMLButtonElement).disabled).toBe(false);
    expect(createProfile).not.toHaveBeenCalled();
  });

  it('reports missing backend support instead of rendering a usable form', async () => {
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.getPrerequisites, () => undefined);
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.listProfiles, () => undefined);
    setHandler(CLOUDFLARE_SANDBOX_CHANNELS.getDeployment, () => undefined);

    render(<CloudflareSandboxesPanel />);

    // A failed FIRST read is visible too, not just a failed refresh.
    const initialFailure = await screen.findByTestId('cloudflare-deployment-load-error');
    expect(initialFailure.textContent).toContain('Could not read the sandbox');

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((alert) => /unavailable in this build/i.test(alert.textContent ?? ''))).toBe(true);
    expect((screen.getByTestId('cloudflare-review-deployment') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('cloudflare-deploy') as HTMLButtonElement).disabled).toBe(true);
  });
});
