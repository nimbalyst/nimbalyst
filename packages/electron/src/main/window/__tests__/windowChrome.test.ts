import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIN_WINDOW_TITLE_BAR_HEIGHT } from '../../../shared/windowChrome';
import {
  customTitleBarOptions,
  getTitleBarOverlayColors,
  registerCustomTitleBarWindow,
  resetTitleBarOverlayColors,
  resetWindowChromeStateForTests,
  setResolvedTitleBarOverlayColors,
  titleBarOptionsForWindow,
} from '../windowChrome';

const FALLBACK = { color: '#1a1a1a', symbolColor: '#ffffff' };

afterEach(() => {
  resetWindowChromeStateForTests();
});

describe('customTitleBarOptions', () => {
  it('uses hiddenInset and native traffic lights on macOS', () => {
    expect(customTitleBarOptions({
      platform: 'darwin',
      overlayColors: FALLBACK,
    })).toEqual({
      titleBarStyle: 'hiddenInset',
      titleBarOverlay: true,
      trafficLightPosition: { x: 10, y: 12 },
    });
  });

  it.each(['win32', 'linux'] as const)(
    'uses a native control overlay and auto-hidden menu row on %s',
    (platform) => {
      expect(customTitleBarOptions({
        platform,
        overlayColors: FALLBACK,
      })).toEqual({
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          ...FALLBACK,
          height: MAIN_WINDOW_TITLE_BAR_HEIGHT,
        },
        autoHideMenuBar: true,
      });
    },
  );

  it('returns no custom chrome for a window that did not opt in', () => {
    expect(titleBarOptionsForWindow({
      customTitleBar: false,
      platform: 'linux',
      overlayColors: FALLBACK,
    })).toEqual({});
  });
});

describe('resolved title-bar overlay colors', () => {
  it('uses first-paint fallback colors before the renderer reports a theme', () => {
    expect(getTitleBarOverlayColors(FALLBACK)).toEqual(FALLBACK);
  });

  it.each([
    null,
    {},
    { color: '', symbolColor: '#fff' },
    { color: '#fff; color: red', symbolColor: '#fff' },
    { color: 'url(https://example.test/x)', symbolColor: '#fff' },
    { color: '#fff', symbolColor: 'x'.repeat(65) },
  ])('rejects malformed or oversized payloads: %j', (payload) => {
    expect(setResolvedTitleBarOverlayColors(payload)).toBe(false);
    expect(getTitleBarOverlayColors(FALLBACK)).toEqual(FALLBACK);
  });

  it('caches accepted colors and targets only registered overlay windows', () => {
    const overlayWindow = {
      id: 7,
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      setTitleBarOverlay: vi.fn(),
    };
    const unrelatedWindow = {
      id: 8,
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      setTitleBarOverlay: vi.fn(),
    };

    registerCustomTitleBarWindow(overlayWindow, 'linux');
    const resolved = { color: 'rgb(12, 34, 56)', symbolColor: '#f8fafc' };

    expect(setResolvedTitleBarOverlayColors(resolved)).toBe(true);
    expect(getTitleBarOverlayColors(FALLBACK)).toEqual(resolved);
    expect(overlayWindow.setTitleBarOverlay).toHaveBeenCalledWith({
      ...resolved,
      height: MAIN_WINDOW_TITLE_BAR_HEIGHT,
    });
    expect(unrelatedWindow.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it('resets registered windows to theme fallbacks until the renderer reports again', () => {
    const overlayWindow = {
      id: 9,
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      setTitleBarOverlay: vi.fn(),
    };
    registerCustomTitleBarWindow(overlayWindow, 'darwin');
    setResolvedTitleBarOverlayColors({ color: '#334155', symbolColor: '#f8fafc' });

    resetTitleBarOverlayColors(FALLBACK);

    expect(getTitleBarOverlayColors(FALLBACK)).toEqual(FALLBACK);
    expect(overlayWindow.setTitleBarOverlay).toHaveBeenLastCalledWith(FALLBACK);
  });
});
