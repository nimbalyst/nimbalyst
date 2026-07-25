/**
 * Database Migration Listeners (Renderer)
 *
 * Bridges the `db:migration:*` IPC events to the atoms in
 * store/atoms/dbMigration.ts.
 *
 * Follows IPC_LISTENERS.md: one centralized subscription at startup.
 * Call initDbMigrationListeners() once in App.tsx on mount.
 *
 * DatabasePanel used to subscribe to these four channels itself. Besides
 * breaking the centralized-listener rule, that meant progress was only tracked
 * while the settings dialog happened to be open -- close it mid-migration and
 * the panel came back with no phase, no progress, and no completion summary.
 */

import { store } from '@nimbalyst/runtime/store';
import {
  dbMigrationFailureAtom,
  dbMigrationPhaseAtom,
  dbMigrationProgressAtom,
  dbMigrationRunningAtom,
  dbMigrationSummaryAtom,
  type MigrationFailure,
  type MigrationPhaseEvent,
  type MigrationProgressEvent,
  type MigrationSummary,
} from '../atoms/dbMigration';

export function initDbMigrationListeners(): () => void {
  if (!window.electronAPI) return () => {};

  // preload's electronAPI.on strips the IPC event, so callbacks receive
  // (payload) directly -- not (event, payload).
  const unsubscribes = [
    window.electronAPI.on('db:migration:phase', (payload: MigrationPhaseEvent) => {
      store.set(dbMigrationPhaseAtom, payload);
    }),
    window.electronAPI.on('db:migration:progress', (payload: MigrationProgressEvent) => {
      store.set(dbMigrationProgressAtom, payload);
    }),
    window.electronAPI.on('db:migration:complete', (payload: MigrationSummary) => {
      store.set(dbMigrationRunningAtom, false);
      store.set(dbMigrationFailureAtom, null);
      store.set(dbMigrationSummaryAtom, payload);
    }),
    window.electronAPI.on('db:migration:failed', (payload: MigrationFailure) => {
      store.set(dbMigrationRunningAtom, false);
      store.set(dbMigrationFailureAtom, payload);
    }),
  ];

  return () => {
    unsubscribes.forEach(unsubscribe => unsubscribe());
  };
}
