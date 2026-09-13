import * as fs from "fs";
import * as path from "path";
import { logger } from "../../utils/logger";
import { readBackendState } from "../sqlite/BackendSelector";
import {
  fingerprintSource,
  fingerprintsMatch,
  getCutoverJournalPath,
  readCutoverJournalStatus,
  writeCutoverJournal,
} from "../sqlite/cutoverJournal";
import { runRollback } from "../sqlite/rollbackTransaction";
import type { RecoveryVerification } from "./types";
import type { RestorableBackup } from "../sqlite/recoveryArtifacts";

/** One line per install per process; this runs on every dialog build. */
const unreadableJournalReported = new Set<string>();

function reportUnreadableJournal(userDataPath: string, detail: string): void {
  if (unreadableJournalReported.has(userDataPath)) return;
  unreadableJournalReported.add(userDataPath);
  logger.main.warn(
    "[Database] cutover journal is unreadable; no pre-migration rollback is offered",
    { detail }
  );
}

/** Only the source recorded by this cutover is eligible for one-click recovery. */
export function recordedPreMigrationSource(
  userDataPath: string
): RestorableBackup | undefined {
  const read = readCutoverJournalStatus(userDataPath);
  // A journal we cannot parse names no paths, so it authorizes nothing. The
  // backend flag would still name a migrated directory, but offering a
  // one-click rollback on the strength of a record nobody could read is
  // exactly the "act on a heuristic" shape of #1347.
  if (read.status === "unreadable") {
    reportUnreadableJournal(userDataPath, read.detail);
    return undefined;
  }
  const journalSource =
    read.status === "ok" && read.journal.operation !== "rollback"
      ? read.journal.source.preservedPath
      : undefined;
  // Journals cleared by earlier builds cannot be reconstructed, so the
  // backend record stays a valid source -- it is simply never the default.
  const source =
    journalSource ?? readBackendState(userDataPath)?.pgliteMigratedDir;
  if (
    !source ||
    !fs.existsSync(path.join(source, "PG_VERSION")) ||
    fs.existsSync(path.join(userDataPath, "pglite-db")) ||
    !fs.existsSync(path.join(userDataPath, "sqlite-db"))
  )
    return undefined;
  return { path: source, name: path.basename(source), bytes: 0 };
}

/**
 * Copy the cutover journal aside as evidence, leaving the original in place.
 *
 * The original keeps its authority until a recovery has actually replaced the
 * live store. Renaming it aside first opened a window: a crash between the
 * rename and the restore left no journal at all, and the next launch opened a
 * database that had just failed receipt verification as if nothing were
 * pending. Returns the copy's path, or `undefined` when there is nothing to
 * preserve. Throws only if the copy itself fails.
 */
export function preserveCutoverJournalEvidence(
  userDataPath: string
): string | undefined {
  const file = getCutoverJournalPath(userDataPath);
  if (!fs.existsSync(file)) return undefined;
  const read = readCutoverJournalStatus(userDataPath);
  if (read.status === "unreadable") {
    // Startup tolerates an unreadable journal and never acts on it, so it can
    // stay exactly where it is as the only record that a cutover was running.
    logger.main.warn(
      "[Database] leaving the unreadable cutover journal in place",
      { detail: read.detail }
    );
    return undefined;
  }
  const copy = `${file}.recovered-${Date.now()}`;
  fs.copyFileSync(file, copy);
  logger.main.info(
    "[Database] preserved a copy of the cutover journal before recovery",
    { copy }
  );
  return copy;
}

/**
 * Remove the forward journal once a backup restore has replaced its live
 * store. Never throws: if the file cannot be removed, the next launch fails
 * receipt verification against the restored copy and shows the dialog again,
 * and restoring again from there converges.
 */
export function retireCutoverJournal(userDataPath: string): void {
  try {
    if (readCutoverJournalStatus(userDataPath).status === "unreadable") return;
    fs.rmSync(getCutoverJournalPath(userDataPath), { force: true });
  } catch (error) {
    logger.main.warn(
      "[Database] could not retire the cutover journal after a successful restore",
      error
    );
  }
}

/** What `restoreWithCutoverJournalEvidence` needs to know about the work it wraps. */
export interface RecoveryAttemptOutcome {
  ok: boolean;
  message?: string;
  /**
   * False once the attempt has moved something. Callers coming from the
   * failure dialog compute it with `mayTryAnotherCandidate`; the default,
   * as there, is that a caller which says nothing moved nothing.
   */
  canTryAnother?: boolean;
}

/**
 * Preserve evidence, run the restore, and retire the forward journal only
 * after the restore reports success.
 *
 * A failed or throwing restore leaves the journal exactly where it was, so
 * startup still verifies whatever is live. A crash between a successful
 * restore and the retirement leaves the journal too: the next launch fails
 * verification, shows the dialog, and restoring again converges. Neither
 * window can boot an unverified store silently.
 */
export async function restoreWithCutoverJournalEvidence(
  userDataPath: string,
  run: () => Promise<RecoveryAttemptOutcome>
): Promise<RecoveryAttemptOutcome> {
  try {
    preserveCutoverJournalEvidence(userDataPath);
  } catch (error) {
    logger.main.error(
      "[Database] could not preserve the cutover journal; not attempting the restore",
      error
    );
    return {
      ok: false,
      canTryAnother: false,
      message:
        "The record of the database switch could not be copied aside, so the restore was not attempted. Nothing was moved.",
    };
  }
  const outcome = await run();
  if (outcome.ok) retireCutoverJournal(userDataPath);
  return outcome;
}

export async function recoverPreMigrationDatabase(args: {
  userDataPath: string;
  source: RestorableBackup;
  verify: (candidate: string) => Promise<RecoveryVerification>;
  closeDatabase: () => Promise<void>;
}): Promise<void> {
  const selected = recordedPreMigrationSource(args.userDataPath);
  if (!selected || selected.path !== args.source.path)
    throw new Error(
      "The recorded pre-migration source changed. Nothing was moved."
    );
  const read = readCutoverJournalStatus(args.userDataPath);
  const recorded =
    read.status === "ok" && read.journal.source.preservedPath === selected.path
      ? read.journal
      : undefined;
  // Reassess identity before anything opens the directory: the probe below
  // touches it, and comparing afterwards would measure our own reading of it.
  // The reconciler makes the same comparison for the same reason.
  if (
    recorded?.source.fingerprint &&
    !fingerprintsMatch(
      fingerprintSource(selected.path),
      recorded.source.fingerprint
    )
  ) {
    throw new Error(
      "The preserved database does not match the recorded pre-migration source. Nothing was moved."
    );
  }
  const verified = await args.verify(selected.path);
  if (
    !verified.valid ||
    !verified.requiredSchemaPresent ||
    !Object.values(verified.indicators).some(
      (count) => typeof count === "number" && count > 0
    )
  ) {
    throw new Error(
      verified.error ??
        "The pre-migration database could not be verified. Nothing was moved."
    );
  }
  // The probe opened the store, which moves its top-level mtimes. Its content
  // has just been confirmed, so record the store as it is now; otherwise an
  // attempt that fails below would leave a later attempt refusing the same
  // source for the footprint of this check.
  if (recorded?.source.fingerprint) {
    writeCutoverJournal(args.userDataPath, {
      ...recorded,
      source: { ...recorded.source, fingerprint: fingerprintSource(selected.path) },
    });
  }
  await args.closeDatabase();
  // The rollback writes its own journal over this one, so keep the forward
  // record as evidence. The original stays authoritative until that write.
  preserveCutoverJournalEvidence(args.userDataPath);
  await runRollback({
    userDataPath: args.userDataPath,
    sourceOverride: selected.path,
    quiesceSqlite: async () => {},
  });
}
