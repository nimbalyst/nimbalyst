// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  CLOUDFLARE_SANDBOX_CHANNELS,
  type SandboxDeployment,
} from '../../../../../shared/cloudflareSandbox';
import { CloudflareSandboxStatusCard } from '../CloudflareSandboxStatusCard';

type Handler = (payload?: unknown) => unknown;

const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>();

function deployment(overrides: Partial<SandboxDeployment> = {}): SandboxDeployment {
  return {
    deploymentId: 'dep-1',
    revision: 'rev-7',
    status: 'deployed',
    container: { status: 'stopped', observedAt: null, message: null },
    node: null,
    profileName: 'work',
    account: { id: 'account-b', name: 'Account B' },
    access: 'private-rpc',
    url: null,
    deployedAt: '2026-09-09T00:00:00.000Z',
    errorMessage: null,
    ...overrides,
  };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ success: true, data: deployment() });
  (window as unknown as { electronAPI: { invoke: Handler } }).electronAPI = {
    invoke: invoke as unknown as Handler,
  };
});

afterEach(cleanup);

describe('CloudflareSandboxStatusCard', () => {
  it('reports deployment and container state as separate facts', () => {
    render(
      <CloudflareSandboxStatusCard
        deployment={deployment({ container: { status: 'unknown', observedAt: null, message: null } })}
        onDeploymentChange={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    // "Deployed" must never be rendered as evidence that a container is up.
    expect(screen.getByTestId('cloudflare-deployment-status').textContent).toContain('Deployed');
    expect(screen.getByTestId('cloudflare-container-status').textContent).toContain('Not observed yet');
    // A container that is not up can be woken but not stopped.
    expect((screen.getByTestId('cloudflare-wake') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('cloudflare-stop') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers stop only for a container that is actually up, and warns before stopping', async () => {
    render(
      <CloudflareSandboxStatusCard
        deployment={deployment({
          container: { status: 'running', observedAt: '2026-09-09T12:00:00.000Z', message: null },
        })}
        onDeploymentChange={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect((screen.getByTestId('cloudflare-wake') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('cloudflare-stop'));

    const warning = screen.getByTestId('cloudflare-stop-confirm');
    expect(warning.textContent).toContain('discards files written inside it');
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('cloudflare-stop-confirmed'));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    // Consent is carried in the request, not inferred from the call.
    expect(invoke.mock.calls[0]).toEqual([
      CLOUDFLARE_SANDBOX_CHANNELS.stop,
      {
        deploymentId: 'dep-1',
        revision: 'rev-7',
        profileName: 'work',
        accountId: 'account-b',
        discardEphemeralData: true,
      },
    ]);
  });

  it('binds delete to the reviewed deployment and requires confirmation', async () => {
    const onDeploymentChange = vi.fn();
    invoke.mockResolvedValue({ success: true, data: null });
    render(
      <CloudflareSandboxStatusCard
        deployment={deployment()}
        onDeploymentChange={onDeploymentChange}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('cloudflare-delete-deployment'));
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByTestId('cloudflare-delete-confirm').textContent).toContain('Account B');

    fireEvent.click(screen.getByTestId('cloudflare-delete-confirmed'));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke.mock.calls[0]).toEqual([
      CLOUDFLARE_SANDBOX_CHANNELS.deleteDeployment,
      {
        deploymentId: 'dep-1',
        revision: 'rev-7',
        profileName: 'work',
        accountId: 'account-b',
        confirmed: true,
      },
    ]);
    expect(onDeploymentChange).toHaveBeenCalledWith(null);
  });

  it('drops an open confirmation when the deployment underneath is replaced', () => {
    const { rerender } = render(
      <CloudflareSandboxStatusCard
        deployment={deployment()}
        onDeploymentChange={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('cloudflare-delete-deployment'));
    expect(screen.getByTestId('cloudflare-delete-confirm').textContent).toContain('Account B');

    // A refresh (or another window's write) re-points the card mid-confirmation.
    rerender(
      <CloudflareSandboxStatusCard
        deployment={deployment({
          deploymentId: 'dep-2',
          revision: 'rev-9',
          account: { id: 'account-c', name: 'Account C' },
        })}
        onDeploymentChange={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    // Consent for Account B is not consent for Account C.
    expect(screen.queryByTestId('cloudflare-delete-confirm')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('discards a lifecycle response that answers for a deployment the card has left', async () => {
    const pending: { resolveWake?: (value: unknown) => void } = {};
    invoke.mockImplementation(() => new Promise((resolve) => {
      pending.resolveWake = resolve;
    }));
    const onDeploymentChange = vi.fn();

    const { rerender } = render(
      <CloudflareSandboxStatusCard
        deployment={deployment()}
        onDeploymentChange={onDeploymentChange}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('cloudflare-wake'));
    expect(invoke).toHaveBeenCalledTimes(1);

    const replacement = deployment({
      deploymentId: 'dep-2',
      revision: 'rev-9',
      account: { id: 'account-c', name: 'Account C' },
    });
    rerender(
      <CloudflareSandboxStatusCard
        deployment={replacement}
        onDeploymentChange={onDeploymentChange}
        onRefresh={vi.fn()}
      />,
    );

    await act(async () => {
      pending.resolveWake?.({
        success: true,
        data: deployment({ container: { status: 'running', observedAt: null, message: null } }),
      });
      await Promise.resolve();
    });

    // The wake answered for dep-1; applying it would overwrite dep-2.
    expect(onDeploymentChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('cloudflare-deployment-status').textContent).toContain('Account C');
  });

  it('does not restore a deployment after its card was removed while a request was pending', async () => {
    let resolveWake!: (value: unknown) => void;
    invoke.mockImplementation(() => new Promise(resolve => { resolveWake = resolve; }));
    const onDeploymentChange = vi.fn();
    const { unmount } = render(
      <CloudflareSandboxStatusCard deployment={deployment()} onDeploymentChange={onDeploymentChange} onRefresh={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('cloudflare-wake'));
    unmount();
    await act(async () => { resolveWake({ success: true, data: deployment() }); });
    expect(onDeploymentChange).not.toHaveBeenCalled();
  });

  it('surfaces a stale-deployment rejection instead of retrying against another record', async () => {
    invoke.mockResolvedValue({
      success: false,
      error: { code: 'deployment-stale', message: 'This sandbox was changed in another window.' },
    });
    const onDeploymentChange = vi.fn();
    render(
      <CloudflareSandboxStatusCard
        deployment={deployment()}
        onDeploymentChange={onDeploymentChange}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('cloudflare-wake'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('changed in another window');
    expect(onDeploymentChange).not.toHaveBeenCalled();
  });
});
