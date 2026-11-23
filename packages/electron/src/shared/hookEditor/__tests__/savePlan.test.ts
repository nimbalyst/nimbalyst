// @vitest-environment node

/**
 * The save, prune and restore plans are pure: facts in, a plan out. Part 2
 * carries the plans out on disk. These tests pin every refusal, because each
 * one stands between the user's settings file and a lost edit.
 */

import { describe, expect, it } from 'vitest';

import {
  CHECKS_FAILED_REASON,
  EMPTY_TEXT_REASON,
  NOTHING_TO_SAVE_REASON,
  NO_BACKUP_REASON,
  NO_CURRENT_BACKUP_REASON,
  OTHER_SETTINGS_REASON,
  PRUNE_WARNING,
  READ_BACK_REASON,
  SAVE_CONFLICT_REASON,
  backupName,
  finishSave,
  planPrune,
  planRestore,
  planSave,
  type SaveFacts,
} from '../savePlan';

const OPENED = '{\n  "model": "opus"\n}\n';
const FACTS: SaveFacts = {
  openedText: OPENED,
  diskTextNow: OPENED,
  newText: '{\n  "model": "opus",\n  "hooks": {}\n}\n',
  scriptWrites: [],
  backupExists: true,
  checksPassed: true,
  target: 'settingsFile',
};

describe.skipIf(process.platform === 'win32')('save plan', () => {
  it('refuses a whitespace-only change on disk', () => {
    expect(planSave({ ...FACTS, diskTextNow: OPENED.replace('  "model"', '    "model"') })).toEqual({
      action: 'refuse',
      reason: SAVE_CONFLICT_REASON,
    });
  });

  it('refuses a settings save that changes anything outside "hooks", and ignores key order and layout', () => {
    const refuse = { action: 'refuse', reason: OTHER_SETTINGS_REASON };
    for (const newText of [
      '{ "model": "sonnet", "hooks": {} }',
      '{ "model": "opus", "env": { "A": "1" }, "hooks": {} }',
      '{ "hooks": {} }',
      '[]',
      '{ "model": ',
    ]) {
      expect(planSave({ ...FACTS, newText })).toEqual(refuse);
    }
    // Same values, other key order and layout: the save goes on to the backup step.
    expect(planSave({ ...FACTS, newText: '{ "hooks": { "Stop": [] }, "model": "opus" }', backupExists: null })).toEqual({
      action: 'backUpFirst',
    });
    // No file yet: the first save may hold "hooks" alone.
    expect(planSave({ ...FACTS, openedText: '', diskTextNow: null, newText: '{\n  "hooks": {}\n}\n' })).toEqual({
      action: 'writeSettingsFile',
      text: '{\n  "hooks": {}\n}\n',
    });
    // A hook pack draft is a different file and is not checked here.
    expect(planSave({ ...FACTS, newText: '{ "description": "x", "hooks": {} }', target: 'hookPackDraft' }).action).toBe(
      'writeDraftThenUpdateCard',
    );
  });

  it('refuses each unsafe save and plans both kinds of write', () => {
    const refuse = (reason: string) => ({ action: 'refuse', reason });
    expect(planSave({ ...FACTS, checksPassed: false })).toEqual(refuse(CHECKS_FAILED_REASON));
    expect(planSave({ ...FACTS, diskTextNow: null })).toEqual(refuse(SAVE_CONFLICT_REASON));
    expect(planSave({ ...FACTS, newText: OPENED })).toEqual(refuse(NOTHING_TO_SAVE_REASON));
    expect(planSave({ ...FACTS, newText: '' })).toEqual(refuse(EMPTY_TEXT_REASON));
    expect(planSave({ ...FACTS, backupExists: false })).toEqual(refuse(NO_BACKUP_REASON));
    expect(planSave(FACTS)).toEqual({ action: 'writeSettingsFile', text: FACTS.newText });
    // First pass: refusals that need no backup come out before any backup is made.
    expect(planSave({ ...FACTS, backupExists: null })).toEqual({ action: 'backUpFirst' });
    expect(planSave({ ...FACTS, backupExists: null, checksPassed: false })).toEqual(refuse(CHECKS_FAILED_REASON));
    expect(planSave({ ...FACTS, backupExists: null, newText: OPENED })).toEqual(refuse(NOTHING_TO_SAVE_REASON));
    // A new file has nothing on disk to back up.
    const hooksOnly = '{\n  "hooks": {}\n}\n';
    expect(planSave({ ...FACTS, openedText: '', diskTextNow: null, newText: hooksOnly, backupExists: null })).toEqual({
      action: 'writeSettingsFile',
      text: hooksOnly,
    });
    const scriptWrites = [{ path: 'hooks/then_stop_1.py', text: 'import sys\n' }];
    expect(planSave({ ...FACTS, target: 'hookPackDraft', newText: OPENED, scriptWrites })).toEqual({
      action: 'writeDraftThenUpdateCard',
      text: OPENED,
      scriptWrites,
    });
  });

  it('names, prunes and restores backups and never loses the newest', () => {
    const now = new Date(Date.UTC(2026, 9, 9, 14, 5, 7));
    const first = backupName('settings.json', now, []);
    expect(first).toBe('settings.json.2026-10-09_14-05-07-1.bak');
    expect(backupName('settings.json', now, [first])).toBe('settings.json.2026-10-09_14-05-07-2.bak');

    // 23 backups in one second: the counter sorts as a number, so 23 is the newest and 10 beats 9.
    const sameSecond = Array.from({ length: 23 }, (_, i) => `settings.json.2026-10-09_14-05-07-${i + 1}.bak`);
    const older = 'settings.json.2026-10-08_09-00-00-1.bak';
    const foreign = ['settings.local.json.2026-10-09_14-05-07-1.bak', 'notes.txt'];
    const plan = planPrune([older, ...foreign, ...sameSecond], 'settings.json');
    expect(plan.keep).toHaveLength(20);
    expect(plan.keep[0]).toBe('settings.json.2026-10-09_14-05-07-23.bak');
    expect(plan.remove).toEqual([
      'settings.json.2026-10-09_14-05-07-3.bak',
      'settings.json.2026-10-09_14-05-07-2.bak',
      'settings.json.2026-10-09_14-05-07-1.bak',
      older,
    ]);
    expect(planPrune(sameSecond, 'settings.json', 0).keep).toEqual(['settings.json.2026-10-09_14-05-07-23.bak']);

    expect(finishSave({ readBackMatches: true, pruneFailed: false })).toEqual({ status: 'saved', pruneWarning: null });
    expect(finishSave({ readBackMatches: true, pruneFailed: true })).toEqual({ status: 'saved', pruneWarning: PRUNE_WARNING });
    expect(finishSave({ readBackMatches: false, pruneFailed: false })).toEqual({
      status: 'failedOfferRestore',
      reason: READ_BACK_REASON,
    });

    const restore = (currentText: string | null, currentBackedUp: boolean | null) =>
      planRestore({ currentText, backupText: 'old', currentBackedUp });
    expect(restore('new', null)).toEqual({ action: 'backUpCurrentFirst' });
    expect(restore('new', true)).toEqual({ action: 'restore', text: 'old' });
    expect(restore('new', false)).toEqual({ action: 'refuse', reason: NO_CURRENT_BACKUP_REASON });
    expect(restore(null, null)).toEqual({ action: 'restore', text: 'old' });
    expect(restore('old', null).action).toBe('refuse');
  });
});
