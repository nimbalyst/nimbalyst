/**
 * Central listener for the extension privileged-capability IPC channels.
 *
 * Subscribes ONCE at app startup to:
 *   - `ext-permission-prompt:raise`     (via api.onPromptRaised)
 *   - `ext-permission-prompt:resolved`  (via api.onPromptResolved)
 *   - `ext-permissions:state-changed`   (via api.onStateChanged)
 *
 * The prompt queue and host-state version live in
 * `atoms/extensionPermissions.ts`; components read those atoms instead of
 * subscribing to IPC themselves (see IPC_LISTENERS.md).
 *
 * Call `initExtensionPermissionListeners()` once on app mount and dispose
 * the returned function on unmount.
 */
import { store } from '@nimbalyst/runtime/store';
import {
  extensionPermissionHostStateVersionAtom,
  extensionPermissionPromptQueueAtom,
} from '../atoms/extensionPermissions';

export function initExtensionPermissionListeners(): () => void {
  const api = window.electronAPI?.extensions?.permissions;
  if (!api) {
    // The preload exposes this only after a full Electron restart.
    // No-op until then; the components themselves render a "restart to enable"
    // hint when the API is missing.
    return () => {};
  }

  // Backfill prompts that were raised before this window mounted.
  void api
    .listPendingPrompts()
    .then((rows) => {
      if (!rows || rows.length === 0) return;
      store.set(extensionPermissionPromptQueueAtom, (q) => {
        const seen = new Set(q.map((r) => r.id));
        const additions = rows.filter((r) => !seen.has(r.id));
        return additions.length ? [...q, ...additions] : q;
      });
    })
    .catch(() => {});

  const offRaised = api.onPromptRaised((req) => {
    store.set(extensionPermissionPromptQueueAtom, (q) =>
      q.some((r) => r.id === req.id) ? q : [...q, req]
    );
  });
  const offResolved = api.onPromptResolved(({ promptId }) => {
    store.set(extensionPermissionPromptQueueAtom, (q) =>
      q.filter((r) => r.id !== promptId)
    );
  });
  const offState = api.onStateChanged(() => {
    store.set(extensionPermissionHostStateVersionAtom, (v) => v + 1);
  });

  return () => {
    offRaised?.();
    offResolved?.();
    offState?.();
  };
}
