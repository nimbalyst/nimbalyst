/**
 * BackendSelector
 *
 * Single source of truth for whether the local store runs on PGLite or SQLite.
 *
 * Decision rules:
 *   - Existing installs (have `pglite-db/`): migration is *due*. The boot path
 *     migrates them automatically (see `autoMigrate.ts`); they no longer wait
 *     for the user to opt in from Settings.
 *   - Except installs that explicitly rolled back (`setBy: 'rollback'`). Those
 *     stay on PGLite forever — the user already told us SQLite went badly for
 *     them, and silently dragging them back would be the worst possible bug.
 *   - Fresh installs (no `pglite-db/`): default to SQLite immediately.
 *   - The setting is persisted in a small JSON file at
 *     `<userData>/database-backend.json` rather than the main electron-store
 *     schema so we don't have to migrate the AppStoreSchema for a flag that
 *     turns over once per install.
 *
 * Writers: the migration flow (manual and automatic) flips `backend`, and the
 * auto-migration path additionally records attempt bookkeeping and the cached
 * kill-switch value. All writes go through `writeBackendState`, which is
 * atomic — a torn file here reads back as `null` and silently degrades to disk
 * inference, which during an auto-migration would mean re-migrating an install
 * that had already cut over.
 */

import * as fs from 'fs';
import * as path from 'path';

// `cutoverJournal` imports only types from this module, so this is not a
// runtime cycle -- the type import is erased.
import { writeJsonAtomic } from './cutoverJournal';
import {
  MIGRATION_ASSESSMENT_VERSION,
  type MigrationRefusal,
  type MigrationRefusalFacts,
  type MigrationRefusalReason,
} from './migrationOutcome';
// Type-only: `rolloutAuthorization` imports nothing from here, so this is not
// a runtime cycle.
import type { RolloutSnapshot } from './rolloutAuthorization';

export { MIGRATION_ASSESSMENT_VERSION };

export type DatabaseBackend = 'pglite' | 'sqlite';

/**
 * Consecutive auto-migration failures. Reset on success; once `count` reaches
 * MAX_AUTO_MIGRATION_ATTEMPTS the boot path stops trying and leaves the user
 * on PGLite with the manual Settings flow.
 */
export interface MigrationAttempts {
  count: number;
  lastAttemptAt: string;
  lastErrorCode?: string;
}

export const MAX_AUTO_MIGRATION_ATTEMPTS = 3;

/**
 * A durable verdict that automatic migration must not run on this install.
 *
 * Distinct from `migrationAttempts` on purpose. An attempt is a transient
 * failure of the machinery and three of them retire the install; a block is a
 * conclusion about the *data* and does not expire on its own. Counting a
 * refusal as an attempt would have quietly retired the install after three
 * launches and left nothing to show the user.
 *
 * Precedence, highest first. A future reader changing any branch of
 * `maybeAutoMigrate` should keep this ordering intact:
 *
 *   1. `setBy: 'rollback'` — the user already chose PGLite. Nothing here
 *      applies; the install is not migration-due at all, so no block is ever
 *      recorded for it and an existing one is inert.
 *   2. A completed migration (`backend === 'sqlite'`) — there is nothing left
 *      to block. `commitMigrationToSqlite` drops any block it finds.
 *   3. This block — checked *before* `migrationAttempts`, and never increments
 *      it. Refusal is a verdict, not a failure.
 *   4. `migrationAttempts` back-off.
 *
 * Clearing happens on exactly three events: the user asks (Settings retry),
 * the measured facts change (a different `factsFingerprint`), or this build
 * assesses differently from the one that recorded it (`assessmentVersion` is
 * behind `MIGRATION_ASSESSMENT_VERSION`).
 *
 * Blocks gate *automatic* migration only. A user who opens Settings and asks
 * for a migration is answering the question the block was raised about, so the
 * manual path reports the refusal and leaves the durable state alone.
 */
export interface MigrationBlockedState {
  reasonCode: MigrationRefusalReason;
  /** Bounded buckets, not measurements. See `migrationOutcome.ts`. */
  facts: MigrationRefusalFacts;
  factsFingerprint: string;
  blockedAt: string;
  assessmentVersion: number;
}

export interface BackendState {
  backend: DatabaseBackend;
  /** ISO timestamp the flag was last written. */
  setAt: string;
  /** Was this set automatically (fresh install) or by an explicit migration? */
  setBy:
    | 'auto-fresh-install'
    | 'user-migration'
    | 'auto-migration'
    | 'auto-migration-deferred'
    | 'rollback'
    /** Written by `resolveBackend` when the flag contradicted the disk (#1347). */
    | 'contradiction-heal';
  /** Optional pointer to the preserved pre-migration PGLite directory. */
  pgliteMigratedDir?: string;
  /** Auto-migration back-off bookkeeping. Absent until the first failure. */
  migrationAttempts?: MigrationAttempts;
  /**
   * Durable refusal. Absent unless automatic migration has been blocked; see
   * `MigrationBlockedState` for how it ranks against the fields above.
   */
  migrationBlocked?: MigrationBlockedState;
  /**
   * Last value of the old `force-sqlite-migration` boolean.
   *
   * @deprecated Never read. It was cached indefinitely, so an install that had
   * once seen `true` kept migrating no matter what the remote value became --
   * a memory, not a kill switch. Replaced by `rolloutSnapshot`, which is not an
   * input to any decision either. Declared only so a future reader sees that
   * the field on existing installs is inert rather than missing.
   */
  forceMigrationFlag?: boolean;
  /**
   * The last rollout snapshot that passed validation.
   *
   * **Diagnostic only.** Authorization is resolved live on the launch that
   * would migrate (`rolloutAuthorization.ts`); nothing reads this to decide.
   * It exists so Settings and support can see what this install was last told.
   */
  rolloutSnapshot?: RolloutSnapshot;
  /**
   * Which configuration version this install has already reported an exposure
   * decision for. The ramp gates require exactly one decision per install per
   * `configVersion`; more than one is an observability failure that stops the
   * ramp, so the marker is what keeps a relaunch from double-counting.
   *
   * Written only after the event was accepted for delivery, so a launch that
   * failed to enqueue retries on the next one rather than going silent.
   */
  rolloutDecisionEmitted?: { configVersion: string; emittedAt: string };
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

/**
 * Write the flag atomically. A partially-written file parses as `null`, which
 * `resolveBackend` treats as "no flag" and falls back to disk inference — for
 * an install that has already cut over, that would look like a fresh PGLite
 * migration candidate. Write to a sibling temp file and rename, which is
 * atomic within a directory on every platform we ship.
 */
export function writeBackendState(userDataPath: string, state: BackendState): void {
  // Shared with the cutover journal so the two files that between them decide
  // which database the app opens hold to the same durability standard.
  writeJsonAtomic(getFlagPath(userDataPath), state);
}

/**
 * Merge a partial update into the existing state without losing sibling fields.
 *
 * Returns `null` without writing when there is no state yet and the patch does
 * not name a backend. Choosing a backend is `resolveBackend`'s job; a caller
 * updating a sibling field must never decide it as a side effect. This used to
 * default to `pglite`, which meant the kill-switch cache refresh — it runs on
 * every launch, including a fresh install's first — wrote "pglite" into the
 * flag file of an install that had just resolved to SQLite, pinning it to a
 * PGLite database it should never have had (#1347).
 */
export function updateBackendState(
  userDataPath: string,
  patch: Partial<BackendState>,
): BackendState | null {
  const current = readBackendState(userDataPath);
  if (!current) {
    if (!patch.backend || !patch.setBy) return null;
    const created: BackendState = {
      ...patch,
      backend: patch.backend,
      setBy: patch.setBy,
      setAt: new Date().toISOString(),
    };
    writeBackendState(userDataPath, created);
    return created;
  }
  const next: BackendState = { ...current, ...patch };
  writeBackendState(userDataPath, next);
  return next;
}

export interface ResolveBackendInput {
  userDataPath: string;
}

export type BackendReason =
  | 'flag-file-pglite-rollback'
  | 'flag-file-sqlite'
  | 'fresh-install-defaults-sqlite'
  | 'existing-pglite-migration-due'
  | 'flag-contradiction-healed-sqlite'
  | 'flag-contradiction-healed-pglite';

/** Live SQLite store, relative to userData. */
const SQLITE_DB_RELPATH = path.join('sqlite-db', 'nimbalyst.sqlite');

/**
 * Below this a `nimbalyst.sqlite` is a stub, not a store. The floor exists only
 * to reject a zero-byte or half-created file -- the contradiction itself is
 * what carries the decision.
 *
 * Keep it far below a real database. A schema-only store at migration v34
 * measures ~836 KB before a single message is written, so a floor anywhere near
 * a megabyte silently excludes light-but-genuine installs: the first draft of
 * this guard used 1 MB and failed to heal a 7-session fixture.
 *
 * Erring low is the safe direction. When the flag's own backend has no store on
 * disk, booting it creates an empty database, so there is no case where
 * honouring the flag beats switching to the store that does exist -- even a
 * near-empty one. The floor is a sanity check, not a judgement about value.
 */
const SQLITE_PLAUSIBLE_MIN_BYTES = 64 * 1024;

export interface BackendContradictionFacts {
  /** What the flag file claims. */
  flagBackend: DatabaseBackend;
  flagSetBy: BackendState['setBy'];
  pgliteDirExists: boolean;
  /** Size of `sqlite-db/nimbalyst.sqlite`; 0 when absent. */
  sqliteDbBytes: number;
}

export type BackendContradictionVerdict =
  | { action: 'honor' }
  | { action: 'override'; backend: DatabaseBackend; reason: string };

/**
 * Does the flag file name a backend whose store is not on disk, while the other
 * backend's store is?
 *
 * Pure, and every input is a fact from OUTSIDE the flag file, because a flag
 * file cannot vouch for itself -- the same reasoning as `assessMigrationSource`
 * (NIM-3632) and required by `.claude/rules/destructive-data-paths.md`.
 *
 * This exists because pre-0.74.2 builds wrote `{backend: 'pglite', setBy:
 * 'auto-migration-deferred'}` over installs that were running on SQLite, and
 * `b8f33e474` only stopped new writes. An install poisoned before it upgraded
 * still resolves to PGLite, and because PGLite *creates* `pglite-db/` when it
 * is missing, it boots an empty database and orphans the real one (#1347).
 */
export function assessBackendContradiction(
  facts: BackendContradictionFacts,
): BackendContradictionVerdict {
  // A rollback is the user telling us SQLite went badly for them. Their PGLite
  // store may legitimately be missing (restored by hand, moved, not yet copied
  // back); overriding it would be exactly the surprise they opted out of.
  if (facts.flagSetBy === 'rollback') return { action: 'honor' };

  const sqliteIsPlausible = facts.sqliteDbBytes >= SQLITE_PLAUSIBLE_MIN_BYTES;

  if (facts.flagBackend === 'pglite' && !facts.pgliteDirExists && sqliteIsPlausible) {
    return {
      action: 'override',
      backend: 'sqlite',
      reason:
        'flag file says pglite but there is no pglite-db/ on disk, while ' +
        'sqlite-db/nimbalyst.sqlite holds data',
    };
  }

  if (facts.flagBackend === 'sqlite' && !sqliteIsPlausible && facts.pgliteDirExists) {
    return {
      action: 'override',
      backend: 'pglite',
      reason:
        'flag file says sqlite but there is no usable sqlite-db/nimbalyst.sqlite, ' +
        'while pglite-db/ exists',
    };
  }

  return { action: 'honor' };
}

/** Size of a file, or 0 when it is missing or unreadable. */
function fileBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export interface ResolvedBackend {
  backend: DatabaseBackend;
  reason: BackendReason;
  state: BackendState | null;
  /**
   * True when this install should be auto-migrated on this launch, subject to
   * the kill switch and back-off that `maybeAutoMigrate` applies. Rollback
   * installs are never due.
   */
  migrationDue: boolean;
}

/**
 * Resolve which backend should be active on launch.
 *
 * Decision tree:
 *   0. Flag file contradicted by the disk -> heal it, and persist the
 *      correction so this is a one-time event (see
 *      `assessBackendContradiction`). Checked first: every branch below trusts
 *      the flag, and a flag that names a store which is not there cannot be
 *      trusted by any of them.
 *   1. Flag file says sqlite -> SQLite. Done, nothing due.
 *   2. Flag file says pglite via `rollback` -> PGLite, permanently. The user
 *      migrated, hit a problem, and chose to go back. Never auto-migrate them.
 *   3. Flag file says pglite any other way (a deferred/backed-off auto
 *      migration) -> PGLite, migration due.
 *   4. No flag file but `pglite-db/` exists -> PGLite, migration due.
 *   5. Otherwise -> fresh install, SQLite.
 *
 * Writes only in case 0, and only to correct itself. The write is wrapped
 * because a read-only userData must not turn a recoverable boot into a failed
 * one -- an un-persisted heal still resolves correctly, it just re-runs next
 * launch.
 */
export function resolveBackend(input: ResolveBackendInput): ResolvedBackend {
  const state = readBackendState(input.userDataPath);
  if (state) {
    const verdict = assessBackendContradiction({
      flagBackend: state.backend,
      flagSetBy: state.setBy,
      pgliteDirExists: fs.existsSync(path.join(input.userDataPath, 'pglite-db')),
      sqliteDbBytes: fileBytes(path.join(input.userDataPath, SQLITE_DB_RELPATH)),
    });
    if (verdict.action === 'override') {
      const healed: BackendState = {
        ...state,
        backend: verdict.backend,
        setAt: new Date().toISOString(),
        setBy: 'contradiction-heal',
      };
      try {
        writeBackendState(input.userDataPath, healed);
      } catch {
        // Resolution below still uses `healed`; the correction just is not
        // durable, so the next launch heals again. Never fail the boot here.
      }
      return {
        backend: verdict.backend,
        reason:
          verdict.backend === 'sqlite'
            ? 'flag-contradiction-healed-sqlite'
            : 'flag-contradiction-healed-pglite',
        state: healed,
        // A healed install is on the store that actually holds its data. It may
        // still be a migration candidate later, but not on the launch where we
        // just discovered the flag was lying.
        migrationDue: false,
      };
    }
    if (state.backend === 'sqlite') {
      return { backend: 'sqlite', reason: 'flag-file-sqlite', state, migrationDue: false };
    }
    if (state.setBy === 'rollback') {
      return {
        backend: 'pglite',
        reason: 'flag-file-pglite-rollback',
        state,
        migrationDue: false,
      };
    }
    return {
      backend: 'pglite',
      reason: 'existing-pglite-migration-due',
      state,
      migrationDue: true,
    };
  }
  const pgliteDir = path.join(input.userDataPath, 'pglite-db');
  if (fs.existsSync(pgliteDir)) {
    return {
      backend: 'pglite',
      reason: 'existing-pglite-migration-due',
      state: null,
      migrationDue: true,
    };
  }
  return {
    backend: 'sqlite',
    reason: 'fresh-install-defaults-sqlite',
    state: null,
    migrationDue: false,
  };
}

/**
 * Called by the migration flow at the cutover step. Drops any durable block:
 * the migration this install was blocked from doing has now happened, so
 * leaving the record would show the user a warning about a decision that is
 * already behind them.
 */
export function commitMigrationToSqlite(
  userDataPath: string,
  pgliteMigratedDir: string,
  setBy: 'user-migration' | 'auto-migration' = 'user-migration',
): void {
  writeBackendState(userDataPath, {
    backend: 'sqlite',
    setAt: new Date().toISOString(),
    setBy,
    pgliteMigratedDir,
  });
}

/** Record a failed auto-migration attempt so the back-off can count it. */
export function recordAutoMigrationFailure(userDataPath: string, errorCode: string): number {
  const previous = readBackendState(userDataPath)?.migrationAttempts?.count ?? 0;
  const count = previous + 1;
  updateBackendState(userDataPath, {
    backend: 'pglite',
    setBy: 'auto-migration-deferred',
    migrationAttempts: { count, lastAttemptAt: new Date().toISOString(), lastErrorCode: errorCode },
  });
  return count;
}

// ---------------------------------------------------------------------------
// Durable refusal. See `MigrationBlockedState` for the precedence rules.
// ---------------------------------------------------------------------------

/**
 * Persist a refusal. Deliberately does not touch `migrationAttempts` — the two
 * are independent, and conflating them is the bug this separation exists to
 * prevent.
 */
export function recordMigrationBlocked(
  userDataPath: string,
  blocked: MigrationBlockedState,
): void {
  updateBackendState(userDataPath, {
    backend: 'pglite',
    setBy: 'auto-migration-deferred',
    migrationBlocked: blocked,
  });
}

/** Build the durable record for a refusal produced this launch. */
export function blockedStateFromRefusal(refusal: MigrationRefusal): MigrationBlockedState {
  return {
    reasonCode: refusal.reasonCode,
    facts: refusal.facts,
    factsFingerprint: refusal.factsFingerprint,
    blockedAt: new Date().toISOString(),
    assessmentVersion: MIGRATION_ASSESSMENT_VERSION,
  };
}

/**
 * The block this install is currently under, or null.
 *
 * The typed read surface for Settings: a block that cannot be seen is a boot
 * that silently does nothing, which is the failure mode of the old behaviour.
 * Returns null once the install is on SQLite or has rolled back, because a
 * block means "automatic migration will not run" and neither of those states
 * has an automatic migration pending in the first place.
 */
export function getMigrationBlockedState(userDataPath: string): MigrationBlockedState | null {
  const state = readBackendState(userDataPath);
  if (!state?.migrationBlocked) return null;
  if (state.backend === 'sqlite' || state.setBy === 'rollback') return null;
  return state.migrationBlocked;
}

/**
 * Clear the block. Called by the user's explicit retry from Settings, and by
 * the boot path when the facts it just measured differ from the ones that
 * produced the block.
 */
export function clearMigrationBlocked(userDataPath: string): void {
  const state = readBackendState(userDataPath);
  if (!state?.migrationBlocked) return;
  const next: BackendState = { ...state };
  delete next.migrationBlocked;
  writeBackendState(userDataPath, next);
}

/**
 * Does a recorded block still stand against what we measured this launch?
 *
 * `currentFingerprint` is the fingerprint of the refusal produced on this
 * launch, or null when this launch found nothing to refuse. Pure so the
 * precedence above is testable without a filesystem or a real install.
 */
export function isMigrationStillBlocked(
  blocked: MigrationBlockedState | null | undefined,
  currentFingerprint: string | null,
): boolean {
  if (!blocked) return false;
  // An older build's verdict is not this build's verdict.
  if (blocked.assessmentVersion !== MIGRATION_ASSESSMENT_VERSION) return false;
  // Nothing refused this launch: the situation moved, so re-assess.
  if (currentFingerprint === null) return false;
  return currentFingerprint === blocked.factsFingerprint;
}

/**
 * Has this install already reported its exposure decision for `configVersion`?
 *
 * Scoped to the version rather than to the install: a new ceiling or channel
 * policy ships a new version, and that is a new exposure the ramp needs to
 * count. Anything else would make a second cohort invisible.
 */
export function hasEmittedRolloutDecision(
  state: BackendState | null,
  configVersion: string,
): boolean {
  return state?.rolloutDecisionEmitted?.configVersion === configVersion;
}

/**
 * Mark the exposure decision as delivered. Called only after the event was
 * accepted for delivery -- an unqueued event must be retried on a later
 * launch, not silently dropped by a marker written too early.
 */
export function recordRolloutDecisionEmitted(userDataPath: string, configVersion: string): void {
  const patch: Partial<BackendState> = {
    rolloutDecisionEmitted: { configVersion, emittedAt: new Date().toISOString() },
  };
  // An install that has never written a flag file still needs the marker, or it
  // re-reports its exposure on every launch and inflates the denominator. Only
  // such an install gets a backend named here: passing `backend` unconditionally
  // would overwrite a completed cutover with `pglite`, which is the exact write
  // that poisoned installs in #1347. `migrationDue` is the only state that
  // reaches this function without a flag file, and `pglite` is what it is.
  if (!readBackendState(userDataPath)) {
    patch.backend = 'pglite';
    patch.setBy = 'auto-migration-deferred';
  }
  updateBackendState(userDataPath, patch);
}

/** Has this install exhausted its automatic attempts? */
export function hasExhaustedAutoMigration(state: BackendState | null): boolean {
  return (state?.migrationAttempts?.count ?? 0) >= MAX_AUTO_MIGRATION_ATTEMPTS;
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
