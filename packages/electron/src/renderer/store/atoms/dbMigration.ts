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

// ---------------------------------------------------------------------------
// Durable refusal
// ---------------------------------------------------------------------------

/**
 * Why automatic migration will not run on this install. Mirrors
 * `MigrationRefusalReason` in main/database/sqlite/migrationOutcome.ts; the
 * renderer cannot import from main, so the union is kept in step by hand.
 */
export type MigrationRefusalReason =
  | 'backup_dwarfs_live'
  | 'projects_without_sessions'
  | 'source_unreadable'
  | 'source_missing'
  | 'insufficient_disk';

/** Mirrors `MigrationBlockedState` in main/database/sqlite/BackendSelector.ts. */
export interface MigrationBlockedState {
  reasonCode: MigrationRefusalReason;
  facts: Record<string, string | undefined>;
  factsFingerprint: string;
  blockedAt: string;
  assessmentVersion: number;
}

export const dbMigrationBlockedAtom = atom<MigrationBlockedState | null>(null);

// ---------------------------------------------------------------------------
// Recovery candidates
// ---------------------------------------------------------------------------

export type RecoverySizeBucket =
  | 'empty'
  | 'under-32mb'
  | 'under-256mb'
  | 'under-1gb'
  | 'under-3gb'
  | 'over-3gb';

export type RecoveryVerdict =
  | 'not_actionable'
  | 'needs_review'
  | 'recovery_recommended'
  | 'assessment_blocked';

/**
 * Flat view of a discovered artifact, produced by
 * main/ipc/RecoveryHandlers.ts. `factsFingerprint` is the digest of the facts
 * this row was computed from: it travels back with a restore request so the
 * transaction can refuse if anything moved between the user reading the row
 * and acting on it.
 */
export interface RecoveryCandidateView {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  sizeBucket: RecoverySizeBucket;
  createdAt: string | null;
  verdict: RecoveryVerdict;
  reasonCode: string;
  mayOfferProactively: boolean;
  factsFingerprint: string;
  restoreAvailable: boolean;
  restoreUnavailableReason: 'pglite_artifact_on_sqlite_install' | null;
}

/** The database a restore would displace. */
export interface LiveDatabaseView {
  backend: 'pglite' | 'sqlite';
  path: string;
  sizeBytes: number;
  sizeBucket: RecoverySizeBucket;
}

/** A `pglite-db.migrated-*` copy left behind by a migration. */
export interface MigratedCopyView {
  name: string;
  path: string;
  sizeBytes: number;
  createdAt: string | null;
  isRollbackSource: boolean;
}

export const dbRecoveryCandidatesAtom = atom<RecoveryCandidateView[]>([]);
export const dbRecoveryLiveAtom = atom<LiveDatabaseView | null>(null);

/**
 * The one candidate, if any, that assessment says is worth raising unprompted.
 * Only ever populated from `recovery_recommended`; every other verdict is
 * visible in Settings without the product claiming anything was lost.
 */
export const dbRecoveryOfferAtom = atom<RecoveryCandidateView | null>(null);

export const dbMigratedCopiesAtom = atom<MigratedCopyView[]>([]);
