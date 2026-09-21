import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'jotai';
vi.mock('../../../../store/atoms/openProjects', async () => ({
  activeWorkspacePathAtom: (await import('jotai')).atom('C:\\project'),
}));
import { CodexWindowsSandboxSection } from '../CodexWindowsSandboxSection';

afterEach(cleanup);

it('starts only the user-selected setup for the active project and surfaces its failure', async () => {
  const invoke = vi.fn().mockResolvedValueOnce({ phase: 'idle', readiness: 'notConfigured', allowedModes: ['elevated'] })
    .mockRejectedValueOnce(new Error('Windows setup was cancelled'));
  window.electronAPI = { ...window.electronAPI, invoke };
  render(<Provider><CodexWindowsSandboxSection /></Provider>);
  const setup = await screen.findByRole('button', { name: 'Set up sandbox (recommended)' });
  expect(screen.queryByRole('button', { name: 'Set up without administrator access' })).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(setup);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('openai-codex:sandbox-setup', 'elevated', 'C:\\project'));
  expect((await screen.findByRole('alert')).textContent).toContain('Windows setup was cancelled');
});
