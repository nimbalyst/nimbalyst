// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { sessionLaunchPopupRequestAtom } from '../../atoms/appCommands';
import { initAppCommandListeners } from '../appCommandListeners';

describe('session launch popup app command', () => {
  let cleanup: (() => void) | undefined;
  let handlers: Record<string, (...args: unknown[]) => void>;

  beforeEach(() => {
    handlers = {};
    store.set(sessionLaunchPopupRequestAtom, 0);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handler;
          return () => delete handlers[event];
        }),
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('increments the command atom when main opens the popup', () => {
    cleanup = initAppCommandListeners();
    handlers['session-launch-popup-open']();
    expect(store.get(sessionLaunchPopupRequestAtom)).toBe(1);
  });
});
