/**
 * Wiring for the boot-time forced migration.
 *
 * `autoMigrate.ts` owns the decision ("should this launch migrate?").
 * This module owns the plumbing around it: adapting the SQLite worker proxy to
 * the orchestrator surface, driving the splash screen, and relaunching. It
 * lives here rather than in `initialize.ts` because that file is already large
 * and this is a self-contained concern.
 */

import { app } from 'electron';

import { maybeAutoMigrate, type OrchestratorLike } from './sqlite/autoMigrate';
import { authorizeRollout } from './sqlite/migrationFlag';
import { getReleaseChannel } from '../utils/store';
import type { ResolvedBackend } from './sqlite/BackendSelector';
import type { SQLiteDatabaseProxy } from './sqlite/SQLiteDatabaseProxy';
import type { MigrationProgress } from './sqlite/PGLiteToSQLiteMigrator';
import {
  enterSplashMigrationMode,
  updateSplashMigrationProgress,
} from '../window/SplashScreen';
import { buildSplashView } from '../window/migrationProgressView';
import { emitMigrationOutcome } from './sqlite/migrationEventMapper';
import { readCutoverJournal } from './sqlite/cutoverJournal';
import { abortRequiresRelaunch } from './sqlite/cutoverMachine';
import { withDatabaseOperationLock } from './databaseOperationLock';
import { logger } from '../utils/logger';

/**
 * Run the forced migration if this launch is due for one.
 *
 * Returns true when the migration succeeded and a relaunch has been requested,
 * in which case the caller must stop initializing — the process is going away.
 * Every other outcome returns false and the caller carries on with PGLite.
 */
export async function runForcedMigration(args: {
  userDataPath: string;
  schemaDir: string;
  resolved: ResolvedBackend;
  proxy: SQLiteDatabaseProxy;
}): Promise<boolean> {
  // The same lock the Settings channels take. Boot migration is a migration:
  // it closes the engine and renames directories, and a recovery started from
  // the failure dialog while startup is still running would be doing the same
  // to the same paths. A conflict here defers the migration to a later launch,
  // which is always an acceptable answer while it stays disabled by default.
  const lease = await withDatabaseOperationLock('migration', () => forcedMigration(args));
  if (lease.acquired) return lease.value;
  logger.main.warn(
    '[Database] Skipping the boot migration: another database operation is in progress',
    { heldBy: lease.heldBy, heldSince: lease.heldSince },
  );
  return false;
}

async function forcedMigration(args: {
  userDataPath: string;
  schemaDir: string;
  resolved: ResolvedBackend;
  proxy: SQLiteDatabaseProxy;
}): Promise<boolean> {
  const { userDataPath, schemaDir, resolved, proxy } = args;

  let lastPercent = 0;
  let splashArmed = false;
  proxy.setMigrationObserver((event, payload) => {
    if (event !== 'db:migration:progress' && event !== 'db:migration:phase') return;
    const progress = (event === 'db:migration:phase'
      ? (payload as { info?: MigrationProgress }).info
      : (payload as MigrationProgress));
    if (!progress) return;
    // Arm the splash on the first real frame rather than up front, so a
    // migration that dies in pre-flight never flashes a progress bar.
    if (!splashArmed) {
      splashArmed = true;
      enterSplashMigrationMode();
    }
    const view = buildSplashView(progress, lastPercent);
    lastPercent = view.percent;
    updateSplashMigrationProgress(view);
  });

  const orchestrator: OrchestratorLike = {
    preflight: () => proxy.migrationPreflight({ userDataPath, schemaDir }),
    // The run context rides the request into the worker and comes back on the
    // terminal domain result, so the mapper can report which attempt this was
    // without a second channel and without this module naming an event.
    run: async (context) => {
      const { summary } = await proxy.startMigration({ userDataPath, schemaDir, ...context });
      return summary;
    },
  };

  const relaunch = () => {
    // Under Playwright, relaunching would spawn a second Electron that the
    // test runner does not own and cannot clean up. Quit instead; the spec
    // asserts the on-disk end state and then launches again itself.
    if (process.env.PLAYWRIGHT !== '1') {
      app.relaunch();
    }
    app.quit();
  };

  const outcome = await maybeAutoMigrate({
    userDataPath,
    resolved,
    // Resolved live on this launch. A cached "yes" from an earlier launch is
    // not authorization for a destructive operation; see
    // `sqlite/rolloutAuthorization.ts`.
    authorize: () => authorizeRollout(userDataPath),
    buildChannel: getReleaseChannel(),
    orchestrator,
    relaunch,
    // `onDecision` is intentionally not wired yet. The exposure decision is a
    // bounded, typed `RolloutDecision`; turning one into an analytics event is
    // `migrationEventMapper.ts`'s job, and it is the only module allowed to
    // name an event. Until the mapper grows a rollout-decision emitter, this
    // launch computes and logs its decision locally and transmits nothing --
    // which is correct while automatic migration is still disabled.
    // Analytics for a completed or failed migration comes from the worker's
    // domain result via `SQLiteDatabaseProxy`; this only covers the outcomes
    // the worker never sees, and the mapper drops it if the worker got there
    // first. This module used to emit its own `migration_completed`, which
    // was a second description of the same cutover.
    onOutcome: emitMigrationOutcome,
    log: (level, msg, meta) => logger.main[level](msg, meta),
  });

  if (outcome.action === 'migrated') return true;

  // A cutover that reached `source_quiesced` closed the live PGLite worker
  // during this launch, and every outcome other than `migrated` leaves the
  // caller believing PGLite is still open and serving. It is not, and no
  // amount of "carry on with the old backend" makes it so.
  //
  // Relaunch instead. The next process runs `reconcileCutoverOnStartup` first,
  // which either finishes the cutover or rolls it back from the journal. The
  // journal's own attempt counter is what stops this becoming a loop.
  //
  // Two signals, either of which is sufficient. The journal phase can lag the
  // close by one write; the abort flag comes from the frame that did the
  // closing and cannot.
  const journal = readCutoverJournal(userDataPath);
  const abortSaidRelaunch = outcome.action === 'failed' && outcome.requiresRelaunch;
  if (abortSaidRelaunch || abortRequiresRelaunch(null, journal?.phase ?? null)) {
    logger.main.error(
      '[Database] Cutover stopped after PGLite was closed; relaunching so startup can reconcile it',
      { phase: journal?.phase ?? 'no-journal', operationId: journal?.operationId, action: outcome.action },
    );
    relaunch();
    return true;
  }
  return false;
}
