/**
 * Database Migration Listeners (Renderer)
 *
 * Bridges the `db:migration:*` IPC events to the atoms in
 * store/atoms/dbMigration.ts, and owns the startup pull of the recovery
 * picture (`refreshDbRecoveryState`).
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
  dbMigratedCopiesAtom,
  dbMigrationBlockedAtom,
  dbMigrationFailureAtom,
  dbMigrationPhaseAtom,
  dbMigrationProgressAtom,
  dbMigrationRunningAtom,
  dbMigrationSummaryAtom,
  dbRecoveryCandidatesAtom,
  dbRecoveryLiveAtom,
  dbRecoveryOfferAtom,
  type LiveDatabaseView,
  type MigratedCopyView,
  type MigrationBlockedState,
  type MigrationFailure,
  type MigrationPhaseEvent,
  type MigrationProgressEvent,
  type MigrationSummary,
  type RecoveryCandidateView,
} from '../atoms/dbMigration';

/**
 * Pull the recovery picture into atoms.
 *
 * Request/response rather than events: discovery walks the userData root and
 * opens candidate databases off-thread, so it is something to ask for at
 * known moments (startup, opening Settings, finishing a recovery) rather than
 * something main pushes. Components still only ever read the atoms.
 *
 * Never throws. A failed scan leaves the previous values in place; the panel
 * showing nothing is a better outcome than the settings dialog failing to
 * mount, and a launch must not depend on this.
 */
export async function refreshDbRecoveryState(): Promise<void> {
  if (!window.electronAPI) return;

  try {
    const resp = (await window.electronAPI.invoke('db:recovery:list-candidates')) as
      | { success: true; live: LiveDatabaseView; candidates: RecoveryCandidateView[] }
      | { success: false; error: string };
    if (resp.success) {
      store.set(dbRecoveryCandidatesAtom, resp.candidates);
      store.set(dbRecoveryLiveAtom, resp.live);
      // Derived here rather than re-invoked: the proactive offer is exactly
      // "the single candidate assessment cleared for it", and computing it
      // from the same list keeps the banner and the row from disagreeing.
      const offerable = resp.candidates.filter((c) => c.mayOfferProactively);
      store.set(dbRecoveryOfferAtom, offerable.length === 1 ? offerable[0] : null);
    }
  } catch {
    // Leave the previous values alone.
  }

  try {
    const resp = (await window.electronAPI.invoke('db:recovery:list-migrated')) as
      | { success: true; copies: MigratedCopyView[] }
      | { success: false; error: string };
    if (resp.success) store.set(dbMigratedCopiesAtom, resp.copies);
  } catch {
    // Leave the previous values alone.
  }

  try {
    const resp = (await window.electronAPI.invoke('db:migration:get-status')) as
      | { success: true; migrationBlocked?: MigrationBlockedState | null }
      | { success: false; error: string };
    if (resp.success) store.set(dbMigrationBlockedAtom, resp.migrationBlocked ?? null);
  } catch {
    // Leave the previous values alone.
  }
}

export function initDbMigrationListeners(): () => void {
  if (!window.electronAPI) return () => {};

  // Recovery state is pulled once at startup so the offer exists before the
  // user ever opens Settings.
  void refreshDbRecoveryState();

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
