/**
 * Selected-artifact database recovery.
 *
 * The one import point for callers outside this directory — main-process
 * wiring, IPC handlers, and the Settings surface. Start with
 * `RecoveryService`: `listCandidates()` for the Settings list,
 * `proactiveOffer()` for the at-most-one launch prompt, and `recover()` to
 * act on a candidate the user chose.
 */

export { RecoveryService, timestampFromArtifactName } from './RecoveryService';
export type { RecoveryServiceOptions, RecoveryResolutionState } from './RecoveryService';

export { assessRecoveryCandidate, fingerprintAssessmentFacts } from './candidateAssessment';

export {
  createPgliteRecoveryAdapter,
  createSqliteRecoveryAdapter,
  readAgentMessageCountThrough,
  readIndicatorsThrough,
} from './backendAdapters';
export type {
  CandidateMaterializer,
  RecoveryEngineHandle,
  PgliteRecoveryAdapterOptions,
  SqliteRecoveryAdapterOptions,
} from './backendAdapters';

export { mayTryAnotherCandidate, runRecoveryTransaction } from './recoveryTransaction';
export type { RecoveryBackendAdapter, RecoveryTransactionArgs } from './recoveryTransaction';

export {
  createRecoveryVerifier,
  verifyRecoveryTargetFile,
  REQUIRED_TABLES,
  RECOVERY_VERIFY_WORKER_FILENAME,
} from './recoveryVerification';
export {
  createPgliteRecoveryVerifier,
  isVerifierFailure,
  VERIFIER_FAILURE_PREFIX,
} from './pgliteVerification';
export { createPgliteArtifactMaterializer } from './pgliteToSqliteMaterializer';

export {
  RECOVERY_PHASES,
  MAX_RECOVERY_RECONCILE_ATTEMPTS,
  clearRecoveryJournal,
  createRecoveryJournalPort,
  getRecoveryJournalPath,
  readRecoveryJournal,
  readRecoveryJournalStatus,
  realRecoveryFs,
  writeRecoveryJournal,
  RecoveryInProgressError,
} from './recoveryJournal';
export type {
  RecoveryFsPort,
  RecoveryJournal,
  RecoveryJournalPort,
  RecoveryJournalRead,
  RecoveryPhase,
} from './recoveryJournal';

export {
  observeRecoveryFacts,
  observeStrandedRecoveryCopies,
  planRecoveryReconcile,
  reconcileRecoveryOnStartup,
} from './recoveryReconciler';
export type {
  RecoveryObservedFacts,
  RecoveryReconcileAction,
  RecoveryReconcilePlan,
  RecoveryReconcileResult,
} from './recoveryReconciler';

export { buildRecoveryEvent, emitRecoveryEvent } from './recoveryEventMapper';
export type { RecoveryTrigger } from './recoveryEventMapper';

export {
  activeBackend,
  buildProductionRecoveryAdapter,
  buildProductionRecoveryService,
  createCandidateProbe,
  getUserDataPath,
  liveDatabasePath,
  pgliteWorkerPath,
  restoreFromNamedBackup,
  PGLITE_DIR,
  SQLITE_RELPATH,
} from './productionRecovery';

export * from './types';
