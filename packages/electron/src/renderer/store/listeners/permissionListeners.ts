/**
 * Central Permission Listener
 *
 * Subscribes to `permissions:changed` IPC event ONCE and increments
 * `permissionsChangedVersionAtom`. Components that need to react re-query
 * their permission state when this counter changes (use it as a useEffect
 * dependency).
 *
 * Call initPermissionListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import { permissionsChangedVersionAtom } from '../atoms/permissions';

let initialized = false;

export function initPermissionListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const unsubscribe = window.electronAPI?.on?.('permissions:changed', () => {
    store.set(permissionsChangedVersionAtom, (v) => v + 1);
  });

  return () => {
    initialized = false;
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  };
}
