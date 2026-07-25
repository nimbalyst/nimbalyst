/**
 * Generic IPC subscription bridge exposed as `window.electronAPI.on`.
 *
 * The returned unsubscribe closure is the ONLY supported way to stop listening.
 * There is deliberately no `off(channel, callback)` counterpart.
 *
 * Why: with `contextIsolation: true` Electron proxies a renderer function into
 * the preload world on every crossing, and the proxy identity is not stable. A
 * removal API that takes the callback back therefore cannot correlate it with
 * the handler that `on()` registered -- the lookup always misses and the
 * listener stays attached forever. That is what leaked ~100
 * `session-files:updated` listeners over 44 hours of uptime in
 * https://github.com/nimbalyst/nimbalyst/issues/943 (NIM-2019).
 *
 * The unsubscribe closure has no such problem: it captures the real handler
 * directly, so nothing has to cross the bridge to remove it.
 */

interface IpcRendererLike {
  on(channel: string, handler: (...args: any[]) => void): unknown;
  removeListener(channel: string, handler: (...args: any[]) => void): unknown;
  getMaxListeners(): number;
  setMaxListeners(n: number): unknown;
}

/** Channels that legitimately fan out to many concurrent watchers. */
const HIGH_FANOUT_CHANNEL_PREFIX = 'document-service:';
const HIGH_FANOUT_MAX_LISTENERS = 50;

export function createIpcSubscriber(ipcRenderer: IpcRendererLike) {
  return function on(channel: string, callback: (...args: any[]) => void): () => void {
    const handler = (_event: any, ...args: any[]) => callback(...args);

    if (channel.startsWith(HIGH_FANOUT_CHANNEL_PREFIX)) {
      const currentMax = ipcRenderer.getMaxListeners();
      if (currentMax !== 0 && currentMax < HIGH_FANOUT_MAX_LISTENERS) {
        ipcRenderer.setMaxListeners(HIGH_FANOUT_MAX_LISTENERS);
      }
    }

    ipcRenderer.on(channel, handler);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      ipcRenderer.removeListener(channel, handler);
    };
  };
}
