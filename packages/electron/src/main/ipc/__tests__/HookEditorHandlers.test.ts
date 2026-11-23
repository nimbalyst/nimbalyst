// @vitest-environment node

/**
 * The hook-editor channels on real temp folders: backups go to userData,
 * paused hooks go to the store that matches their file, and a call without a
 * project or with an unknown source is refused.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { handlers, onHandlers, unsaved, dirs, appPaused, workspacePaused } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  unsaved: { setHookEditorUnsaved: vi.fn() },
  dirs: { userData: '', claude: '' },
  appPaused: new Map<string, unknown[]>(),
  workspacePaused: new Map<string, unknown[]>(),
}));

vi.mock('electron', () => ({ app: { getPath: () => dirs.userData } }));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
  safeOn: (channel: string, handler: (...args: unknown[]) => unknown) => onHandlers.set(channel, handler),
}));
vi.mock('../../window/hookEditorUnsaved', () => unsaved);
vi.mock('@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir', () => ({
  resolveClaudeConfigDir: () => dirs.claude,
}));
vi.mock('../../utils/store', () => ({
  getAppPausedHooks: (filePath: string) => appPaused.get(filePath) ?? [],
  setAppPausedHooks: (filePath: string, hooks: unknown[]) => appPaused.set(filePath, hooks),
  getWorkspacePausedHooks: (workspacePath: string, filePath: string) => workspacePaused.get(`${workspacePath}|${filePath}`) ?? [],
  setWorkspacePausedHooks: (workspacePath: string, filePath: string, hooks: unknown[]) =>
    workspacePaused.set(`${workspacePath}|${filePath}`, hooks),
}));

import { registerHookEditorHandlers } from '../HookEditorHandlers';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-hook-editor-ipc-'));
  dirs.userData = path.join(root, 'userData');
  dirs.claude = path.join(root, 'home', '.claude');
  registerHookEditorHandlers();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`No handler for ${channel}`);
  return handler({}, ...args);
}

it('keeps backups in userData and paused hooks in the store of their file, and refuses a bad call', async () => {
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const text = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Done?' }] }] } }, null, 2);
  const paused = { event: 'Stop', matcher: null, entry: { type: 'prompt', prompt: 'Done?' } };

  for (const source of ['userSettings', 'localSettings']) {
    const opened = await invoke('hook-editor:open', project, source);
    expect((await invoke('hook-editor:save', project, { source, openedText: opened.text, newText: text, paused: [] })).status).toBe('saved');
    expect((await invoke('hook-editor:save', project, { source, openedText: text, newText: '{}', paused: [paused] })).status).toBe('saved');
    expect(await invoke('hook-editor:list-backups', project, source)).toHaveLength(1);
  }
  expect([...appPaused.values()]).toEqual([[paused]]);
  expect([...workspacePaused.entries()]).toEqual([[`${project}|${path.join(project, '.claude', 'settings.local.json')}`, [paused]]]);
  // A hook paused in the user file stays paused when another project opens that file. A project's own file does not carry it.
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  expect((await invoke('hook-editor:open', other, 'userSettings')).paused).toEqual([paused]);
  expect((await invoke('hook-editor:open', other, 'localSettings')).paused).toEqual([]);
  // Backups never sit in the project, so they never show up in git.
  expect(fs.readdirSync(path.join(project, '.claude'))).toEqual(['settings.local.json']);
  expect(fs.readdirSync(path.join(dirs.userData, 'hook-editor', 'backups'))).toHaveLength(2);

  await expect(invoke('hook-editor:open', '', 'userSettings')).rejects.toThrow('workspacePath is required');
  await expect(invoke('hook-editor:open', project, '../../etc/passwd')).rejects.toThrow('Unknown settings source');
  await expect(invoke('hook-editor:save', project, { source: 'userSettings', openedText: 1 })).rejects.toThrow('save request');
});

it('records which window has unsaved hook changes, and treats anything but true as saved', () => {
  const send = onHandlers.get('hook-editor:set-unsaved')!;
  send({ sender: { id: 7 } }, true);
  send({ sender: { id: 7 } }, 'yes');
  expect(unsaved.setHookEditorUnsaved.mock.calls).toEqual([[7, true], [7, false]]);
});
