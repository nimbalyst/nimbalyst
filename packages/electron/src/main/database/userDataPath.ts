/**
 * The one answer to "where does this install keep its database?".
 *
 * Five modules used to compute this independently and two of them got a
 * different answer. `initialize.ts` and `PGLiteDatabaseWorker.ts` honoured
 * `NIMBALYST_USER_DATA_PATH` and the Playwright temp directory;
 * `productionRecovery.ts` honoured only the first; `index.ts` and
 * `DatabaseBackupService.ts` honoured neither and went straight to
 * `app.getPath('userData')`.
 *
 * That split is not cosmetic. Startup recovery reconciliation, the failure
 * dialog's backup scan, and the recovery transaction all have to be looking at
 * the same directory as the database they are recovering. When they are not,
 * an interrupted recovery under a supported override writes its journal to one
 * root and reads it back from another -- which reads as "no interrupted
 * recovery" and lets startup create an empty database on top of the displaced
 * copy. That is #1347's ending reached through a configuration flag.
 *
 * Deliberately not in `utils/appPaths.ts`: this is the *database* root, which
 * `NIMBALYST_USER_DATA_PATH` can point somewhere other than Electron's
 * userData, and every consumer here is a database module.
 */

import { app } from 'electron';
import * as path from 'path';

/**
 * Precedence, highest first:
 *
 *   1. `NIMBALYST_USER_DATA_PATH` -- the documented override, used for manual
 *      testing of packaged builds and by the database E2E specs.
 *   2. `PLAYWRIGHT=1` -- an isolated temp root so a test run cannot touch a
 *      real install's database.
 *   3. Electron's userData, which `bootstrap.ts` may itself have redirected
 *      via `NIMBALYST_USER_DATA_DIR`.
 */
export function resolveDatabaseUserDataPath(): string {
  return (
    process.env.NIMBALYST_USER_DATA_PATH
    || (process.env.PLAYWRIGHT === '1' ? path.join(app.getPath('temp'), 'nimbalyst-test-db') : null)
    || app.getPath('userData')
  );
}
