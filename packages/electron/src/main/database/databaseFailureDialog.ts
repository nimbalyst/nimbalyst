/**
 * Wording for the dialog shown when the database will not start.
 *
 * Pure and separate from `index.ts` for one reason: this text is safety-
 * critical and must be assertable. The previous version ended with
 *
 *     3. If the problem persists, delete the database folder:
 *        <path>
 *
 * Users followed it. Because the project list lives in electron-store rather
 * than in the database, the app then came back up looking healthy with every
 * session and all document history gone, so the instruction did not even look
 * like it had done damage (#1347).
 *
 * The invariant the tests hold: this dialog never tells anyone to delete their
 * data, and it only promises recoverable data when some actually exists.
 */

import type { RestorableBackup } from './sqlite/recoveryArtifacts';
import { formatBytes } from './sqlite/recoveryArtifacts';

export interface DatabaseFailureDialogContent {
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  /**
   * Backup to reveal if the user picks Show Backups, or `null` when there is
   * nothing to show and the only button is Quit.
   */
  revealPath: string | null;
  /**
   * The copies the primary Restore button may act on, richest first, and empty
   * when there is nothing to restore from.
   *
   * A list rather than a single entry because this used to be `backups[0]` in
   * slot order. If `current` was a small valid copy of nothing and `previous`
   * held the user's history, Restore picked the unusable one, failed, and quit
   * — and picked the same one on every launch afterwards, forever. The backup
   * services already fall through to the next copy on a pre-swap failure; the
   * dialog is the surface where not doing so is permanent.
   *
   * Restoring goes through the recovery transaction, which verifies the copy
   * and keeps the displaced database — see
   * `database/recovery/recoveryTransaction.ts`.
   */
  restoreCandidates: RestorableBackup[];
}

export function buildDatabaseFailureDialog(
  backups: RestorableBackup[],
): DatabaseFailureDialogContent {
  const hasBackups = backups.length > 0;

  const recovery = hasBackups
    ? `Your data has not been lost. These copies are on this computer right now:\n\n` +
      backups.map((b) => `   - ${b.name} (${formatBytes(b.bytes)})`).join('\n') +
      `\n\nDo not remove the database folder -- these backups are what it would be restored from.\n\n` +
      `Restore Backup starts with the copy holding the most, and tries the next one if that copy ` +
      `does not check out. It keeps the current database alongside, so nothing on this computer ` +
      `is removed either way.\n\n`
    : `Do not remove the database folder. Support can often recover a database that will not start.\n\n`;

  const steps = hasBackups
    ? `If you would rather not restore yet:\n` +
      `1. Close any other Nimbalyst windows and open it again\n` +
      `2. Restart your computer, which clears stale database locks\n` +
      `3. Show Backups reveals the copies above without changing anything\n\n`
    : `Things to try, in order:\n` +
      `1. Close any other Nimbalyst windows and open it again\n` +
      `2. Restart your computer, which clears stale database locks\n` +
      `3. If it still will not start, contact support before changing anything on disk\n\n`;

  return {
    title: 'Nimbalyst - Database Initialization Failed',
    message: 'The database could not be started.',
    detail: recovery + steps + `Nimbalyst will close if you quit.`,
    // Restore is the action this dialog exists for. Listing the backups was
    // the fix for "delete the database folder"; it still left the user reading
    // that their data was safe with no way to reach it (#1347).
    buttons: hasBackups ? ['Restore Backup', 'Show Backups', 'Quit'] : ['Quit'],
    defaultId: 0,
    // Escape lands on Quit, never on an action that touches the database.
    cancelId: hasBackups ? 2 : 0,
    // `findRestorableBackups` returns richest-first, so this is the copy the
    // Restore button starts with and the one Show Backups reveals.
    revealPath: hasBackups ? backups[0].path : null,
    restoreCandidates: backups,
  };
}

export type DatabaseFailureDialogAction = 'restore' | 'reveal' | 'quit';

/**
 * What the button index the user picked actually means. Kept next to the
 * button list so adding a button cannot silently re-point the caller's
 * `choice === 0` at a different action — which is exactly the sort of
 * off-by-one that turns "Show Backups" into something destructive.
 */
export function actionForChoice(
  content: DatabaseFailureDialogContent,
  choice: number,
): DatabaseFailureDialogAction {
  switch (content.buttons[choice]) {
    case 'Restore Backup':
      return 'restore';
    case 'Show Backups':
      return 'reveal';
    default:
      return 'quit';
  }
}

export interface DatabaseFailureRestoreResult {
  ok: boolean;
  /** Shown to the user on failure. Never sent to analytics. */
  message?: string;
  /**
   * Whether the next copy may be tried. False once the attempt has left
   * recovery state that startup has to resolve first — see
   * `mayTryAnotherCandidate`. Defaults to true, because the failures that
   * cannot be followed by another attempt are the ones a caller has to opt
   * into reporting; a caller that says nothing has not moved anything.
   */
  canTryAnother?: boolean;
}

export interface DatabaseFailureDialogHandlers {
  restore(candidate: RestorableBackup): Promise<DatabaseFailureRestoreResult>;
  reveal(revealPath: string): void;
  /** Called with the text to put in front of the user when a restore fails. */
  onRestoreFailed?(message: string): void;
}

export interface DatabaseFailureChoiceOutcome {
  action: DatabaseFailureDialogAction;
  /** Bounded analytics value; one of a fixed set. */
  reportedAction: 'restore_succeeded' | 'restore_failed' | 'show_backups' | 'quit';
  /** True when the app should relaunch onto the restored database. */
  restored: boolean;
}

/**
 * Carry out whatever the user picked.
 *
 * This lives here rather than inline in `index.ts` because the branch it
 * replaces was the bug: `index.ts` kept reading `content.revealPath !== null &&
 * choice === 0` after the button list grew a Restore entry at index 0, so the
 * primary action of the dialog performed a reveal and quit. `actionForChoice`
 * existed and was tested and had no production caller. Putting the decision and
 * its consequences in one testable function is what stops that recurring: a
 * test here fails if Restore stops restoring, whereas a test of the button
 * labels alone passed happily throughout.
 */
export async function applyDatabaseFailureChoice(
  content: DatabaseFailureDialogContent,
  choice: number,
  handlers: DatabaseFailureDialogHandlers,
): Promise<DatabaseFailureChoiceOutcome> {
  const action = actionForChoice(content, choice);

  if (action === 'restore' && content.restoreCandidates.length > 0) {
    const failures: string[] = [];
    for (const candidate of content.restoreCandidates) {
      let result: DatabaseFailureRestoreResult;
      try {
        result = await handlers.restore(candidate);
      } catch (err) {
        result = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) return { action, reportedAction: 'restore_succeeded', restored: true };
      failures.push(`${candidate.name}: ${result.message ?? 'the restore did not complete'}`);
      // Same rule as the backup sweeps: once an attempt has moved something,
      // trying the next copy would write over the record of where it went.
      if (result.canTryAnother === false) break;
    }
    handlers.onRestoreFailed?.(
      `${failures.join('\n')}\n\nNothing was removed. Every copy of your database is still on `
      + 'this computer.',
    );
    return { action, reportedAction: 'restore_failed', restored: false };
  }

  if (action === 'reveal' && content.revealPath !== null) {
    handlers.reveal(content.revealPath);
    return { action, reportedAction: 'show_backups', restored: false };
  }

  return { action: 'quit', reportedAction: 'quit', restored: false };
}
