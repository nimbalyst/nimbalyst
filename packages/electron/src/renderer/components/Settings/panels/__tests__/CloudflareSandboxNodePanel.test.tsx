// @vitest-environment jsdom
import React from 'react';
import { Provider } from 'jotai';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';

import {
  CLOUDFLARE_SANDBOX_CHANNELS,
  type SandboxDeployment,
  type SandboxNodeState,
} from '../../../../../shared/cloudflareSandbox';
import { activeWorkspacePathAtom } from '../../../../store/atoms/openProjects';
import { CloudflareSandboxNodePanel } from '../CloudflareSandboxNodePanel';

const WORKSPACE = '/Users/me/sources/stravu-editor';

const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>();

function connectedNode(overrides: Partial<SandboxNodeState> = {}): SandboxNodeState {
  return {
    running: true,
    processId: 'proc-1',
    startedAt: Date.parse('2026-09-10T12:00:00.000Z'),
    exitCode: null,
    recentLog: 'serve: joined index room',
    nodeId: 'node-1',
    deviceId: 'sandbox-dep-1',
    provisionedAt: '2026-09-10T12:00:00.000Z',
    workspace: { projectId: WORKSPACE, branch: 'main' },
    ...overrides,
  };
}

function deployment(node: SandboxNodeState | null): SandboxDeployment {
  return {
    deploymentId: 'dep-1',
    revision: 'rev-7',
    status: 'deployed',
    container: { status: 'running', observedAt: null, message: null },
    node,
    profileName: 'work',
    account: { id: 'account-b', name: 'Account B' },
    access: 'private-rpc',
    url: null,
    deployedAt: '2026-09-09T00:00:00.000Z',
    errorMessage: null,
  };
}

function renderPanel(node: SandboxNodeState | null, workspacePath: string | null = WORKSPACE) {
  store.set(activeWorkspacePathAtom, workspacePath);
  return render(
    <Provider store={store}>
      <CloudflareSandboxNodePanel deployment={deployment(node)} onDeploymentChange={vi.fn()} />
    </Provider>,
  );
}

function disabled(testId: string): boolean {
  return (screen.getByTestId(testId) as HTMLButtonElement).disabled;
}

/** The payload of the one call on `channel`. */
function payloadFor(channel: string): Record<string, unknown> {
  const call = invoke.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`no invoke on ${channel}`);
  return call[1] as Record<string, unknown>;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ success: true, data: deployment(connectedNode()) });
  (window as unknown as { electronAPI: unknown }).electronAPI = { invoke };
});

afterEach(cleanup);

describe('CloudflareSandboxNodePanel', () => {
  it('connects with the deployment target and the open workspace, and refuses without one', async () => {
    const { unmount } = renderPanel(null);

    fireEvent.click(screen.getByTestId('cloudflare-connect-node'));
    await waitFor(() => expect(invoke).toHaveBeenCalled());

    expect(payloadFor(CLOUDFLARE_SANDBOX_CHANNELS.connectNode)).toEqual({
      deploymentId: 'dep-1',
      revision: 'rev-7',
      profileName: 'work',
      accountId: 'account-b',
      workspacePath: WORKSPACE,
    });

    unmount();
    invoke.mockClear();
    renderPanel(null, null);
    // No workspace means no repository to clone, so the request is never made
    // rather than sent with an empty path for the handler to reject.
    expect(disabled('cloudflare-connect-node')).toBe(true);
    screen.getByTestId('cloudflare-node-no-workspace');
  });

  it('will not reconnect over a node that is already running', () => {
    renderPanel(connectedNode());
    expect(disabled('cloudflare-connect-node')).toBe(true);
  });

  it('requires the discard warning before it will disconnect', async () => {
    renderPanel(connectedNode());

    fireEvent.click(screen.getByTestId('cloudflare-disconnect-node'));
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('cloudflare-disconnect-confirmed'));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(payloadFor(CLOUDFLARE_SANDBOX_CHANNELS.disconnectNode)).toMatchObject({
      deploymentId: 'dep-1',
      discardEphemeralData: true,
    });
  });

  it('sends the prompt with the workspace and shows the session it started', async () => {
    invoke.mockResolvedValue({ success: true, data: { requestId: 'req-1', sessionId: 'session-42' } });
    renderPanel(connectedNode());

    fireEvent.change(screen.getByTestId('cloudflare-remote-session-prompt'), {
      target: { value: 'add a readme' },
    });
    fireEvent.click(screen.getByTestId('cloudflare-start-remote-session'));

    await waitFor(() => screen.getByTestId('cloudflare-remote-session-result'));
    expect(payloadFor(CLOUDFLARE_SANDBOX_CHANNELS.startRemoteSession)).toMatchObject({
      workspacePath: WORKSPACE,
      prompt: 'add a readme',
    });
    expect(screen.getByTestId('cloudflare-remote-session-result').textContent).toContain('session-42');
  });

  it('offers no session form while the node is stopped, and surfaces the failure text', async () => {
    invoke.mockResolvedValue({
      success: false,
      error: { code: 'node-not-provisioned', message: 'This sandbox has no agent node in it.' },
    });
    renderPanel(connectedNode({ running: false, processId: null, startedAt: null, exitCode: 1 }));

    expect(screen.queryByTestId('cloudflare-remote-session-form')).toBeNull();
    expect(screen.getByTestId('cloudflare-node-status').textContent).toContain('exit code 1');

    fireEvent.click(screen.getByTestId('cloudflare-node-refresh'));
    await waitFor(() => screen.getByTestId('cloudflare-node-error'));
    expect(screen.getByTestId('cloudflare-node-error').textContent).toContain('no agent node');
  });
});
