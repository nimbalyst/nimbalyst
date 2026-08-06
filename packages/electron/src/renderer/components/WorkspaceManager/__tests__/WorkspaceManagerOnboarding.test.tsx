// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const startTutorial = vi.fn();
const invoke = vi.fn();

vi.mock('../WorkspaceManager', () => ({
  WorkspaceManager: () => (
    <div data-testid="workspace-manager-behind-onboarding">Workspace Manager</div>
  ),
}));

const { WorkspaceManagerOnboarding } = await import('../WorkspaceManagerOnboarding');

describe('WorkspaceManagerOnboarding', () => {
  beforeEach(() => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'onboarding:get') {
        return Promise.resolve({ unifiedOnboardingCompleted: false });
      }
      return Promise.resolve(undefined);
    });
    startTutorial.mockResolvedValue({
      success: true,
      reused: false,
      workspacePath: '/Documents/Nimbalyst Tutorial',
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      invoke,
      tutorial: {
        start: startTutorial,
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('persists Get started and reveals the manager without project-window mode state', async () => {
    render(<WorkspaceManagerOnboarding showOnboarding />);

    expect(screen.getByTestId('workspace-manager-behind-onboarding')).not.toBeNull();
    fireEvent.click(screen.getByText('Standard Mode'));
    fireEvent.click(screen.getByRole('button', { name: 'Get started…' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Get started…' })).toBeNull();
    });

    expect(invoke).toHaveBeenCalledWith('onboarding:update', {
      userRole: undefined,
      userEmail: undefined,
      referralSource: undefined,
      unifiedOnboardingCompleted: true,
      onboardingCompleted: true,
    });
    expect(invoke).toHaveBeenCalledWith('developer-mode:set', false);
    expect(startTutorial).not.toHaveBeenCalled();
    expect(screen.getByTestId('workspace-manager-behind-onboarding')).not.toBeNull();
  });

  it('persists onboarding before starting the tutorial', async () => {
    render(<WorkspaceManagerOnboarding showOnboarding />);

    fireEvent.click(screen.getByText('Developer Mode'));
    fireEvent.click(screen.getByRole('button', { name: 'Start tutorial' }));

    await waitFor(() => expect(startTutorial).toHaveBeenCalledOnce());

    expect(invoke).toHaveBeenCalledWith('developer-mode:set', true);
    const developerModeCall = invoke.mock.invocationCallOrder[
      invoke.mock.calls.findIndex(([channel]) => channel === 'developer-mode:set')
    ];
    expect(developerModeCall).toBeLessThan(startTutorial.mock.invocationCallOrder[0]);
  });

  it('does not show onboarding when the renderer flag is absent', () => {
    render(<WorkspaceManagerOnboarding showOnboarding={false} />);

    expect(screen.queryByRole('button', { name: 'Start tutorial' })).toBeNull();
    expect(screen.getByTestId('workspace-manager-behind-onboarding')).not.toBeNull();
  });
});
