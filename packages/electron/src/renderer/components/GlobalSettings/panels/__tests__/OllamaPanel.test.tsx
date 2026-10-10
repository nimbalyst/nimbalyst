// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';
import { activeWorkspacePathAtom } from '../../../../store/atoms/openProjects';

const { change, refreshCredentials, refreshUsage } = vi.hoisted(() => ({
  change: vi.fn().mockResolvedValue(undefined),
  refreshCredentials: vi.fn().mockResolvedValue(undefined),
  refreshUsage: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../../store/providerCredentials', async () => {
  const { atom } = await import('jotai');
  return {
    providerCredentialsAtom: atom({ state: 'available', credentials: [] }),
    providerCredentialErrorAtom: atom(null),
    refreshProviderCredentials: refreshCredentials,
    changeProviderCredential: change,
  };
});
vi.mock('../../../../store/listeners/ollamaUsageListeners', () => ({ refreshOllamaUsage: refreshUsage }));
vi.mock('../../../../store/atoms/ollamaUsageAtoms', async () => {
  const { atom } = await import('jotai');
  return { ollamaUsageAtom: atom({ authStatus: 'sign-in-required', limitsAvailable: false, lastUpdated: 0 }) };
});

import { OllamaPanel } from '../OllamaPanel';
afterEach(cleanup);
beforeEach(() => { change.mockClear(); refreshCredentials.mockClear(); refreshUsage.mockClear(); });

it('does not report success when connect resolves with a cancelled sign-in snapshot', async () => {
  const invoke = vi.fn().mockResolvedValue({
    source: 'ollama-dashboard', authStatus: 'sign-in-required', limitsAvailable: false,
    error: 'Sign in to view Ollama usage.', lastUpdated: Date.now(),
  });
  (window as any).electronAPI = { invoke };
  const store = createStore(); store.set(activeWorkspacePathAtom, '/fixture/A');
  render(<Provider store={store}><OllamaPanel /></Provider>);
  expect(screen.getByLabelText('Ollama API key')).toBeTruthy();
  expect(screen.getByText(/Sign-in required to show usage/)).toBeTruthy();
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in to Ollama' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('ollama-usage:connect', '/fixture/A'));
  await screen.findByText('Ollama sign-in was cancelled or did not complete.');
  expect(screen.queryByText('Ollama account connected.')).toBeNull();
  expect(refreshUsage).not.toHaveBeenCalled();
});

it('reports success only after a connected dashboard snapshot returns', async () => {
  const invoke = vi.fn().mockResolvedValue({
    source: 'ollama-dashboard', authStatus: 'connected', limitsAvailable: true,
    plan: 'Pro', creditBalanceUSD: 0, lastUpdated: Date.now(),
  });
  (window as any).electronAPI = { invoke };
  const store = createStore(); store.set(activeWorkspacePathAtom, '/fixture/A');
  render(<Provider store={store}><OllamaPanel /></Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in to Ollama' }));
  await screen.findByText('Ollama account connected.');
});

it('forgets dashboard sign-in only on click and keeps API-key auth wording clear', async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  (window as any).electronAPI = { invoke };
  const store = createStore(); store.set(activeWorkspacePathAtom, '/fixture/A');
  render(<Provider store={store}><OllamaPanel /></Provider>);
  expect(screen.getByText(/The API key is separate from dashboard sign-in/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Forget sign-in' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('ollama-usage:disconnect', '/fixture/A'));
  await waitFor(() => expect(screen.getByText('Ollama sign-in forgotten.')).toBeTruthy());
});

it('saves an entered API key through secure settings then refreshes usage', async () => {
  render(<OllamaPanel />);
  fireEvent.change(screen.getByLabelText('Ollama API key'), { target: { value: '  disposable-test-key  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
  await waitFor(() => expect(change).toHaveBeenCalledWith('ollama', 'disposable-test-key'));
  await waitFor(() => expect(refreshUsage).toHaveBeenCalledOnce());
});
