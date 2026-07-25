// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportResolvedTitleBarColors } from '../windowChrome';

afterEach(() => {
  document.documentElement.style.removeProperty('--nim-bg-secondary');
  document.documentElement.style.removeProperty('--nim-text');
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('reportResolvedTitleBarColors', () => {
  it('reports the computed title-bar background and matching symbol color', () => {
    const setTitleBarOverlayColors = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { setTitleBarOverlayColors },
    });
    document.documentElement.style.setProperty('--nim-bg-secondary', '#1e293b');
    document.documentElement.style.setProperty('--nim-text', 'rgb(248, 250, 252)');

    reportResolvedTitleBarColors();

    expect(setTitleBarOverlayColors).toHaveBeenCalledWith({
      color: '#1e293b',
      symbolColor: 'rgb(248, 250, 252)',
    });
  });

  it('does not send an incomplete computed theme', () => {
    const setTitleBarOverlayColors = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { setTitleBarOverlayColors },
    });
    document.documentElement.style.setProperty('--nim-bg-secondary', '#fff');

    reportResolvedTitleBarColors();

    expect(setTitleBarOverlayColors).not.toHaveBeenCalled();
  });
});
