import { app, clipboard, dialog, shell } from "electron";
import { logger } from "../utils/logger";
import { database } from "./PGLiteDatabaseWorker";
import { stopPeriodicBackupTimer } from "./initialize";
import { AnalyticsService } from "../services/analytics/AnalyticsService";
import { buildDatabaseInitializationErrorProperties } from "./DatabaseErrorTelemetry";
import { findRestorableBackups } from "./sqlite/recoveryArtifacts";
import {
  writeCutoverJournal,
  readCutoverJournalStatus,
} from "./sqlite/cutoverJournal";
import {
  applyDatabaseFailureChoice,
  buildDatabaseFailureDialog,
  buildDatabaseFailureDiagnostics,
} from "./databaseFailureDialog";
import { mayTryAnotherCandidate, restoreFromNamedBackup } from "./recovery";
import { createCandidateProbe } from "./recovery/productionRecovery";
import {
  recordedPreMigrationSource,
  recoverPreMigrationDatabase,
  restoreWithCutoverJournalEvidence,
} from "./recovery/preMigrationRecovery";
import { resolveDatabaseUserDataPath } from "./userDataPath";

export async function showDatabaseStartupFailure(
  error: unknown
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Detect WASM runtime crash (PGLite uses WASM internally)
  // Note: 'Aborted' comes from worker.js when it detects RuntimeError or WASM abort
  const isWasmRuntimeCrash =
    errorMessage.includes("exit(1)") ||
    errorMessage.includes("Program terminated") ||
    errorMessage.includes("ExitStatus") ||
    errorMessage.includes("Aborted") ||
    errorMessage.includes("DATABASE_INIT_FAILED");

  // Which dialog the user gets must not depend on how the database failed.
  // The recovery dialog used to be reachable only through the WASM-crash
  // branch above, so the journaled-cutover hard stop -- the most serious
  // state there is, where the install's only real store sits at a
  // preserved path -- fell through to a bare showErrorBox and quit. Its
  // message says "Settings -> Database can restore it", which the user
  // cannot reach once the app has quit. If there is anything recoverable
  // on disk, say so and offer to reveal it, whatever the error was.
  // Same root the database and its backups actually live under, which is
  // not `app.getPath('userData')` when `NIMBALYST_USER_DATA_PATH` is set.
  const userDataPath = resolveDatabaseUserDataPath();
  const backups = findRestorableBackups(userDataPath);
  const rollbackSource = recordedPreMigrationSource(userDataPath);
  const canOfferRecovery =
    isWasmRuntimeCrash ||
    backups.length > 0 ||
    !!rollbackSource ||
    readCutoverJournalStatus(userDataPath).status !== "absent";

  // Send analytics about the failure. The detailed engine text stays in
  // the local log above -- init failures name the database path, which
  // carries the user's account name. PostHog gets fixed codes instead.
  try {
    const analytics = AnalyticsService.getInstance();
    const initializationError = buildDatabaseInitializationErrorProperties(
      error,
      database.getEngine()
    );
    analytics.sendEvent("known_error", {
      errorId: isWasmRuntimeCrash
        ? "pglite_wasm_runtime_crash"
        : "database_initialization_failed",
      context: "database_initialization",
      ...initializationError,
    });
  } catch {
    // Analytics failure shouldn't block error handling
  }

  // Show appropriate error dialog
  if (canOfferRecovery) {
    // This dialog used to end with "delete the database folder: <path>".
    // Users followed it, and because the project list lives in
    // electron-store rather than the database, the app came back up
    // looking healthy with every session and all document history gone
    // (#1347). Never instruct a delete: say what is recoverable, and
    // give the user a way to reach it.
    const content = buildDatabaseFailureDialog(backups, {
      rollbackSource,
      retryStartup: true,
      // The engine error names the database path, which carries the account
      // name. The copied diagnostics were already bounded codes; the text on
      // screen was the raw error.
      reason: errorMessage,
      userDataPath,
      diagnostics: buildDatabaseFailureDiagnostics({
        version: app.getVersion(),
        backend: database.getEngine(),
        error,
        cutover: (() => {
          const read = readCutoverJournalStatus(userDataPath);
          return read.status === "ok" ? read.journal : undefined;
        })(),
      }),
    });
    let dialogOutcome;
    do {
      const choice = dialog.showMessageBoxSync({
        type: "error",
        title: content.title,
        message: content.message,
        detail: content.detail,
        buttons: content.buttons,
        defaultId: content.defaultId,
        cancelId: content.cancelId,
        noLink: true,
      });

      // Resolve the click by the LABEL the user read, not by index. This
      // branch used to be `content.revealPath !== null && choice === 0`,
      // which was written when index 0 was "Show Backups"; once Restore
      // took that slot, the primary action of the dialog opened a Finder
      // window and quit (#1347).
      dialogOutcome = await applyDatabaseFailureChoice(content, choice, {
        retryStartup: () => {
          const read = readCutoverJournalStatus(userDataPath);
          if (read.status === "ok")
            writeCutoverJournal(userDataPath, {
              ...read.journal,
              reconcileAttempts: 0,
            });
        },
        copyDiagnostics: (text) => clipboard.writeText(text),
        rollback: async (source) => {
          await recoverPreMigrationDatabase({
            userDataPath,
            source,
            verify: createCandidateProbe(userDataPath),
            closeDatabase: async () => {
              stopPeriodicBackupTimer();
              await database.close();
            },
          });
          return { ok: true };
        },
        restore: async (candidate) => {
          logger.main.info("[Database] Restoring from the failure dialog", {
            name: candidate.name,
            bytes: candidate.bytes,
          });
          // A copy of the journal is preserved as evidence, the original
          // stays authoritative until the restore has replaced the live
          // store, and only a successful restore retires it. See the helper
          // for why neither order of rename-then-restore is safe.
          return restoreWithCutoverJournalEvidence(userDataPath, async () => {
            // The full recovery transaction: the copy is staged and
            // verified before the live database moves anywhere, the swap
            // is a rename, and the displaced database is kept.
            const outcome = await restoreFromNamedBackup({
              backupPath: candidate.path,
              backupName: candidate.name,
            });
            if (!outcome.ok) {
              logger.main.error("[Database] Restore failed", outcome);
              return {
                ok: false,
                message: outcome.message,
                // Whether the dialog may fall through to the next
                // copy. False once this attempt has moved something.
                canTryAnother: mayTryAnotherCandidate(outcome),
              };
            }
            logger.main.info("[Database] Restore succeeded", {
              indicators: outcome.indicators,
              displacedLivePath: outcome.artifacts.displacedLivePath,
            });
            return { ok: true };
          });
        },
        reveal: (revealPath) => {
          try {
            shell.showItemInFolder(revealPath);
          } catch (revealErr) {
            logger.main.warn(
              "[Database] Could not reveal backup folder",
              revealErr
            );
          }
        },
        onRestoreFailed: (message) => {
          dialog.showErrorBox("Nimbalyst - Restore Failed", message);
        },
      });
    } while (dialogOutcome.action === "diagnostics");

    if (dialogOutcome.restored) {
      // Initialization already failed in this process, so the rest of
      // startup never ran. Come back up cleanly on the restored
      // database rather than trying to resume from here.
      app.relaunch();
    }

    // NIM-3624: this dialog was previously invisible in telemetry, so
    // there was no way to see how many users it sent to delete their
    // database. Report that it was shown and what the user did.
    try {
      AnalyticsService.getInstance().sendEvent("database_init_failure_dialog", {
        backup_count: backups.length,
        largest_backup_bytes: backups.reduce(
          (max, b) => Math.max(max, b.bytes),
          0
        ),
        action: dialogOutcome.reportedAction,
      });
    } catch {
      // Analytics failure shouldn't block error handling
    }
  } else {
    dialog.showErrorBox(
      "Nimbalyst - Database Initialization Failed",
      `Failed to initialize the database system.\n\nError: ${errorMessage}\n\nNimbalyst cannot continue without the database.`
    );
  }
}
