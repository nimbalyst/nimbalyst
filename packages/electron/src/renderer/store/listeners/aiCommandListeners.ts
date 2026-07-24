/**
 * Central AI Command Listeners
 *
 * IPC -> DOM-event bridges for AI events that downstream components listen
 * for via `window.addEventListener`. Subscribing once here keeps the
 * `electronAPI.on(` call out of components.
 *
 * Events:
 * - ai:promptClaimed -> dispatched as window CustomEvent('ai:promptClaimed')
 *
 * Call initAiCommandListeners() once at app startup.
 */

let initialized = false;

export function initAiCommandListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const unsubscribe = window.electronAPI?.on?.(
    'ai:promptClaimed',
    (data: { sessionId: string; promptId: string }) => {
      window.dispatchEvent(new CustomEvent('ai:promptClaimed', { detail: data }));
    },
  );

  return () => {
    initialized = false;
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  };
}
