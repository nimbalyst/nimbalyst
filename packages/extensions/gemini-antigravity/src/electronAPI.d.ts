/**
 * Window.electronAPI ambient shim for the renderer-side activate hook.
 *
 * The host injects the real implementation at runtime. We only need a
 * minimal surface here because the activate hook calls a small set of
 * methods (settings get/save, model cache clear, test connection).
 *
 * Must NOT use top-level `export {}` or any import/export -- that would
 * turn this into a module and the global Window augmentation would only
 * apply in files that import it, defeating the point.
 */

interface Window {
  electronAPI: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    send: (channel: string, ...args: unknown[]) => void;
    on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
  };
}
