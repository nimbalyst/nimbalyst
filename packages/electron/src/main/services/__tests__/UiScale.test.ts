// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  subscribers: [] as Array<(key: string, value: unknown) => void>,
  state: { scale: 100 },
  refreshBounds: vi.fn(),
  windows: new Map<number, unknown>(),
}));

vi.mock('../SettingsService', () => ({
  getSettingsService: () => ({
    get: () => h.state.scale,
    subscribe: (fn: (key: string, value: unknown) => void) => {
      h.subscribers.push(fn);
      return () => {};
    },
  }),
}));
vi.mock('../BrowserSessionService', () => ({
  BrowserSessionService: { getInstance: () => ({ refreshBoundsForWindow: h.refreshBounds }) },
}));
vi.mock('../../window/windowState', () => ({ windows: h.windows }));

import { applyUiScale, getUiScaleFactor, registerUiScale } from '../UiScale';

function fakeWindow(destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { setZoomFactor: vi.fn() } };
}

describe('UiScale', () => {
  beforeEach(() => {
    h.subscribers.length = 0;
    h.windows.clear();
    h.refreshBounds.mockClear();
    h.state.scale = 100;
  });

  it('turns the percent setting into a zoom factor', () => {
    h.state.scale = 125;
    expect(getUiScaleFactor()).toBe(1.25);
  });

  it('zooms a window and re-positions its browser views', () => {
    h.state.scale = 150;
    const window = fakeWindow();
    applyUiScale(window as never);
    expect(window.webContents.setZoomFactor).toHaveBeenCalledWith(1.5);
    expect(h.refreshBounds).toHaveBeenCalledWith(window);
  });

  it('skips destroyed windows', () => {
    const window = fakeWindow(true);
    applyUiScale(window as never);
    expect(window.webContents.setZoomFactor).not.toHaveBeenCalled();
  });

  it('rescales every window when the scale setting changes, and ignores other keys', () => {
    const first = fakeWindow();
    const second = fakeWindow();
    h.windows.set(1, first);
    h.windows.set(2, second);
    registerUiScale();

    h.state.scale = 200;
    h.subscribers[0]('ai.defaultProvider', 'x');
    expect(first.webContents.setZoomFactor).not.toHaveBeenCalled();

    h.subscribers[0]('appearance.uiScale', 200);
    expect(first.webContents.setZoomFactor).toHaveBeenCalledWith(2);
    expect(second.webContents.setZoomFactor).toHaveBeenCalledWith(2);
  });
});
