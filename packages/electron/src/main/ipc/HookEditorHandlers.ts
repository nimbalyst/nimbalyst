/**
 * IPC for the hook editor. The screen names a project and one of the three
 * settings files. It never sends a file path, so it can only reach those files.
 */

import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { resolveClaudeConfigDir } from '@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir';

import { HookFileService, type PausedStore, type SaveRequest } from '../services/hookEditor/HookFileService';
import type { SettingsSource } from '../services/hookEditor/hookFiles';
import { setHookEditorUnsaved } from '../window/hookEditorUnsaved';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import {
  getAppPausedHooks,
  getWorkspacePausedHooks,
  setAppPausedHooks,
  setWorkspacePausedHooks,
} from '../utils/store';

/** Paused hooks from the user file live in app settings, so they stay paused in every project. */
const pausedStore: PausedStore = {
  get: (source, workspacePath, filePath) =>
    source === 'userSettings' ? getAppPausedHooks(filePath) : getWorkspacePausedHooks(workspacePath, filePath),
  set: (source, workspacePath, filePath, hooks) =>
    source === 'userSettings'
      ? setAppPausedHooks(filePath, hooks)
      : setWorkspacePausedHooks(workspacePath, filePath, hooks),
};

let service: HookFileService | null = null;

/** Made on first use, so app.getPath runs after bootstrap has set the userData folder. */
function hookFiles(): HookFileService {
  service ??= new HookFileService({
    backupRoot: path.join(app.getPath('userData'), 'hook-editor', 'backups'),
    userSettingsPath: path.join(resolveClaudeConfigDir(), 'settings.json'),
    homeDir: os.homedir(),
    paused: pausedStore,
    now: () => new Date(),
  });
  return service;
}

export function registerHookEditorHandlers(): void {
  safeHandle('hook-editor:open', (_event, workspacePath: string, source: SettingsSource) =>
    hookFiles().open(workspacePath, source),
  );
  safeHandle('hook-editor:check', (_event, workspacePath: string, source: SettingsSource, text: string) =>
    hookFiles().check(workspacePath, source, text),
  );
  safeHandle('hook-editor:save', (_event, workspacePath: string, request: SaveRequest) =>
    hookFiles().save(workspacePath, request),
  );
  safeHandle('hook-editor:list-backups', (_event, workspacePath: string, source: SettingsSource) =>
    hookFiles().listBackups(workspacePath, source),
  );
  safeHandle('hook-editor:restore', (_event, workspacePath: string, source: SettingsSource, name: string) =>
    hookFiles().restore(workspacePath, source, name),
  );
  // The editor reports unsaved changes, so a reload, a window close or a quit asks first.
  safeOn('hook-editor:set-unsaved', (event, unsaved: unknown) => {
    setHookEditorUnsaved(event.sender.id, unsaved === true);
  });
}
