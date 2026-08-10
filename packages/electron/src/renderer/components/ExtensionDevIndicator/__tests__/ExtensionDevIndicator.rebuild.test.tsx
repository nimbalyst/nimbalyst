// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
