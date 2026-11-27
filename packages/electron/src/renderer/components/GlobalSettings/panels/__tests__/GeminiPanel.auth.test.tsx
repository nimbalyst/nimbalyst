// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GeminiPanel } from '../GeminiPanel';

vi.mock('../../SettingsToggle', () => ({
  SettingsToggle: ({ name }: { name: string }) => <div>{name}</div>,
}));
vi.mock('../../../common/AlphaBadge', () => ({
  AlphaBadge: () => null,
  SETTINGS_ALPHA_TOOLTIP: '',
}));

describe('GeminiPanel Google auth section', () => {
  const invokeMock = vi.fn();
  const listeners = new Map<string, (...args: unknown[]) => void>();

  beforeEach(() => {
    invokeMock.mockReset();
    listeners.clear();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        aiGetHeadlessAgentAvailability: vi.fn(async () => ({
          'antigravity-gemini-agent': { installed: true, executablePath: '/Applications/Antigravity.app' },
        })),
        invoke: invokeMock,
        on: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
          listeners.set(channel, cb);
          return () => listeners.delete(channel);
        }),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders signed-in account with Switch account, Refresh, and Sign out actions', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'gemini-auth:status') {
        return {
          installed: true,
          isLoggedIn: true,
          email: 'user@example.com',
          name: 'User',
          planName: 'Pro',
          tier: 'TEAMS_TIER_PRO',
          loginInProgress: false,
          loginAuthUrl: null,
        };
      }
      if (channel === 'gemini-auth:switch-account') {
        return { success: true, started: true };
      }
      return { success: true };
    });

    render(<GeminiPanel config={{ id: 'antigravity-gemini-agent', name: 'Gemini', enabled: true } as never} onToggle={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Signed in with Google')).toBeTruthy();
    });
    expect(screen.getByText('user@example.com • Pro')).toBeTruthy();

    fireEvent.click(screen.getByTestId('gemini-switch-account'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('gemini-auth:switch-account');
    });
  });

  it('renders Sign in with Google when signed out and shows in-progress banner during OAuth', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'gemini-auth:status') {
        return {
          installed: true,
          isLoggedIn: false,
          email: null,
          name: null,
          planName: null,
          tier: null,
          loginInProgress: true,
          loginAuthUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        };
      }
      return { success: true };
    });

    render(<GeminiPanel config={{ id: 'antigravity-gemini-agent', name: 'Gemini', enabled: true } as never} onToggle={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('gemini-login-google')).toBeTruthy();
    });
    expect(screen.getByTestId('gemini-auth-in-progress')).toBeTruthy();

    fireEvent.click(screen.getByText('Open browser'));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'gemini-auth:open-url',
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
    });
  });
});
