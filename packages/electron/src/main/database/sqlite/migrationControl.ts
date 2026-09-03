/**
 * The control hooks main installs on the migration proxy.
 *
 * This is the bridge the cutover's `quiesceSource` step actually runs in
 * production: `runCutover` -> `MigrationOrchestrator.closeRunningPglite` ->
 * the worker's `workerControlRequest` -> `SQLiteDatabaseProxy` ->
 * `MigrationControlHandler.closePglite` -> here -> `database.close()`.
 *
 * It lives in its own file because the version of it that shipped was written
 * inline in `initialize.ts`, which meant no test ever ran it. Every cutover
 * test injected its own `closeRunningPglite`, so the one hop that mattered --
 * the last one, the one holding the real PGLite worker -- was the only hop
 * with no coverage. It caught `database.close()` rejecting and logged
 * "proceeding anyway", which reported a successful quiesce to the cutover
 * machine and let it rename the source out from under a worker that had not
 * confirmed it was closed. Writes that landed after that rename end up in the
 * preserved directory, invisible to an app that is now reading SQLite.
 *
 * So the contract here is one line long: a close that does not resolve is not
 * a close. Everything downstream is built on `quiesceSource` telling the truth
 * (safety invariant 4 -- source close failures are never suppressed).
 */

import type { MigrationControlHandler } from './SQLiteDatabaseProxy';

export interface MigrationControlDeps {
  /** Close the live PGLite worker. Rejects if the close cannot be confirmed. */
  closePglite: () => Promise<void>;
  /** Called after a cutover lands, for logging/teardown. Never gates safety. */
  onCutoverSuccess?: (info: { sqliteDir: string; pgliteMigratedDir: string }) => Promise<void> | void;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

export function createMigrationControl(deps: MigrationControlDeps): MigrationControlHandler {
  const log = deps.log ?? (() => {});
  return {
    closePglite: async () => {
      try {
        await deps.closePglite();
      } catch (err) {
        // Rethrown, not swallowed. The cutover machine turns this into an
        // abort at `source_quiesced`, which leaves `pglite-db/` exactly where
        // it is and the backend flag untouched -- the install carries on with
        // the database it already had.
        log('error', '[Migration] PGLite close failed; aborting cutover before any rename', err);
        throw err;
      }
    },
    onCutoverSuccess: deps.onCutoverSuccess,
  };
}
