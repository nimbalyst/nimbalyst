import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APP_ACTION_DISPATCH_CHANNEL,
  dispatchAppActionHref,
  isAppActionHref,
} from '../appActionLinks';

const originalElectronAPI = (
  window as unknown as { electronAPI?: unknown }
).electronAPI;

afterEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: originalElectronAPI,
  });
});

describe('renderer app action links', () => {
  it('dispatches action hrefs through the narrow IPC channel', () => {
    const send = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { send },
    });

    expect(
      dispatchAppActionHref('nimbalyst://action/open-project-manager'),
    ).toBe(true);
    expect(send).toHaveBeenCalledWith(
      APP_ACTION_DISPATCH_CHANNEL,
      'nimbalyst://action/open-project-manager',
    );
  });

  it('claims unknown action paths so they cannot fall through to external navigation', () => {
    const send = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { send },
    });

    expect(dispatchAppActionHref('nimbalyst://action/not-allowed')).toBe(true);
    expect(send).toHaveBeenCalledWith(
      APP_ACTION_DISPATCH_CHANNEL,
      'nimbalyst://action/not-allowed',
    );
    expect(isAppActionHref('nimbalyst://NIM-123')).toBe(false);
    expect(isAppActionHref('https://example.com')).toBe(false);
  });
});
