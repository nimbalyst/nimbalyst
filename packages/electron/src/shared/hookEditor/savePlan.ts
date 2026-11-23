/**
 * Pure plans for save, backup names, pruning and restore. Each function takes
 * the facts and returns what to do, after the pattern in
 * packages/electron/src/main/database/pgliteInitRecovery.js. Part 2 carries
 * the plans out in the main process.
 */

import { isJsonObject, type JsonObject, type JsonValue } from './types';

export const CHECKS_FAILED_REASON = 'The checks failed. Fix the problems on the Checks tab, then save.';
export const SAVE_CONFLICT_REASON =
  'The file changed on disk after you opened it. Nothing was saved. Reload the file to see the new text.';
export const NOTHING_TO_SAVE_REASON = 'There are no changes to save.';
export const EMPTY_TEXT_REASON = 'Nimbalyst will not write an empty file over your settings. Nothing was saved.';
export const NO_BACKUP_REASON = 'Nimbalyst could not make a backup of the file, so it did not save.';
export const NO_CURRENT_BACKUP_REASON =
  'Nimbalyst could not back up the file as it is now, so it did not restore. Your file is unchanged.';
export const PRUNE_WARNING = 'Saved. Nimbalyst could not remove some old backups.';
export const READ_BACK_REASON = 'The file on disk does not match what Nimbalyst wrote. Restore the backup to undo the save.';
export const SAME_AS_BACKUP_REASON = 'The file already matches this backup.';
export const OTHER_SETTINGS_REASON =
  'This save would change settings outside "hooks". The hook editor only changes hooks, so nothing was saved.';

export interface SaveFacts {
  /** The text the tab opened, or the text of its last save. */
  openedText: string;
  /** The text on disk now, read again just before the save. Null when the file is gone. */
  diskTextNow: string | null;
  newText: string;
  scriptWrites: ReadonlyArray<{ path: string; text: string }>;
  /**
   * Null on the first pass, before any backup. True or false on the second
   * pass, once part 2 has tried to write the backup of the text on disk.
   */
  backupExists: boolean | null;
  checksPassed: boolean;
  target: 'settingsFile' | 'hookPackDraft';
}

export type SavePlan =
  | { action: 'refuse'; reason: string }
  | { action: 'backUpFirst' }
  | { action: 'writeSettingsFile'; text: string }
  | { action: 'writeDraftThenUpdateCard'; text: string; scriptWrites: ReadonlyArray<{ path: string; text: string }> };

/** The settings file without its "hooks" key, or null when the text is not one JSON object. Empty text is an empty file. */
function settingsOutsideHooks(text: string): JsonObject | null {
  let root: unknown;
  try {
    root = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return null;
  }
  if (!isJsonObject(root)) return null;
  const rest: JsonObject = { ...root };
  delete rest.hooks;
  return rest;
}

/** True when two JSON values hold the same data. Key order does not matter. */
function sameValue(a: JsonValue, b: JsonValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const names = Object.keys(a);
    return names.length === Object.keys(b).length && names.every((name) => name in b && sameValue(a[name], b[name]));
  }
  return a === b;
}

/** True when the new text keeps every setting outside "hooks" exactly as the opened text had it. */
export function onlyHooksChanged(openedText: string, newText: string): boolean {
  const before = settingsOutsideHooks(openedText);
  const after = settingsOutsideHooks(newText);
  return before !== null && after !== null && sameValue(before, after);
}

export function planSave(facts: SaveFacts): SavePlan {
  if (!facts.checksPassed) return { action: 'refuse', reason: CHECKS_FAILED_REASON };
  // Any change counts, whitespace included. A file that is gone counts as empty text.
  if ((facts.diskTextNow ?? '') !== facts.openedText) return { action: 'refuse', reason: SAVE_CONFLICT_REASON };
  if (facts.newText === facts.openedText && facts.scriptWrites.length === 0) {
    return { action: 'refuse', reason: NOTHING_TO_SAVE_REASON };
  }
  // The editor never writes empty text over a file that had content.
  if (facts.newText.trim() === '' && facts.openedText.trim() !== '') return { action: 'refuse', reason: EMPTY_TEXT_REASON };
  // The hook editor owns "hooks" only. A screen bug must never reach permissions, env or any other setting.
  if (facts.target === 'settingsFile' && !onlyHooksChanged(facts.openedText, facts.newText)) {
    return { action: 'refuse', reason: OTHER_SETTINGS_REASON };
  }
  // Every refusal above comes out before a backup is made, so a refused save leaves the backups alone.
  if (facts.diskTextNow !== null) {
    if (facts.backupExists === null) return { action: 'backUpFirst' };
    if (!facts.backupExists) return { action: 'refuse', reason: NO_BACKUP_REASON };
  }
  return facts.target === 'settingsFile'
    ? { action: 'writeSettingsFile', text: facts.newText }
    : { action: 'writeDraftThenUpdateCard', text: facts.newText, scriptWrites: facts.scriptWrites };
}

/** The time stamp in a backup name, in UTC, to the second: 2026-10-09_14-05-07. */
function stamp(now: Date): string {
  return now.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
}

/** A backup name that no existing backup has: <file>.<stamp>-<n>.bak, with n counting up from 1. */
export function backupName(fileName: string, now: Date, existing: readonly string[]): string {
  const taken = new Set(existing);
  for (let n = 1; ; n += 1) {
    const name = `${fileName}.${stamp(now)}-${n}.bak`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Which backups of one file to keep: the newest `keep`, and never fewer than
 * one. Names that are not backups of this file are left alone.
 */
export function planPrune(names: readonly string[], fileName: string, keep = 20): { keep: string[]; remove: string[] } {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\.(\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2})-(\\d+)\\.bak$`);
  const backups = names
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
    .sort((a, b) =>
      a.match[1] === b.match[1] ? Number(b.match[2]) - Number(a.match[2]) : a.match[1] < b.match[1] ? 1 : -1,
    )
    .map((item) => item.name);
  const count = Math.max(keep, 1);
  return { keep: backups.slice(0, count), remove: backups.slice(count) };
}

export type SaveOutcome = { status: 'saved'; pruneWarning: string | null } | { status: 'failedOfferRestore'; reason: string };

/** A prune failure is not a save failure. A read-back mismatch is, and the backup is the way back. */
export function finishSave(facts: { readBackMatches: boolean; pruneFailed: boolean }): SaveOutcome {
  if (!facts.readBackMatches) return { status: 'failedOfferRestore', reason: READ_BACK_REASON };
  return { status: 'saved', pruneWarning: facts.pruneFailed ? PRUNE_WARNING : null };
}

export type RestorePlan = { action: 'refuse'; reason: string } | { action: 'backUpCurrentFirst' } | { action: 'restore'; text: string };

/**
 * A restore first backs up the text it replaces, so a restore can be undone
 * too. `currentBackedUp` is null on the first pass, then true or false once
 * part 2 has tried that backup. A restore never writes over text that has no backup.
 */
export function planRestore(facts: {
  currentText: string | null;
  backupText: string;
  currentBackedUp: boolean | null;
}): RestorePlan {
  if (facts.currentText === facts.backupText) return { action: 'refuse', reason: SAME_AS_BACKUP_REASON };
  if (facts.currentText !== null) {
    if (facts.currentBackedUp === null) return { action: 'backUpCurrentFirst' };
    if (!facts.currentBackedUp) return { action: 'refuse', reason: NO_CURRENT_BACKUP_REASON };
  }
  return { action: 'restore', text: facts.backupText };
}
