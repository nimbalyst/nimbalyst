import type { DatabaseBackend } from "./BackendSelector";
import {
  advanceCutoverPhase,
  clearCutoverJournal,
  readCutoverJournalStatus,
  writeCutoverJournal,
} from "./cutoverJournal";
import type { CutoverVerification } from "./cutoverVerification";
import type { MigrationCompletedOutcome } from "./migrationOutcome";

/** Completion is durable in the existing journal until the next startup. */
export function deferCutoverOutcome(
  userDataPath: string,
  outcome: MigrationCompletedOutcome
): boolean {
  const read = readCutoverJournalStatus(userDataPath);
  if (read.status !== "ok" || read.journal.phase !== "backend_committed")
    return false;
  writeCutoverJournal(userDataPath, {
    ...read.journal,
    pendingOutcome: { ...outcome, operationId: read.journal.operationId },
  });
  return true;
}

export async function verifyPendingCutover(args: {
  userDataPath: string;
  backend: DatabaseBackend;
  verify: (receipt?: CutoverVerification) => Promise<void>;
  emitOutcome: (outcome: MigrationCompletedOutcome) => void;
  /** Reported when the journal cannot be parsed; startup then proceeds without it. */
  warn?: (message: string, detail: string) => void;
}): Promise<() => void> {
  const read = readCutoverJournalStatus(args.userDataPath);
  if (read.status === "absent") return () => {};
  if (read.status === "unreadable") {
    // The reconciler already held without touching anything. A record nobody
    // can parse authorizes no verification and no acknowledgement, and failing
    // the boot over it would send a healthy install to the recovery dialog
    // for a file we merely could not read. It stays in place.
    args.warn?.(
      "[Database] cutover journal unreadable; starting without verification and leaving it in place",
      read.detail
    );
    return () => {};
  }
  const journal = read.journal;
  if (
    journal.phase !== "backend_committed" ||
    (journal.commitBackend ?? "sqlite") !== args.backend
  ) {
    throw new Error("Database cutover is not ready for startup verification");
  }
  await args.verify(journal.verification);
  // Caller invokes this only after repository initialization succeeds.
  return () => {
    const current = readCutoverJournalStatus(args.userDataPath);
    if (
      current.status !== "ok" ||
      current.journal.operationId !== journal.operationId ||
      current.journal.phase !== "backend_committed"
    ) {
      throw new Error("Database cutover changed during startup verification");
    }
    advanceCutoverPhase(
      args.userDataPath,
      current.journal,
      "reopened_verified"
    );
    if (current.journal.pendingOutcome)
      args.emitOutcome(current.journal.pendingOutcome);
    clearCutoverJournal(args.userDataPath);
  };
}
