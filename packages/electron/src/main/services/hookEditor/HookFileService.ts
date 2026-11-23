/**
 * The hook editor's work on disk for the three Claude Code settings files.
 * Each step follows a pure plan from shared/hookEditor/savePlan.ts: read
 * again, back up, write, read back, prune. Nothing here deletes or empties a
 * settings file.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

import { runChecks, type CheckResult } from '../../../shared/hookEditor/hookChecks';
import { openHookDocument, type PausedHook } from '../../../shared/hookEditor/hookDocument';
import {
  SAVE_CONFLICT_REASON,
  backupName,
  finishSave,
  planPrune,
  planRestore,
  planSave,
} from '../../../shared/hookEditor/savePlan';
import { writeFileAtomicSync } from '../../file/safeFileWrite';
import {
  backupFolder,
  backupTimeOf,
  isSettingsSource,
  pausedDuringWrite,
  resolveScriptPath,
  settingsFilePath,
  type SettingsSource,
} from './hookFiles';

export const KEPT_BACKUPS = 20;
export const READ_FAILED_REASON = 'Nimbalyst could not read the file, so it did nothing. Your file is unchanged.';
export const WRITE_FAILED_REASON = 'Nimbalyst could not write the file. If the file looks wrong, restore the backup.';
export const NOT_A_BACKUP_REASON = 'That is not a backup of this file.';
export const BACKUP_GONE_REASON = 'This backup is no longer there.';
export const RESTORE_CONFLICT_REASON = 'The file changed while Nimbalyst restored it. Nothing was restored. Try again.';

/** Where paused hooks are kept: app settings for the user file, workspace settings for the rest. */
export interface PausedStore {
  get(source: SettingsSource, workspacePath: string, filePath: string): PausedHook[];
  set(source: SettingsSource, workspacePath: string, filePath: string, hooks: PausedHook[]): void;
}

export interface HookFileDeps {
  /** <userData>/hook-editor/backups */
  backupRoot: string;
  /** settings.json in the Claude config folder. */
  userSettingsPath: string;
  homeDir: string;
  paused: PausedStore;
  now: () => Date;
}

export interface OpenedFile {
  filePath: string;
  exists: boolean;
  /** The text on disk, or '' when there is no file yet. */
  text: string;
  paused: PausedHook[];
}

export interface SaveRequest {
  source: SettingsSource;
  /** The text the tab opened, or the text of its last save. */
  openedText: string;
  newText: string;
  /** The tab's full paused list after this save. */
  paused: PausedHook[];
}

export type SaveResult =
  | { status: 'refused'; reason: string; checks: CheckResult[] }
  | { status: 'saved'; text: string; backupName: string | null; pruneWarning: string | null }
  | { status: 'failedOfferRestore'; reason: string; backupName: string | null };

export interface BackupInfo {
  name: string;
  /** When the backup was made, as an ISO time in UTC. */
  savedAt: string;
}

export type RestoreResult =
  | { status: 'refused'; reason: string }
  | { status: 'restored'; text: string; backupName: string | null; pruneWarning: string | null }
  | { status: 'failedOfferRestore'; reason: string; backupName: string | null };

export class HookFileService {
  /** One queue for each file, so two saves or restores of one file never run at once. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: HookFileDeps) {}

  async open(workspacePath: string, source: SettingsSource): Promise<OpenedFile> {
    const filePath = this.pathOf(workspacePath, source);
    const text = await readOrNull(filePath);
    return {
      filePath,
      exists: text !== null,
      text: text ?? '',
      paused: this.deps.paused.get(source, workspacePath, filePath),
    };
  }

  /** The Checks tab results, with each script path looked up on this disk. */
  check(workspacePath: string, source: SettingsSource, text: string): CheckResult[] {
    this.pathOf(workspacePath, source);
    // runChecks opens the text itself. The document only tells it the source.
    const empty = openHookDocument('', { source });
    if (!empty.ok) throw new Error('An empty settings file always opens.');
    const roots = { homeDir: this.deps.homeDir, projectDir: workspacePath };
    return runChecks({
      text,
      document: empty.document,
      scriptWrites: [],
      fileExists: (scriptPath) => fs.existsSync(resolveScriptPath(scriptPath, roots)),
    });
  }

  async save(workspacePath: string, request: SaveRequest): Promise<SaveResult> {
    assertSaveRequest(request);
    const filePath = this.pathOf(workspacePath, request.source);
    return this.queued(filePath, async (): Promise<SaveResult> => {
      const checks = this.check(workspacePath, request.source, request.newText);
      const facts = {
        openedText: request.openedText,
        newText: request.newText,
        scriptWrites: [],
        checksPassed: checks.every((result) => result.status !== 'failed'),
        target: 'settingsFile' as const,
      };
      let diskTextNow: string | null;
      try {
        diskTextNow = await readOrNull(filePath);
      } catch {
        return { status: 'refused', reason: READ_FAILED_REASON, checks };
      }

      // Only the tray changed, for example a paused hook that is also in the file was removed from the tray.
      // The text stays the same, so the plan below would answer "no changes". Store the tray and leave the file alone.
      const trayStored = this.deps.paused.get(request.source, workspacePath, filePath);
      if (request.newText === request.openedText && JSON.stringify(request.paused) !== JSON.stringify(trayStored)) {
        // Same rule as a normal save: the file on disk must still be the text the tab opened.
        if ((diskTextNow ?? '') !== request.openedText) return { status: 'refused', reason: SAVE_CONFLICT_REASON, checks };
        this.deps.paused.set(request.source, workspacePath, filePath, request.paused);
        return { status: 'saved', text: request.newText, backupName: null, pruneWarning: null };
      }

      let plan = planSave({ ...facts, diskTextNow, backupExists: null });
      let madeBackup: string | null = null;
      if (plan.action === 'backUpFirst' && diskTextNow !== null) {
        madeBackup = await this.backUp(filePath, diskTextNow);
        plan = planSave({ ...facts, diskTextNow, backupExists: madeBackup !== null });
      }
      if (plan.action === 'refuse') return { status: 'refused', reason: plan.reason, checks };
      if (plan.action !== 'writeSettingsFile') throw new Error(`A settings file save never plans ${plan.action}.`);
      // Another program can write between the first read and now. Look once more, right before the write.
      if (!(await stillHolds(filePath, diskTextNow))) return { status: 'refused', reason: SAVE_CONFLICT_REASON, checks };

      const { source } = request;
      const pausedBefore = this.deps.paused.get(source, workspacePath, filePath);
      this.deps.paused.set(source, workspacePath, filePath, pausedDuringWrite(pausedBefore, request.paused));
      let readBackMatches: boolean;
      try {
        readBackMatches = await replaceFile(filePath, plan.text);
      } catch {
        return { status: 'failedOfferRestore', reason: WRITE_FAILED_REASON, backupName: madeBackup };
      }
      if (readBackMatches) {
        try {
          this.deps.paused.set(source, workspacePath, filePath, request.paused);
        } catch {
          // The joined list stays. A hook that was turned back on also shows in the tray, and nothing is lost.
        }
      }
      const pruneFailed = readBackMatches && madeBackup !== null ? await this.prune(filePath, madeBackup) : false;
      const outcome = finishSave({ readBackMatches, pruneFailed });
      return outcome.status === 'saved'
        ? { status: 'saved', text: plan.text, backupName: madeBackup, pruneWarning: outcome.pruneWarning }
        : { status: 'failedOfferRestore', reason: outcome.reason, backupName: madeBackup };
    });
  }

  /** The backups of one file, newest first. */
  async listBackups(workspacePath: string, source: SettingsSource): Promise<BackupInfo[]> {
    const filePath = this.pathOf(workspacePath, source);
    let names: string[];
    try {
      names = await fsp.readdir(backupFolder(this.deps.backupRoot, filePath));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    // planPrune with no limit sorts the backups newest first and leaves other names out.
    return planPrune(names, path.basename(filePath), Number.POSITIVE_INFINITY).keep.map((name) => ({
      name,
      // Every name here matched the backup pattern, so it has a time.
      savedAt: backupTimeOf(name) as string,
    }));
  }

  /**
   * Puts a backup's text back into the file. The text it replaces becomes a
   * new backup first, so a restore can be undone too.
   */
  async restore(workspacePath: string, source: SettingsSource, name: string): Promise<RestoreResult> {
    const filePath = this.pathOf(workspacePath, source);
    return this.queued(filePath, async (): Promise<RestoreResult> => {
      // Only a plain name of this file's backup. No folders, no other file's backups.
      if (typeof name !== 'string' || path.basename(name) !== name || planPrune([name], path.basename(filePath)).keep.length !== 1) {
        return { status: 'refused', reason: NOT_A_BACKUP_REASON };
      }
      let backupText: string | null;
      let currentText: string | null;
      try {
        backupText = await readOrNull(path.join(backupFolder(this.deps.backupRoot, filePath), name));
        currentText = await readOrNull(filePath);
      } catch {
        return { status: 'refused', reason: READ_FAILED_REASON };
      }
      if (backupText === null) return { status: 'refused', reason: BACKUP_GONE_REASON };

      let plan = planRestore({ currentText, backupText, currentBackedUp: null });
      let madeBackup: string | null = null;
      if (plan.action === 'backUpCurrentFirst' && currentText !== null) {
        madeBackup = await this.backUp(filePath, currentText);
        plan = planRestore({ currentText, backupText, currentBackedUp: madeBackup !== null });
      }
      if (plan.action === 'refuse') return { status: 'refused', reason: plan.reason };
      if (plan.action !== 'restore') throw new Error(`A restore never plans ${plan.action} twice.`);
      if (!(await stillHolds(filePath, currentText))) return { status: 'refused', reason: RESTORE_CONFLICT_REASON };

      let readBackMatches: boolean;
      try {
        readBackMatches = await replaceFile(filePath, plan.text);
      } catch {
        return { status: 'failedOfferRestore', reason: WRITE_FAILED_REASON, backupName: madeBackup };
      }
      const pruneFailed = readBackMatches && madeBackup !== null ? await this.prune(filePath, madeBackup) : false;
      const outcome = finishSave({ readBackMatches, pruneFailed });
      return outcome.status === 'saved'
        ? { status: 'restored', text: plan.text, backupName: madeBackup, pruneWarning: outcome.pruneWarning }
        : { status: 'failedOfferRestore', reason: outcome.reason, backupName: madeBackup };
    });
  }

  private pathOf(workspacePath: string, source: SettingsSource): string {
    if (!workspacePath) throw new Error('workspacePath is required');
    if (!isSettingsSource(source)) throw new Error(`Unknown settings source: ${String(source)}`);
    return settingsFilePath(source, workspacePath, this.deps.userSettingsPath);
  }

  private queued<T>(filePath: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(filePath) ?? Promise.resolve();
    const next = previous.then(work);
    this.queues.set(
      filePath,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Writes a new backup of `text` and reads it back. Returns its name, or null when the backup is not sound. */
  private async backUp(filePath: string, text: string): Promise<string | null> {
    const folder = backupFolder(this.deps.backupRoot, filePath);
    try {
      await fsp.mkdir(folder, { recursive: true });
      const name = backupName(path.basename(filePath), this.deps.now(), await fsp.readdir(folder));
      const file = path.join(folder, name);
      // 'wx' refuses a name that is taken, so a backup never replaces another one.
      // Mode 0o600, because a settings file can hold tokens.
      const handle = await fsp.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return (await fsp.readFile(file, 'utf-8')) === text ? name : null;
    } catch {
      return null;
    }
  }

  /**
   * Removes backups beyond the newest 20. It never removes the backup that
   * this save made, even when the clock went back. True when a removal failed.
   */
  private async prune(filePath: string, madeBackup: string): Promise<boolean> {
    const folder = backupFolder(this.deps.backupRoot, filePath);
    try {
      const { remove } = planPrune(await fsp.readdir(folder), path.basename(filePath), KEPT_BACKUPS);
      let failed = false;
      for (const name of remove) {
        if (name === madeBackup) continue;
        await fsp.unlink(path.join(folder, name)).catch(() => {
          failed = true;
        });
      }
      return failed;
    } catch {
      return true;
    }
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** The file's text, or null when there is no file. Other read errors are thrown. */
async function readOrNull(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** True when the file still holds `expected` (null: still no file). */
async function stillHolds(filePath: string, expected: string | null): Promise<boolean> {
  try {
    return (await readOrNull(filePath)) === expected;
  } catch {
    return false;
  }
}

/** Writes the text without ever leaving the file cut short, then reads it back. True when the disk holds the text. */
async function replaceFile(filePath: string, text: string): Promise<boolean> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  writeFileAtomicSync(filePath, text);
  return (await readOrNull(filePath)) === text;
}

function assertSaveRequest(request: SaveRequest): void {
  const ok =
    typeof request === 'object' &&
    request !== null &&
    typeof request.openedText === 'string' &&
    typeof request.newText === 'string' &&
    Array.isArray(request.paused);
  if (!ok) throw new Error('The hook editor sent a save request without its texts and paused list.');
}
