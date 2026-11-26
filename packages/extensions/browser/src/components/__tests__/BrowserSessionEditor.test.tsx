import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';
import { BrowserSessionEditor } from '../BrowserSessionEditor';
import { createBrowserSession, destroyBrowserSession } from '../../browserClient';

vi.mock('@nimbalyst/extension-sdk', () => ({
  useEditorLifecycle: () => ({ markDirty: vi.fn() }),
}));

vi.mock('../BrowserSurface', () => ({
  BrowserSurface: () => null,
}));

vi.mock('../BrowserToolbar', () => ({
  BrowserToolbar: () => null,
}));

vi.mock('../../browserClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../browserClient')>();
  return {
    ...actual,
    createBrowserSession: vi.fn().mockResolvedValue({
      sessionId: 'browser-virtual:tab',
      url: 'https://example.com',
      title: 'Example',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
    }),
    destroyBrowserSession: vi.fn().mockResolvedValue(undefined),
    subscribeToStateChanges: vi.fn(() => () => {}),
    subscribeToExternalNav: vi.fn(() => () => {}),
  };
});

function makeHost(filePath: string): EditorHostProps['host'] {
  return {
    filePath,
    theme: 'light',
    registerEditorAPI: vi.fn(),
    storage: {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    },
  } as unknown as EditorHostProps['host'];
}

describe('BrowserSessionEditor unmount cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('preserves agent-opened virtual tabs across unmount (session switches)', async () => {
    const view = render(
      <BrowserSessionEditor
        host={makeHost('virtual://com.nimbalyst.browser/agent-1?url=https%3A%2F%2Fexample.com&agent=1')}
      />,
    );
    await waitFor(() => expect(createBrowserSession).toHaveBeenCalledWith('browser-virtual:agent-1', 'https://example.com'));
    view.unmount();
    expect(destroyBrowserSession).not.toHaveBeenCalled();
  });

  it('destroys user-opened virtual tabs on unmount', async () => {
    const view = render(
      <BrowserSessionEditor
        host={makeHost('virtual://com.nimbalyst.browser/user-1?url=https%3A%2F%2Fexample.com')}
      />,
    );
    await waitFor(() => expect(createBrowserSession).toHaveBeenCalledWith('browser-virtual:user-1', 'https://example.com'));
    view.unmount();
    expect(destroyBrowserSession).toHaveBeenCalledWith('browser-virtual:user-1');
  });
});
