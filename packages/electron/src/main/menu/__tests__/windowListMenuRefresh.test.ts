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
    installWindowListMenuRefresh(app as any, rebuild, 50);
    return { app, rebuild };
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
    const { app, rebuild } = setup();
    const window = new EventEmitter();
    app.emit('browser-window-created', {}, window);
    app.emit('before-quit');
    window.emit('closed');
    vi.advanceTimersByTime(50);
    expect(rebuild).not.toHaveBeenCalled();
  });
});
