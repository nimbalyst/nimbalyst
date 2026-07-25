/**
 * Regression tests for the IPC subscription bridge (NIM-2019 / issue #943).
 *
 * The renderer crashed after ~44h of uptime, preceded by
 * `MaxListenersExceededWarning: 101 session-files:updated listeners added`.
 * The cause was `window.electronAPI.off(channel, callback)`: it looked the
 * handler up in a WeakMap keyed by the callback, but `contextIsolation: true`
 * hands the preload a *fresh proxy* of the renderer's function on every
 * crossing, so the lookup never matched and the listener was never removed.
 *
 * `crossContextBridge` below reproduces that proxying so the failure is
 * exercised in-process rather than only observable on a live app.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createIpcSubscriber } from '../ipcSubscriptions';

/**
 * Stand-in for Electron's contextBridge function proxying: every value that
 * crosses from the renderer world into the preload world arrives as a NEW
 * wrapper object, never the caller's original function.
 */
function crossContextBridge<T extends (...args: any[]) => any>(fn: T): T {
  return ((...args: any[]) => fn(...args)) as T;
}

function makeIpcRenderer() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  return emitter;
}

describe('createIpcSubscriber', () => {
  it('removes the listener via the returned unsubscribe, even though the callback re-proxies on every crossing', () => {
    const ipcRenderer = makeIpcRenderer();
    const on = createIpcSubscriber(ipcRenderer as any);

    const rendererCallback = () => {};

    for (let i = 0; i < 200; i++) {
      // Each subscribe/unsubscribe cycle crosses the bridge separately, so the
      // preload sees a different proxy each time -- exactly the condition that
      // defeated identity-based removal.
      const unsubscribe = on('session-files:updated', crossContextBridge(rendererCallback));
      unsubscribe();
    }

    expect(ipcRenderer.listenerCount('session-files:updated')).toBe(0);
  });

  it('an identity-keyed removal API cannot work across the bridge (why off() was removed)', () => {
    const ipcRenderer = makeIpcRenderer();
    const registered = new WeakMap<object, { channel: string; handler: (...a: any[]) => void }>();

    // The old preload implementation, verbatim in behaviour.
    const on = (channel: string, callback: (...args: any[]) => void) => {
      const handler = (_e: any, ...args: any[]) => callback(...args);
      ipcRenderer.on(channel, handler);
      registered.set(callback, { channel, handler });
    };
    const off = (channel: string, callback: (...args: any[]) => void) => {
      const info = registered.get(callback);
      if (info && info.channel === channel) {
        ipcRenderer.removeListener(channel, info.handler);
      } else {
        ipcRenderer.removeListener(channel, callback);
      }
    };

    const rendererCallback = () => {};
    for (let i = 0; i < 200; i++) {
      on('session-files:updated', crossContextBridge(rendererCallback));
      off('session-files:updated', crossContextBridge(rendererCallback));
    }

    // Every single listener leaked. This is the bug from #943.
    expect(ipcRenderer.listenerCount('session-files:updated')).toBe(200);
  });

  it('unsubscribing twice does not remove an unrelated listener', () => {
    const ipcRenderer = makeIpcRenderer();
    const on = createIpcSubscriber(ipcRenderer as any);

    const first = on('git:status-changed', () => {});
    on('git:status-changed', () => {});

    first();
    first();

    expect(ipcRenderer.listenerCount('git:status-changed')).toBe(1);
  });

  it('raises the listener ceiling for high-fan-out document-service channels', () => {
    const ipcRenderer = makeIpcRenderer();
    ipcRenderer.setMaxListeners(10);
    const on = createIpcSubscriber(ipcRenderer as any);

    on('document-service:metadata-changed', () => {});

    expect(ipcRenderer.getMaxListeners()).toBe(50);
  });
});
