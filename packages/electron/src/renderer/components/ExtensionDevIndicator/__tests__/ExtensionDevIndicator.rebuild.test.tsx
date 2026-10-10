// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advancedSettingsAtom } from '../../../store/atoms/appSettings';
import { ExtensionDevIndicator } from '../ExtensionDevIndicator';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('../../../help', () => ({
  HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../ExtensionErrorConsole', () => ({
  ExtensionErrorConsole: () => null,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExtensionDevIndicator rebuild feedback', () => {
  it.each(['returned failure', 'rejected request'])('reinstalls only stale extensions and retains %s for retry', async (failureMode) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const installed = ['Alpha', 'Beta', 'Current', 'Gamma'].map(name => ({
      id: name.toLowerCase(),
      name,
      path: `/workspace/packages/extensions/${name.toLowerCase()}`,
      manifest: { name },
      enabled: true,
      staleBundleWarning: name === 'Current' ? undefined : 'Source is newer than the bundle',
    }));
    let finishFirst!: (result: { success: boolean }) => void;
    const devReload = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
    if (failureMode === 'returned failure') {
      devReload.mockResolvedValueOnce({ success: false, error: 'Build failed' });
    } else {
      devReload.mockRejectedValueOnce(new Error('Request failed'));
    }
    devReload.mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        extensionDevTools: {
          getLogs: vi.fn().mockResolvedValue({ logs: [] }),
          getProcessInfo: vi.fn().mockResolvedValue({ startTime: Date.now() }),
        },
        extensions: { listInstalled: vi.fn().mockResolvedValue(installed), devReload },
      },
    });
    const store = createStore();
    store.set(advancedSettingsAtom, { ...store.get(advancedSettingsAtom), extensionDevToolsEnabled: true });
    render(<Provider store={store}><ExtensionDevIndicator /></Provider>);
    fireEvent.click(screen.getByTestId('gutter-extension-dev-button'));
    const reinstall = await screen.findByRole('button', { name: 'Reinstall stale extensions' });
    const staleList = screen.getByRole('list', { name: 'Stale extensions' });
    within(staleList).getByText('Alpha');
    within(staleList).getByText('Beta');
    expect(within(staleList).queryByText('Current')).toBeNull();
    fireEvent.click(reinstall);
    expect((reinstall as HTMLButtonElement).disabled).toBe(true);
    expect(devReload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('menuitem', { name: /rebuilding/i }));
    expect((screen.getByRole('menuitem', { name: 'All Extensions' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reinstall Beta' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finishFirst({ success: true }));
    expect((await screen.findByRole('alert')).textContent).toContain('Beta');
    expect(devReload.mock.calls).toEqual([
      ['alpha', installed[0].path], ['beta', installed[1].path], ['gamma', installed[3].path],
    ]);
    expect(within(staleList).queryByText('Alpha')).toBeNull();
    within(staleList).getByText('Beta');
    fireEvent.click(screen.getByRole('button', { name: 'Reinstall Beta' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Stale extensions' })).toBeNull());
    expect(devReload.mock.calls).toEqual([
      ['alpha', installed[0].path], ['beta', installed[1].path], ['gamma', installed[3].path], ['beta', installed[1].path],
    ]);
  });

  it('surfaces stale bundles and reports build failures without claiming reload success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const devReload = vi.fn().mockResolvedValue({
      success: false,
      error: 'Extension build failed:\nTypeScript compilation failed',
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        extensionDevTools: {
          getLogs: vi.fn().mockResolvedValue({ logs: [] }),
          getProcessInfo: vi.fn().mockResolvedValue({ startTime: Date.now() }),
        },
        extensions: {
          listInstalled: vi.fn().mockResolvedValue([{
            id: 'com.nimbalyst.csv-spreadsheet',
            path: '/workspace/packages/extensions/csv-spreadsheet',
            manifest: { name: 'CSV Spreadsheet' },
            name: 'CSV Spreadsheet',
            enabled: true,
            staleBundleWarning: 'src/index.tsx is newer than the built bundle',
          }]),
          devReload,
        },
      },
    });

    const atomStore = createStore();
    atomStore.set(advancedSettingsAtom, {
      ...atomStore.get(advancedSettingsAtom),
      extensionDevToolsEnabled: true,
    });
    render(
      <Provider store={atomStore}>
        <ExtensionDevIndicator />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('gutter-extension-dev-button'));
    await screen.findByText(/1 stale extension bundle detected/i);
    fireEvent.click(screen.getByRole('menuitem', { name: /rebuild extensions/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /csv spreadsheet/i }));

    await waitFor(() => expect(devReload).toHaveBeenCalledWith(
      'com.nimbalyst.csv-spreadsheet',
      '/workspace/packages/extensions/csv-spreadsheet',
    ));
    expect((await screen.findByRole('alert')).textContent).toContain('TypeScript compilation failed');
  });
});
