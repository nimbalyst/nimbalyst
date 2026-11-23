/**
 * Where the hook editor's files are, as plain path rules. Nothing here reads
 * or writes the disk.
 */

import { createHash } from 'crypto';
import * as path from 'path';

import type { PausedHook } from '../../../shared/hookEditor/hookDocument';

/** The three Claude Code settings files the hook editor can change. */
export type SettingsSource = 'userSettings' | 'projectSettings' | 'localSettings';

const SETTINGS_SOURCES: readonly string[] = ['userSettings', 'projectSettings', 'localSettings'];

export function isSettingsSource(value: unknown): value is SettingsSource {
  return typeof value === 'string' && SETTINGS_SOURCES.includes(value);
}

/**
 * The file a source means. A project file sits in the workspace folder as
 * given, because Claude Code reads the file in the folder where the session runs.
 */
export function settingsFilePath(source: SettingsSource, workspacePath: string, userSettingsPath: string): string {
  switch (source) {
    case 'userSettings':
      return userSettingsPath;
    case 'projectSettings':
      return path.join(workspacePath, '.claude', 'settings.json');
    case 'localSettings':
      return path.join(workspacePath, '.claude', 'settings.local.json');
  }
}

/**
 * One backup folder for each file path: the name of the folder two levels up
 * (the project or home folder) so a person can tell them apart, then a hash
 * of the full path so two files never share a folder.
 */
export function backupFolder(backupRoot: string, filePath: string): string {
  const label = path.basename(path.dirname(path.dirname(filePath))).replace(/[^A-Za-z0-9_.-]/g, '_') || 'root';
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 16);
  return path.join(backupRoot, `${label}-${hash}`);
}

/** The real file behind a script path in a hook, the way Claude Code would find it. */
export function resolveScriptPath(scriptPath: string, roots: { homeDir: string; projectDir: string }): string {
  for (const prefix of ['$CLAUDE_PROJECT_DIR/', '${CLAUDE_PROJECT_DIR}/', './']) {
    if (scriptPath.startsWith(prefix)) return path.join(roots.projectDir, scriptPath.slice(prefix.length));
  }
  if (scriptPath.startsWith('~/')) return path.join(roots.homeDir, scriptPath.slice(2));
  return scriptPath;
}

/**
 * The paused list to store while a save is on its way to disk: the new list
 * plus every hook from the old one. A hook is then never in neither place.
 */
export function pausedDuringWrite(before: readonly PausedHook[], after: readonly PausedHook[]): PausedHook[] {
  const keyOf = (hook: PausedHook) => JSON.stringify(hook);
  const inAfter = new Set(after.map(keyOf));
  return [...after, ...before.filter((hook) => !inAfter.has(keyOf(hook)))];
}

/** The save time in a backup name, as an ISO time in UTC, or null when the name is not a backup. */
export function backupTimeOf(name: string): string | null {
  const match = /\.(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-\d+\.bak$/.exec(name);
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z` : null;
}
