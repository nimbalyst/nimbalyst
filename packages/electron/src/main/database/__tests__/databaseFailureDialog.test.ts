// @vitest-environment node
import { describe, expect, it, vi, type Mock } from 'vitest';
import * as os from 'os';
import {
  actionForChoice,
  applyDatabaseFailureChoice,
  buildDatabaseFailureDialog,
  buildDatabaseFailureDiagnostics,
  type DatabaseFailureDialogHandlers,
} from '../databaseFailureDialog';
import type { RestorableBackup } from '../sqlite/recoveryArtifacts';

const backup = (name: string, bytes: number): RestorableBackup => ({
  name,
  bytes,
  path: `/Users/someone/Library/Application Support/@nimbalyst/electron/db-backups/${name}`,
});

describe('buildDatabaseFailureDialog', () => {
  it('copies diagnostics without restoring and offers an explicit startup retry', async () => {
    const content = buildDatabaseFailureDialog([], { diagnostics: 'local failure details', retryStartup: true });
    const handlers = { restore: vi.fn(), reveal: vi.fn(), copyDiagnostics: vi.fn(), retryStartup: vi.fn() };
    expect(content.buttons[content.cancelId]).toBe('Quit');
    const copied = await applyDatabaseFailureChoice(content, content.buttons.indexOf('Copy diagnostics'), handlers);
    expect(copied).toMatchObject({ reportedAction: 'copy_diagnostics', restored: false });
    expect(handlers.copyDiagnostics).toHaveBeenCalledWith('local failure details');
    expect(handlers.restore).not.toHaveBeenCalled();
    const retried = await applyDatabaseFailureChoice(content, content.buttons.indexOf('Retry startup'), handlers);
    expect(retried).toMatchObject({ reportedAction: 'retry_startup', restored: true });
    expect(handlers.retryStartup).toHaveBeenCalledOnce();
  });

  it('offers the recorded pre-migration source as an explicit rollback choice', async () => {
    const rollbackSource = backup('pglite-db.migrated-recorded', 5000);
    const content = buildDatabaseFailureDialog([], { rollbackSource });
    const rollback = vi.fn(async () => ({ ok: true }));
    const restore = vi.fn(async () => ({ ok: true }));
    const outcome = await applyDatabaseFailureChoice(content, content.buttons.indexOf('Restore pre-migration database'), {
      restore, rollback, reveal: vi.fn(),
    });
    expect(rollback).toHaveBeenCalledWith(rollbackSource);
    expect(restore).not.toHaveBeenCalled();
    expect(outcome.restored).toBe(true);
  });
  // The regression that cost users their history. The old dialog ended with
  // "delete the database folder: <path>", people followed it, and the app came
  // back up looking healthy with every session gone. This must never return.
  it('never instructs the user to remove their data', () => {
    for (const backups of [[], [backup('pglite-db.backup-current', 5_000_000)]]) {
      const { detail, message } = buildDatabaseFailureDialog(backups);
      const text = `${message}\n${detail}`.toLowerCase();
      for (const phrase of ['delete the database', 'remove the database folder:', 'rm -rf']) {
        expect(text).not.toContain(phrase);
      }
      expect(text).toContain('do not remove the database folder');
    }
  });

  it('names each recoverable copy with its size', () => {
    const { detail } = buildDatabaseFailureDialog([
      backup('pglite-db.backup-current', 274 * 1024 * 1024),
      backup('pglite-db.backup-2026-08-20T11-00-00-000Z', 1536 * 1024 * 1024),
    ]);
    expect(detail).toContain('pglite-db.backup-current (274 MB)');
    expect(detail).toContain('pglite-db.backup-2026-08-20T11-00-00-000Z (1.5 GB)');
    expect(detail).toContain('Backup copies were found');
    expect(detail).not.toContain('Your data has not been lost');
  });

  // Promising recoverable data that isn't there would be its own cruelty, and
  // a Show Backups button with nothing behind it is a dead end.
  it('promises nothing and offers only Quit when no backup exists', () => {
    const content = buildDatabaseFailureDialog([]);
    expect(content.detail).not.toContain('Your data has not been lost');
    expect(content.buttons).toEqual(['Quit']);
    expect(content.revealPath).toBeNull();
    expect(content.cancelId).toBe(0);
  });

  // Escape must land on Quit, never on a destructive default.
  it('makes restore the primary action and keeps reveal and quit reachable', () => {
    const best = backup('pglite-db.backup-current', 900);
    const content = buildDatabaseFailureDialog([best, backup('pglite-db.backup-previous', 800)]);

    expect(content.buttons[content.defaultId]).toBe('Restore Backup');
    expect(content.restoreCandidates[0].path).toBe(best.path);
    expect(content.buttons[content.cancelId]).toBe('Quit');
  });

  /**
   * Ordering here is a safety property, not presentation. Index 0 is the slot
   * the platform paints as primary and `defaultId` is what Enter hits, and the
   * pre-migration rollback is the one action in this dialog that leaves the
   * user without everything they saved since the switch. It may hold neither
   * slot, whichever combination of buttons the failure happens to offer.
   */
  it('never puts the pre-migration rollback first or under Enter', () => {
    const rollbackSource = backup('pglite-db.migrated-recorded', 5000);
    const withBackup = [backup('pglite-db.backup-current', 900)];
    for (const content of [
      buildDatabaseFailureDialog(withBackup, { rollbackSource, retryStartup: true, diagnostics: 'd' }),
      buildDatabaseFailureDialog(withBackup, { rollbackSource }),
      buildDatabaseFailureDialog([], { rollbackSource, diagnostics: 'd' }),
      buildDatabaseFailureDialog([], { rollbackSource }),
    ]) {
      expect(content.buttons[0]).not.toBe('Restore pre-migration database');
      expect(content.buttons[content.defaultId]).not.toBe('Restore pre-migration database');
      expect(content.buttons[content.cancelId]).toBe('Quit');
      // Label-based dispatch has to survive the reordering.
      expect(actionForChoice(content, content.buttons.indexOf('Restore pre-migration database'))).toBe('rollback');
    }
  });

  it('defaults to retrying startup, and to Restore Backup when retry is not offered', () => {
    const rollbackSource = backup('pglite-db.migrated-recorded', 5000);
    const backups = [backup('pglite-db.backup-current', 900)];

    const withRetry = buildDatabaseFailureDialog(backups, { rollbackSource, retryStartup: true, diagnostics: 'd' });
    expect(withRetry.buttons[0]).toBe('Retry startup');
    expect(withRetry.buttons[withRetry.defaultId]).toBe('Retry startup');

    const withoutRetry = buildDatabaseFailureDialog(backups, { rollbackSource, diagnostics: 'd' });
    expect(withoutRetry.buttons[withoutRetry.defaultId]).toBe('Restore Backup');
    expect(withoutRetry.buttons.indexOf('Restore Backup'))
      .toBeLessThan(withoutRetry.buttons.indexOf('Restore pre-migration database'));
  });

  // Rolling back is not "restore my data": it is "go back to the older copy
  // and leave everything since behind". Saying so is the whole point.
  it('says plainly what rolling back to the pre-migration database costs', () => {
    const { detail } = buildDatabaseFailureDialog([], {
      rollbackSource: backup('pglite-db.migrated-recorded', 5000),
    });
    expect(detail).toContain('pglite-db.migrated-recorded');
    const text = detail.toLowerCase();
    expect(text).toContain('before the switch');
    expect(text).toContain('will not be in it');
    expect(text).toContain('kept on disk');
  });

  // The copied diagnostics were already redacted; the text on screen was not,
  // and an init failure names the database path, which carries the account
  // name. A user photographing this dialog for support should not be
  // publishing their own name with it.
  it('keeps the account name out of the on-screen reason', () => {
    const userDataPath = '/Users/someone/Library/Application Support/@nimbalyst/electron';
    const { detail } = buildDatabaseFailureDialog([], {
      userDataPath,
      reason: `DATABASE_INIT_FAILED: could not open ${userDataPath}/pglite-db, nor ${os.homedir()}/scratch`,
    });
    expect(detail).toContain('DATABASE_INIT_FAILED');
    expect(detail).not.toContain('/Users/someone');
    expect(detail).not.toContain(os.homedir());
  });
});

/**
 * What the button actually does.
 *
 * The dialog builder was fully covered and entirely beside the point: it named
 * button 0 "Restore Backup" while the production caller in `index.ts` still ran
 * the pre-change `choice === 0` branch, which reveals and quits. Restore had
 * zero production callers and the suite was green. These drive the function
 * `index.ts` now calls, so a regression to reveal-on-restore fails here.
 */
describe('applyDatabaseFailureChoice', () => {
  const content = () =>
    buildDatabaseFailureDialog([
      backup('pglite-db.backup-current', 900),
      backup('pglite-db.backup-previous', 800),
    ]);

  const handlers = (
    restore: DatabaseFailureDialogHandlers['restore'],
  ): DatabaseFailureDialogHandlers & { reveal: Mock<(revealPath: string) => void> } => ({
    restore,
    reveal: vi.fn<(revealPath: string) => void>(),
    onRestoreFailed: vi.fn<(message: string) => void>(),
  });

  it('restores from the named backup when the user picks Restore', async () => {
    const restore = vi.fn().mockResolvedValue({ ok: true });
    const h = handlers(restore);
    const c = content();

    const outcome = await applyDatabaseFailureChoice(c, c.buttons.indexOf('Restore Backup'), h);

    expect(restore).toHaveBeenCalledWith(c.restoreCandidates[0]);
    expect(h.reveal).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      action: 'restore',
      reportedAction: 'restore_succeeded',
      restored: true,
    });
  });

  /**
   * The dialog restores and then quits, so whichever copy it picks first is
   * the only copy that install ever gets offered -- on this launch and on
   * every one after it. `current` being a small valid copy of nothing while
   * `previous` holds the history is #1347's exact shape, so refusing to look
   * past a pre-swap failure made the dialog permanently unable to recover the
   * population it exists for.
   */
  it('falls through to the next copy when a pre-swap check rejects the first', async () => {
    const restore = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'candidate was empty', canTryAnother: true })
      .mockResolvedValueOnce({ ok: true });
    const h = handlers(restore);
    const c = content();

    const outcome = await applyDatabaseFailureChoice(c, c.buttons.indexOf('Restore Backup'), h);

    expect(restore.mock.calls.map(([candidate]) => candidate.name)).toEqual([
      'pglite-db.backup-current',
      'pglite-db.backup-previous',
    ]);
    expect(outcome).toMatchObject({ reportedAction: 'restore_succeeded', restored: true });
  });

  /**
   * The other half of that rule. Once an attempt has moved something, the next
   * attempt's journal write would erase the record of where the displaced
   * database went -- so the sweep stops even though a second copy is sitting
   * right there. See `mayTryAnotherCandidate`.
   */
  it('stops after an attempt that left recovery state behind', async () => {
    const restore = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'swap failed', canTryAnother: false })
      .mockResolvedValueOnce({ ok: true });
    const h = handlers(restore);
    const c = content();

    const outcome = await applyDatabaseFailureChoice(c, c.buttons.indexOf('Restore Backup'), h);

    expect(restore).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ reportedAction: 'restore_failed', restored: false });
  });

  it('surfaces a failed restore and does not tell the caller to relaunch', async () => {
    const h = handlers(vi.fn().mockResolvedValue({ ok: false, message: 'candidate was empty' }));
    const c = content();

    const outcome = await applyDatabaseFailureChoice(c, c.buttons.indexOf('Restore Backup'), h);

    expect(outcome).toMatchObject({ reportedAction: 'restore_failed', restored: false });
    const shown = (h.onRestoreFailed as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(shown).toContain('candidate was empty');
    // The one promise this dialog must never break.
    expect(shown).toContain('Nothing was removed');
  });

  it('treats a thrown restore as a failure rather than letting it escape', async () => {
    const h = handlers(vi.fn().mockRejectedValue(new Error('worker bundle missing')));
    const c = content();
    const outcome = await applyDatabaseFailureChoice(c, c.buttons.indexOf('Restore Backup'), h);
    expect(outcome).toMatchObject({ reportedAction: 'restore_failed', restored: false });
  });

  it('reveals rather than restoring when the user picks Show Backups', async () => {
    const restore = vi.fn();
    const h = handlers(restore);
    const c = content();

    const outcome = await applyDatabaseFailureChoice(c, c.buttons.indexOf('Show Backups'), h);

    expect(restore).not.toHaveBeenCalled();
    expect(h.reveal).toHaveBeenCalledWith(c.revealPath);
    expect(outcome.reportedAction).toBe('show_backups');
  });

  it('does nothing on Quit, on a dismissed dialog, or when there is no backup', async () => {
    const restore = vi.fn();
    const c = content();
    for (const choice of [c.buttons.indexOf('Quit'), -1]) {
      const h = handlers(restore);
      const outcome = await applyDatabaseFailureChoice(c, choice, h);
      expect(outcome).toEqual({ action: 'quit', reportedAction: 'quit', restored: false });
      expect(h.reveal).not.toHaveBeenCalled();
    }
    expect(restore).not.toHaveBeenCalled();

    const empty = buildDatabaseFailureDialog([]);
    const h = handlers(restore);
    expect(await applyDatabaseFailureChoice(empty, 0, h)).toMatchObject({ action: 'quit' });
    expect(restore).not.toHaveBeenCalled();
  });
});


it('keeps account paths and raw error text out of copied diagnostics', () => {
  const diagnostics = buildDatabaseFailureDiagnostics({ version: 'test', backend: 'sqlite', error: new Error('Failed to open /Users/private-account/secret-project.sqlite') });
  expect(diagnostics).not.toContain('private-account');
  expect(diagnostics).not.toContain('secret-project');
  expect(JSON.parse(diagnostics)).toMatchObject({ version: 'test', backend: 'sqlite' });
});
