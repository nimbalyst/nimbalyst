// @vitest-environment node

/**
 * The hook editor's file work on a real disk: save with a backup first,
 * refusals that write nothing, pruning, paused hooks, restore, and a second
 * launch that still finds every backup. Each test gets fresh temp folders.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PausedHook } from '../../../../shared/hookEditor/hookDocument';
import {
  CHECKS_FAILED_REASON,
  NO_BACKUP_REASON,
  NOTHING_TO_SAVE_REASON,
  PRUNE_WARNING,
  SAME_AS_BACKUP_REASON,
  SAVE_CONFLICT_REASON,
} from '../../../../shared/hookEditor/savePlan';
import {
  BACKUP_GONE_REASON,
  HookFileService,
  NOT_A_BACKUP_REASON,
  WRITE_FAILED_REASON,
  type HookFileDeps,
  type PausedStore,
} from '../HookFileService';
import { backupFolder } from '../hookFiles';

let root: string;
let home: string;
let project: string;
let userFile: string;
let clock: number;
let pausedLists: Map<string, PausedHook[]>;

/** Folders under one temp root. The paused lists outlive any one service, as the stores do. */
function deps(): HookFileDeps {
  const paused: PausedStore = {
    get: (_source, _workspacePath, filePath) => structuredClone(pausedLists.get(filePath) ?? []),
    set: (_source, _workspacePath, filePath, hooks) => void pausedLists.set(filePath, structuredClone(hooks)),
  };
  return {
    backupRoot: path.join(root, 'userData', 'hook-editor', 'backups'),
    userSettingsPath: userFile,
    homeDir: home,
    paused,
    // Each call is one second later, so backup names sort in save order.
    now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, clock++)),
  };
}

function stop(prompt: string): string {
  return `${JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt }] }] } }, null, 2)}\n`;
}

function backupsOf(filePath: string): string[] {
  const folder = backupFolder(deps().backupRoot, filePath);
  return fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [];
}

function backupText(filePath: string, name: string): string {
  return fs.readFileSync(path.join(backupFolder(deps().backupRoot, filePath), name), 'utf-8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-hook-files-'));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  userFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  clock = 0;
  pausedLists = new Map();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('hook file service: save', () => {
  it('saves after a backup of the text on disk, and makes a missing folder and file', async () => {
    const service = new HookFileService(deps());
    fs.writeFileSync(userFile, stop('Done?'));
    const opened = await service.open(project, 'userSettings');
    expect(opened).toEqual({ filePath: userFile, exists: true, text: stop('Done?'), paused: [] });

    const result = await service.save(project, {
      source: 'userSettings',
      openedText: opened.text,
      newText: stop('Finished?'),
      paused: [],
    });
    expect(result).toMatchObject({ status: 'saved', text: stop('Finished?'), pruneWarning: null });
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(stop('Finished?'));
    const [backup] = backupsOf(userFile);
    expect(result.status === 'saved' && result.backupName).toBe(backup);
    expect(backupText(userFile, backup)).toBe(stop('Done?'));
    // A backup can hold tokens from "env", so only the user can read it.
    expect(fs.statSync(path.join(backupFolder(deps().backupRoot, userFile), backup)).mode & 0o777).toBe(0o600);
    // Backups live under userData, never beside the file.
    expect(fs.readdirSync(path.dirname(userFile))).toEqual(['settings.json']);

    // No .claude folder and no file yet: the save makes both, with nothing to back up.
    fs.rmSync(path.join(project, '.claude'), { recursive: true });
    expect(await service.open(project, 'projectSettings')).toMatchObject({ exists: false, text: '' });
    // A first save may hold "hooks" alone, so this text leaves out the "model" key that stop() adds.
    const hooksOnly = `${JSON.stringify({ hooks: JSON.parse(stop('New?')).hooks }, null, 2)}\n`;
    const created = await service.save(project, { source: 'projectSettings', openedText: '', newText: hooksOnly, paused: [] });
    expect(created).toMatchObject({ status: 'saved', backupName: null });
    expect(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf-8')).toBe(hooksOnly);
  });

  it('refuses a conflict and a failed check before any backup, then refuses when no backup can be made', async () => {
    const service = new HookFileService(deps());
    fs.writeFileSync(userFile, stop('Done?'));
    const save = (openedText: string, newText: string) =>
      service.save(project, { source: 'userSettings', openedText, newText, paused: [] });

    // Another program took out one space after the tab opened.
    const changed = stop('Done?').replace('  "model"', ' "model"');
    expect(await save(changed, stop('Finished?'))).toMatchObject({ status: 'refused', reason: SAVE_CONFLICT_REASON });
    expect(await save(stop('Done?'), '{ "hooks": ')).toMatchObject({ status: 'refused', reason: CHECKS_FAILED_REASON });

    // The script check looks on this disk: ~ is the home folder, $CLAUDE_PROJECT_DIR is the project.
    const userScript = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/gate.py' }] }] },
    });
    expect(await save(stop('Done?'), userScript)).toMatchObject({ status: 'refused', reason: CHECKS_FAILED_REASON });
    expect(backupsOf(userFile)).toEqual([]);
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(stop('Done?'));
    fs.mkdirSync(path.join(home, '.claude', 'hooks'));
    fs.writeFileSync(path.join(home, '.claude', 'hooks', 'gate.py'), '');
    expect(service.check(project, 'userSettings', userScript).map((result) => result.status)).toEqual(['passed', 'passed', 'passed']);
    const projectScript = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/lint.sh' }] }] },
    });
    expect(service.check(project, 'projectSettings', projectScript).map((result) => result.status)).toEqual(['passed', 'passed', 'failed']);
    fs.mkdirSync(path.join(project, '.claude', 'hooks'));
    fs.writeFileSync(path.join(project, '.claude', 'hooks', 'lint.sh'), '');
    expect(service.check(project, 'projectSettings', projectScript).map((result) => result.status)).toEqual(['passed', 'passed', 'passed']);

    // The backup folder cannot be made, so the save stops and the file stays as it was.
    fs.mkdirSync(path.join(root, 'userData', 'hook-editor'), { recursive: true });
    fs.writeFileSync(path.join(root, 'userData', 'hook-editor', 'backups'), 'not a folder');
    expect(await save(stop('Done?'), stop('Finished?'))).toMatchObject({ status: 'refused', reason: NO_BACKUP_REASON });
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(stop('Done?'));
  });

  it('prunes to the 20 newest backups, keeps the one it made, and still saves when pruning fails', async () => {
    const service = new HookFileService(deps());
    let text = stop('0');
    fs.writeFileSync(userFile, text);
    for (let i = 1; i <= 22; i += 1) {
      const result = await service.save(project, { source: 'userSettings', openedText: text, newText: stop(String(i)), paused: [] });
      expect(result.status).toBe('saved');
      text = stop(String(i));
    }
    const kept = backupsOf(userFile);
    expect(kept).toHaveLength(20);
    expect(backupText(userFile, kept[0])).toBe(stop('2'));
    expect(backupText(userFile, kept[19])).toBe(stop('21'));

    // An old backup that cannot be removed: a folder under a backup's name.
    fs.mkdirSync(path.join(backupFolder(deps().backupRoot, userFile), 'settings.json.2000-01-01_00-00-00-1.bak'));
    const blocked = await service.save(project, { source: 'userSettings', openedText: text, newText: stop('last'), paused: [] });
    expect(blocked).toMatchObject({ status: 'saved', pruneWarning: PRUNE_WARNING });
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(stop('last'));

    // The clock went back a year. The new backup sorts oldest by name, and it still stays.
    const behind = new HookFileService({ ...deps(), now: () => new Date(Date.UTC(2025, 9, 9)) });
    const late = await behind.save(project, { source: 'userSettings', openedText: stop('last'), newText: stop('after'), paused: [] });
    expect(late.status === 'saved' && backupsOf(userFile).includes(late.backupName ?? '')).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)('keeps a paused hook in the tray or the file whether or not the write lands', async () => {
    const service = new HookFileService(deps());
    const withHook = stop('Done?');
    const without = `${JSON.stringify({ model: 'opus' }, null, 2)}\n`;
    const paused: PausedHook = { event: 'Stop', matcher: null, entry: { type: 'prompt', prompt: 'Done?' } };
    fs.writeFileSync(userFile, withHook);

    // The write fails: the hook stays in the file and is in the tray as well.
    fs.chmodSync(userFile, 0o444);
    fs.chmodSync(path.dirname(userFile), 0o555);
    try {
      const failed = await service.save(project, { source: 'userSettings', openedText: withHook, newText: without, paused: [paused] });
      expect(failed).toMatchObject({ status: 'failedOfferRestore', reason: WRITE_FAILED_REASON });
    } finally {
      fs.chmodSync(path.dirname(userFile), 0o755);
      fs.chmodSync(userFile, 0o644);
    }
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(withHook);
    expect((await service.open(project, 'userSettings')).paused).toEqual([paused]);

    // Pause, then turn back on: after each read-back, the tray holds the new list only.
    const pausedSave = await service.save(project, { source: 'userSettings', openedText: withHook, newText: without, paused: [paused] });
    expect(pausedSave.status).toBe('saved');
    expect((await service.open(project, 'userSettings')).paused).toEqual([paused]);
    const resumed = await service.save(project, { source: 'userSettings', openedText: without, newText: withHook, paused: [] });
    expect(resumed.status).toBe('saved');
    expect((await service.open(project, 'userSettings')).paused).toEqual([]);
  });

  it('stores a change to the tray alone without writing the file or making a backup', async () => {
    const service = new HookFileService(deps());
    const withHook = stop('Done?');
    const paused: PausedHook = { event: 'Stop', matcher: null, entry: { type: 'prompt', prompt: 'Done?' } };
    // The hook sits in the file and in the tray at once, as a failed write leaves it.
    fs.writeFileSync(userFile, withHook);
    pausedLists.set(userFile, [paused]);
    const save = (openedText: string, list: PausedHook[]) =>
      service.save(project, { source: 'userSettings', openedText, newText: openedText, paused: list });

    // Another program changed the file: the save is refused and the tray stays as it was.
    const changed = withHook.replace('  "model"', ' "model"');
    expect(await save(changed, [])).toMatchObject({ status: 'refused', reason: SAVE_CONFLICT_REASON });
    expect((await service.open(project, 'userSettings')).paused).toEqual([paused]);

    // Same text, same tray: there is still nothing to save.
    expect(await save(withHook, [paused])).toMatchObject({ status: 'refused', reason: NOTHING_TO_SAVE_REASON });

    // Same text, hook taken out of the tray: the tray changes, the file and the backups do not.
    const result = await save(withHook, []);
    expect(result).toEqual({ status: 'saved', text: withHook, backupName: null, pruneWarning: null });
    expect((await service.open(project, 'userSettings')).paused).toEqual([]);
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(withHook);
    expect(backupsOf(userFile)).toEqual([]);
  });

  it('writes through a linked settings file, and two saves at once never both land', async () => {
    const real = path.join(root, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, stop('Done?'));
    fs.symlinkSync(real, userFile);
    const service = new HookFileService(deps());
    const save = (newText: string) =>
      service.save(project, { source: 'userSettings', openedText: stop('Done?'), newText, paused: [] });

    const [first, second] = await Promise.all([save(stop('A')), save(stop('B'))]);
    expect(first.status).toBe('saved');
    expect(second).toMatchObject({ status: 'refused', reason: SAVE_CONFLICT_REASON });
    expect(fs.lstatSync(userFile).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf-8')).toBe(stop('A'));
  });
});

describe.skipIf(process.platform === 'win32')('hook file service: restore', () => {
  it('lists backups newest first, backs up the current text before a restore, and refuses a bad name', async () => {
    const service = new HookFileService(deps());
    const save = (openedText: string, newText: string) =>
      service.save(project, { source: 'userSettings', openedText, newText, paused: [] });
    fs.writeFileSync(userFile, stop('one'));
    await save(stop('one'), stop('two'));
    await save(stop('two'), stop('three'));
    const listed = await service.listBackups(project, 'userSettings');
    expect(listed.map((backup) => backup.savedAt)).toEqual(['2026-10-09T12:00:01Z', '2026-10-09T12:00:00Z']);
    const oldest = listed[1].name;

    const restored = await service.restore(project, 'userSettings', oldest);
    expect(restored).toMatchObject({ status: 'restored', text: stop('one') });
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(stop('one'));
    // The text the restore replaced is now the newest backup, so the restore can be undone too.
    const [newest] = await service.listBackups(project, 'userSettings');
    expect(restored.status === 'restored' && restored.backupName).toBe(newest.name);
    expect(await service.restore(project, 'userSettings', newest.name)).toMatchObject({ status: 'restored', text: stop('three') });
    expect(await service.restore(project, 'userSettings', newest.name)).toEqual({
      status: 'refused',
      reason: SAME_AS_BACKUP_REASON,
    });

    const badNames = ['../settings.json', '../x/settings.json.2026-10-09_12-00-00-1.bak', 'settings.local.json.2026-10-09_12-00-00-1.bak'];
    for (const name of badNames) {
      expect(await service.restore(project, 'userSettings', name)).toEqual({ status: 'refused', reason: NOT_A_BACKUP_REASON });
    }
    expect(await service.restore(project, 'userSettings', 'settings.json.2001-01-01_00-00-00-1.bak')).toEqual({
      status: 'refused',
      reason: BACKUP_GONE_REASON,
    });
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(stop('three'));

    // The file is gone: the restore writes it back, with nothing to back up first.
    fs.rmSync(userFile);
    expect(await service.restore(project, 'userSettings', oldest)).toMatchObject({ status: 'restored', backupName: null });
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(stop('one'));
  });

  it('finds backups and paused hooks on a second launch, and restores a broken file from them', async () => {
    const paused: PausedHook = { event: 'Stop', matcher: null, entry: { type: 'prompt', prompt: 'Done?' } };
    fs.writeFileSync(userFile, stop('Done?'));
    const first = new HookFileService(deps());
    const saved = await first.save(project, {
      source: 'userSettings',
      openedText: stop('Done?'),
      newText: `${JSON.stringify({ model: 'opus' }, null, 2)}\n`,
      paused: [paused],
    });
    expect(saved.status).toBe('saved');

    // Another program breaks the file. Then the app starts again: a new service on the same folders and stores.
    fs.writeFileSync(userFile, '{ "hooks": ');
    const second = new HookFileService(deps());
    expect(await second.open(project, 'userSettings')).toMatchObject({ text: '{ "hooks": ', paused: [paused] });
    const [backup] = await second.listBackups(project, 'userSettings');
    expect(await second.restore(project, 'userSettings', backup.name)).toMatchObject({ status: 'restored', text: stop('Done?') });
    // The broken text was backed up before the restore wrote over it.
    expect(await second.listBackups(project, 'userSettings')).toHaveLength(2);
  });
});
