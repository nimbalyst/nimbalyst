/**
 * State for the PGLite -> better-sqlite3 migration flow.
 *
 * Updated by: store/listeners/dbMigrationListeners.ts (from the
 * `db:migration:*` IPC events) and by DatabasePanel when the user starts or
 * resets a run.
 *
 * These live in an atom rather than DatabasePanel's local state because a
 * migration outlives the settings dialog -- close and reopen it mid-run and the
 * panel used to come back blank until the next progress tick, having missed
 * every event while unmounted.
 */

import { atom } from 'jotai';

export interface MigrationProgressEvent {
  phase?: string;
  table?: string;
  currentTable?: string;
  rowsCopied?: number;
  rowsTotal?: number;
  rowsExpected?: number;
  totalRowsCopied?: number;
  tableRowsCopied?: number;
  tableRowsExpected?: number;
  tablesCompleted?: number;
  tablesTotal?: number;
  percentOfTotal?: number;
  elapsedMs?: number;
}

export interface MigrationPhaseEvent {
  phase: string;
  info?: MigrationProgressEvent;
}

export interface MigrationSummary {
  totalRowsCopied: number;
  tablesCopied: Array<{ name: string; rows: number }>;
  durationMs: number;
  integrityCheck: string;
  foreignKeyViolations: number;
  spotCheckCount: number;
}

export interface MigrationFailure {
  phase: string;
  message: string;
  stack?: string;
}

export const dbMigrationPhaseAtom = atom<MigrationPhaseEvent | null>(null);
export const dbMigrationProgressAtom = atom<MigrationProgressEvent | null>(null);
export const dbMigrationSummaryAtom = atom<MigrationSummary | null>(null);
export const dbMigrationFailureAtom = atom<MigrationFailure | null>(null);
export const dbMigrationRunningAtom = atom<boolean>(false);
