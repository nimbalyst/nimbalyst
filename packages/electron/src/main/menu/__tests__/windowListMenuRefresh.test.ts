// @vitest-environment node
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installWindowListMenuRefresh } from '../windowListMenuRefresh';

describe('installWindowListMenuRefresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const app = new EventEmitter();
    const rebuild = vi.fn();
    // The window manager owns the "app is quitting" answer. The test flips it by hand.
    const state = { quitting: false };
    installWindowListMenuRefresh(app as any, rebuild, () => state.quitting, 50);
    return { app, rebuild, state };
  }

  it('rebuilds the menu after a project window closes', () => {
    const { app, rebuild } = setup();
    const window = new EventEmitter();
    app.emit('browser-window-created', {}, window);
    vi.advanceTimersByTime(50);
    rebuild.mockClear();

    window.emit('closed');
    expect(rebuild).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of window events into one rebuild', () => {
    const { app, rebuild } = setup();
    app.emit('browser-window-created', {}, new EventEmitter());
    app.emit('browser-window-created', {}, new EventEmitter());
    app.emit('browser-window-focus');
    vi.advanceTimersByTime(50);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('stops rebuilding once the app is quitting', () => {
    const { app, rebuild, state } = setup();
    const window = new EventEmitter();
    app.emit('browser-window-created', {}, window);
    state.quitting = true;
    app.emit('before-quit');
    window.emit('closed');
    vi.advanceTimersByTime(50);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('rebuilds again after the user cancels a quit', () => {
    const { app, rebuild, state } = setup();
    state.quitting = true;
    app.emit('before-quit');
    app.emit('browser-window-focus');
    vi.advanceTimersByTime(50);
    expect(rebuild).not.toHaveBeenCalled();

    // The user chose Stay, so the window manager says the app is not quitting any more.
    state.quitting = false;
    app.emit('browser-window-focus');
    vi.advanceTimersByTime(50);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });
});
