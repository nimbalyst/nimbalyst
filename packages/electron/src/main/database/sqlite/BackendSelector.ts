/**
 * BackendSelector
 *
 * Single source of truth for whether the local store runs on PGLite or SQLite.
 *
 * Decision rules (from the plan):
 *   - Existing installs (have `pglite-db/`): stay on PGLite until the user
 *     opts in from Settings → Database → Migrate to SQLite.
 *   - Fresh installs (no `pglite-db/`): default to SQLite immediately.
 *   - The setting is persisted in a small JSON file at
 *     `<userData>/database-backend.json` rather than the main electron-store
 *     schema so we don't have to migrate the AppStoreSchema for a flag that
 *     turns over once per install.
 *
 * The flag is *only* flipped by the migration flow after verification passes.
 * Nothing else writes it.
 */

import * as fs from 'fs';
import * as path from 'path';

export type DatabaseBackend = 'pglite' | 'sqlite';

export interface BackendState {
  backend: DatabaseBackend;
  /** ISO timestamp the flag was last written. */
  setAt: string;
  /** Was this set automatically (fresh install) or by an explicit migration? */
  setBy: 'auto-fresh-install' | 'user-migration' | 'rollback';
  /** Optional pointer to the preserved pre-migration PGLite directory. */
  pgliteMigratedDir?: string;
}

const FLAG_FILE_NAME = 'database-backend.json';

export function getFlagPath(userDataPath: string): string {
  return path.join(userDataPath, FLAG_FILE_NAME);
}

export function readBackendState(userDataPath: string): BackendState | null {
  const flagPath = getFlagPath(userDataPath);
  if (!fs.existsSync(flagPath)) return null;
  try {
    const raw = fs.readFileSync(flagPath, 'utf-8');
    const parsed = JSON.parse(raw) as BackendState;
    if (parsed.backend !== 'pglite' && parsed.backend !== 'sqlite') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeBackendState(userDataPath: string, state: BackendState): void {
  fs.mkdirSync(userDataPath, { recursive: true });
  const flagPath = getFlagPath(userDataPath);
  fs.writeFileSync(flagPath, JSON.stringify(state, null, 2), 'utf-8');
}

export interface ResolveBackendInput {
  userDataPath: string;
}

export interface ResolvedBackend {
  backend: DatabaseBackend;
  reason:
    | 'flag-file-pglite'
    | 'flag-file-sqlite'
    | 'fresh-install-defaults-sqlite'
    | 'existing-pglite-no-flag';
  state: BackendState | null;
}

/**
 * Resolve which backend should be active on launch. Pure function aside from
 * filesystem reads; never writes the flag file (the migration flow does that).
 *
 * Decision tree:
 *   1. If `database-backend.json` exists -> obey it.
 *   2. If `pglite-db/` exists -> stay on PGLite, no migration triggered.
 *      (No flag file is written; the user explicitly chooses to migrate.)
 *   3. Otherwise -> fresh install, default SQLite.
 */
export function resolveBackend(input: ResolveBackendInput): ResolvedBackend {
  const state = readBackendState(input.userDataPath);
  if (state) {
    return {
      backend: state.backend,
      reason: state.backend === 'pglite' ? 'flag-file-pglite' : 'flag-file-sqlite',
      state,
    };
  }
  const pgliteDir = path.join(input.userDataPath, 'pglite-db');
  if (fs.existsSync(pgliteDir)) {
    return {
      backend: 'pglite',
      reason: 'existing-pglite-no-flag',
      state: null,
    };
  }
  return {
    backend: 'sqlite',
    reason: 'fresh-install-defaults-sqlite',
    state: null,
  };
}

/** Called by the migration flow at the cutover step. */
export function commitMigrationToSqlite(
  userDataPath: string,
  pgliteMigratedDir: string,
): void {
  writeBackendState(userDataPath, {
    backend: 'sqlite',
    setAt: new Date().toISOString(),
    setBy: 'user-migration',
    pgliteMigratedDir,
  });
}

/** Called by the rollback flow from Settings → Database → Restore PGLite. */
export function commitRollbackToPglite(userDataPath: string): void {
  writeBackendState(userDataPath, {
    backend: 'pglite',
    setAt: new Date().toISOString(),
    setBy: 'rollback',
  });
}

/** Called once on a fresh install where no pglite-db directory exists. */
export function commitFreshInstallSqlite(userDataPath: string): void {
  writeBackendState(userDataPath, {
    backend: 'sqlite',
    setAt: new Date().toISOString(),
    setBy: 'auto-fresh-install',
  });
}
