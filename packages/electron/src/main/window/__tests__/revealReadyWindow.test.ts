import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real runWhenAppIsActive drives the ordering under test, so mock only the
// electron `app` emitter it depends on (same approach as AppActivationGuard.test).
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

    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  return { app: new TestEmitter() };
});

vi.mock('electron', () => ({ app: mocks.app }));

import { revealReadyWindow } from '../revealReadyWindow';

class TestWindow {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly calls: string[] = [];

  isDestroyed = vi.fn(() => false);
  show = vi.fn(() => this.calls.push('show'));
  showInactive = vi.fn(() => this.calls.push('showInactive'));
  maximize = vi.fn(() => this.calls.push('maximize'));

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

describe('revealReadyWindow', () => {
  beforeEach(() => {
    // Start from an inactive app so the darwin guard actually defers.
    mocks.app.emit('did-resign-active');
  });

  // Greg's review (PR #1079): maximize() shows a hidden window and, before the
  // fix, ran ahead of the deferShowUntilAppActive guard — revealing (and on
  // macOS reactivating) the window before the app-active gate allowed it.
  it('does not maximize a restored window before the app-active guard fires', () => {
    const window = new TestWindow();

    revealReadyWindow(
      window,
      { showInactive: true, deferShowUntilAppActive: true },
      { isMaximized: true },
      'darwin',
    );

    // Guard has not released yet: neither show nor maximize may run, otherwise
    // maximize would have revealed the hidden window and stolen focus.
    expect(window.maximize).not.toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
  });

  it('maximizes only inside the guarded show action, after the show call', () => {
    const window = new TestWindow();

    revealReadyWindow(
      window,
      { showInactive: true, deferShowUntilAppActive: true },
      { isMaximized: true },
      'darwin',
    );
    mocks.app.emit('did-become-active');

    // Ordering matters: show reveals via the guarded (inactive) path first,
    // then maximize resizes an already-visible window instead of revealing it.
    expect(window.calls).toEqual(['showInactive', 'maximize']);
    expect(window.show).not.toHaveBeenCalled();
  });

  it('never maximizes when saved bounds were not maximized', () => {
    const window = new TestWindow();

    revealReadyWindow(
      window,
      { showInactive: true, deferShowUntilAppActive: true },
      { isMaximized: false },
      'darwin',
    );
    mocks.app.emit('did-become-active');

    expect(window.calls).toEqual(['showInactive']);
    expect(window.maximize).not.toHaveBeenCalled();
  });

  it('shows and maximizes immediately when no defer guard is requested', () => {
    const window = new TestWindow();

    revealReadyWindow(window, undefined, { isMaximized: true });

    expect(window.calls).toEqual(['show', 'maximize']);
  });
});
