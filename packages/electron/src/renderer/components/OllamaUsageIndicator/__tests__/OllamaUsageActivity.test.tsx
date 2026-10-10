// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OllamaUsageData } from '../../../store/atoms/ollamaUsageAtoms';

const { snapshot, setUsageMock, activeWorkspace } = vi.hoisted(() => ({ snapshot: { value: null as OllamaUsageData | null }, setUsageMock: vi.fn(), activeWorkspace: { value: 'workspace' } }));
vi.mock('jotai', () => ({ useAtomValue: (value: string) => value === 'usage' ? snapshot.value : value === 'available' ? true : value === 'workspace' ? activeWorkspace.value : 'muted', useSetAtom: () => setUsageMock, useStore: () => ({ get: () => activeWorkspace.value }) }));
vi.mock('../../../store/atoms/ollamaUsageAtoms', () => ({ ollamaUsageAtom: 'usage', ollamaUsageAvailableAtom: 'available', ollamaUsageSessionColorAtom: 'session', ollamaUsageWeeklyColorAtom: 'weekly', formatResetTime: () => '' }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('../../../store/atoms/appSettings', () => ({ toggleGutterItemHiddenAtom: 'hidden' }));
vi.mock('../../../store/atoms/settingsNavigation', () => ({ openSettingsCommandAtom: 'settings' }));
vi.mock('../../../store/atoms/openProjects', () => ({ activeWorkspacePathAtom: 'workspace' }));
vi.mock('../../../store/listeners/ollamaUsageListeners', () => ({ refreshOllamaUsage: vi.fn(), loadOllamaResetTimes: vi.fn() }));
vi.mock('../../../hooks/useFloatingMenu', () => ({ useFloatingMenu: () => ({ refs: { setFloating: vi.fn(), setReference: vi.fn() }, floatingStyles: {}, getFloatingProps: () => ({}) }), FloatingPortal: ({ children }: { children: React.ReactNode }) => children }));
import { OllamaUsageIndicator } from '../OllamaUsageIndicator';
import { OllamaUsagePopover } from '../OllamaUsagePopover';

afterEach(() => { cleanup(); snapshot.value = null; });
beforeEach(() => { setUsageMock.mockClear(); activeWorkspace.value = 'workspace'; });
describe('Ollama current activity presentation', () => {
  it('shows the real zero wallet, provider resets, and every model row with weekly scope', () => {
    snapshot.value = {
      source: 'ollama-dashboard', authStatus: 'connected', limitsAvailable: true,
      creditBalanceUSD: 0, plan: 'Pro', modelCountsPeriod: 'this-week', lastUpdated: Date.now(),
      session: { utilization: 0.4, resetsAt: '2026-10-10T01:00:00Z', models: [] },
      weekly: { utilization: 41, resetsAt: '2026-10-12T00:00:00Z', modelCountsAvailable: true, models: [
        { name: 'kimi-k3', requestCount: 4 }, { name: 'glm-5.3', requestCount: 18 },
        { name: 'glm-5.3-flash', requestCount: 4 }, { name: 'deepseek-v4.1-flash', requestCount: 3656 },
        { name: 'deepseek-v4-pro:0813', requestCount: 54 }, { name: 'minimax-m3', requestCount: 5 },
      ] },
    };
    const popover = renderToStaticMarkup(<OllamaUsagePopover anchorRef={React.createRef<HTMLButtonElement>()} onClose={vi.fn()} onRefresh={vi.fn()} />);
    expect(popover).toContain('Extra credit balance: $0.00');
    expect(popover).toContain('Pro plan');
    expect(popover).toContain('Session usage');
    expect(popover).toContain('0.4%');
    expect(popover).toContain('Resets at 2026-10-10T01:00:00Z');
    expect(popover).toContain('Resets at 2026-10-12T00:00:00Z');
    expect(popover).not.toContain('w-0.5');
    expect(popover).toContain('Models used this week');
    const indicator = renderToStaticMarkup(<OllamaUsageIndicator />);
    expect(indicator).toContain('Ollama weekly usage: 41%');
    for (const name of ['kimi-k3', 'glm-5.3', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'deepseek-v4-pro:0813', 'minimax-m3']) expect(popover).toContain(name);
  });

  it('shows model counts as unavailable when dashboard scope or rows are absent', () => {
    snapshot.value = {
      source: 'ollama-dashboard', authStatus: 'connected', limitsAvailable: true,
      modelCountsPeriod: 'this-week',
      weekly: { utilization: 2, resetsAt: '2026-10-12T00:00:00Z', models: [] },
      lastUpdated: Date.now(),
    };
    const popover = renderToStaticMarkup(<OllamaUsagePopover anchorRef={React.createRef<HTMLButtonElement>()} onClose={vi.fn()} onRefresh={vi.fn()} />);
    expect(popover).toContain('Model call counts');
    expect(popover).toContain('Model call counts unavailable.');
    expect(popover).not.toContain('No model call rows were supplied');
  });

  it('keeps the connect action visible when dashboard auth has expired', () => {
    snapshot.value = { source: 'ollama-dashboard', authStatus: 'sign-in-required', limitsAvailable: false, error: 'Sign in to view Ollama usage.', lastUpdated: Date.now() };
    const popover = renderToStaticMarkup(<OllamaUsagePopover anchorRef={React.createRef<HTMLButtonElement>()} onClose={vi.fn()} onRefresh={vi.fn()} />);
    expect(popover).toContain('Sign in to view Ollama usage.');
    expect(popover).toContain('Connect Ollama account');
  });

  it('uses the connect receipt and updates usage only while the same workspace is active', async () => {
    snapshot.value = { source: 'ollama-dashboard', authStatus: 'sign-in-required', limitsAvailable: false, error: 'Sign in to view Ollama usage.', lastUpdated: Date.now() };
    const receipt = { source: 'ollama-dashboard', authStatus: 'sign-in-required', limitsAvailable: false, error: 'Sign in to view Ollama usage.', lastUpdated: Date.now() };
    (window as any).electronAPI = { invoke: vi.fn().mockResolvedValue(receipt) };
    render(<OllamaUsagePopover anchorRef={React.createRef<HTMLButtonElement>()} onClose={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Ollama account' }));
    await screen.findByText('Ollama sign-in was cancelled or did not complete.');
    expect(setUsageMock).toHaveBeenCalledWith(receipt);
    expect(screen.queryByText('Ollama account connected.')).toBeNull();
  });

  it('does not write a sign-in result into a workspace that became inactive', async () => {
    snapshot.value = { source: 'ollama-dashboard', authStatus: 'sign-in-required', limitsAvailable: false, error: 'Sign in to view Ollama usage.', lastUpdated: Date.now() };
    const receipt = { source: 'ollama-dashboard', authStatus: 'connected', limitsAvailable: true, plan: 'Pro', lastUpdated: Date.now() };
    (window as any).electronAPI = { invoke: vi.fn().mockImplementation(async () => { activeWorkspace.value = 'other-workspace'; return receipt; }) };
    render(<OllamaUsagePopover anchorRef={React.createRef<HTMLButtonElement>()} onClose={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Ollama account' }));
    await screen.findByText('Ollama account connected.');
    expect(setUsageMock).not.toHaveBeenCalled();
  });

  it.each([0, 4434])('keeps %s real requests visible when billing limits are unavailable', (requestCount) => {
    snapshot.value = { limitsAvailable: false, requestUsage: { requestCount, from: '2026-10-02T00:00:00Z', until: '2026-10-09T19:27:02Z' }, limitsUnavailableReason: 'Credit balance and allowance limits are not supplied by the Ollama usage API.', lastUpdated: Date.now() };
    const indicator = renderToStaticMarkup(<OllamaUsageIndicator />);
    const popover = renderToStaticMarkup(<OllamaUsagePopover anchorRef={React.createRef<HTMLButtonElement>()} onClose={vi.fn()} onRefresh={vi.fn()} />);
    expect(indicator).toContain(`${requestCount.toLocaleString()} requests`);
    expect(indicator).not.toContain('usage unavailable:');
    expect(indicator).not.toContain('%');
    expect(indicator).toContain('19:27:02');
    expect(indicator).toContain('UTC');
    expect(popover).toContain(requestCount.toLocaleString());
    expect(popover).toContain('Credit balance and allowance');
    expect(popover).toContain('19:27:02');
    expect(popover).toContain('UTC');
    expect(popover).not.toContain('Legacy weekly');
    expect(popover).not.toContain('text-nim-error');
  });

  it('does not present a fabricated zero count when a read fails', () => {
    snapshot.value = { limitsAvailable: false, error: 'Ollama usage API returned HTTP 401', lastUpdated: Date.now() };
    const indicator = renderToStaticMarkup(<OllamaUsageIndicator />);
    const popover = renderToStaticMarkup(<OllamaUsagePopover anchorRef={React.createRef<HTMLButtonElement>()} onClose={vi.fn()} onRefresh={vi.fn()} />);
    expect(indicator).toContain('usage unavailable:');
    expect(popover).toContain('HTTP 401');
    expect(popover).not.toContain('Request activity');
  });
});
