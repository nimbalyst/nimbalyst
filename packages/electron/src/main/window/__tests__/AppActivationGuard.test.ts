import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class TestEmitter {
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        this.removeListener(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    removeListener(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    removeAllListeners() {
      this.listeners.clear();
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  return {
    app: new TestEmitter(),
  };
});

vi.mock('electron', () => ({
  app: mocks.app,
}));

import { runWhenAppIsActive } from '../AppActivationGuard';

class TestWindow {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  isDestroyed = vi.fn(() => false);

  once(event: string, listener: (...args: unknown[]) => void) {
    const wrapped = (...args: unknown[]) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(wrapped);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

describe('runWhenAppIsActive', () => {
  beforeEach(() => {
    mocks.app.emit('did-resign-active');
  });

  it('defers startup window visibility while another application is active', () => {
    const window = new TestWindow();
    const action = vi.fn();

    runWhenAppIsActive(window, action, 'darwin');

    expect(action).not.toHaveBeenCalled();
    mocks.app.emit('did-become-active');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('runs immediately when Nimbalyst is already active', () => {
    mocks.app.emit('did-become-active');
    const action = vi.fn();

    runWhenAppIsActive(new TestWindow(), action, 'darwin');

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('runs immediately on platforms without macOS activation guarding', () => {
    const action = vi.fn();

    runWhenAppIsActive(new TestWindow(), action, 'linux');

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('cancels a deferred action when its window closes', () => {
    const window = new TestWindow();
    const action = vi.fn();

    runWhenAppIsActive(window, action, 'darwin');
    window.emit('closed');
    mocks.app.emit('did-become-active');

    expect(action).not.toHaveBeenCalled();
  });
});
