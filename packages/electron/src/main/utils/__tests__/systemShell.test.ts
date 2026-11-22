// @vitest-environment node
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, execFileMock, shellMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
  shellMock: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock('child_process', () => ({ spawn: spawnMock, execFile: execFileMock }));
vi.mock('electron', () => ({ shell: shellMock }));

import {
  createSystemShell,
  openExternalInBackground,
  FILE_PROTOCOL_HANDLER,
  isWslHost,
  LINUX_OPEN_SETTLE_MS,
  planSystemOpen,
  toWindowsUrl,
  WINDOWS_OPEN_TIMEOUT_MS,
  type OpenEnvironment,
  type OpenTarget,
  type WindowsOpeners,
} from '../systemShell';

const RUNDLL32 = '/mnt/c/Windows/System32/rundll32.exe';
const EXPLORER = '/mnt/c/Windows/explorer.exe';
const WSLPATH = '/usr/bin/wslpath';
const ALL_OPENERS: WindowsOpeners = { rundll32: RUNDLL32, explorer: EXPLORER, wslpath: WSLPATH };
const WSL: OpenEnvironment = { wsl: true, ...ALL_OPENERS };

/** What each spawned command does: exit with a code, fail to start, or keep running. */
type ChildScript = { exit: number } | { error: string } | 'hang';
let scripts: Record<string, ChildScript>;
let xdgMimeDefault: string;

function fakeChild(script: ChildScript) {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  queueMicrotask(() => {
    if (typeof script === 'object' && 'error' in script) {
      child.emit('error', new Error(script.error));
      return;
    }
    child.emit('spawn');
    if (typeof script === 'object') child.emit('exit', script.exit);
  });
  return child;
}

function spawned(): Array<[string, string[]]> {
  return spawnMock.mock.calls.map(([command, args]) => [command, args]);
}

const windowsPathOf = (linuxPath: string) => `\\\\wsl.localhost\\Ubuntu${linuxPath.replace(/\//g, '\\')}`;

let tmpDir: string;
let file: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-shell-'));
  file = path.join(tmpDir, 'a b, c.txt');
  fs.writeFileSync(file, 'x');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  scripts = {};
  xdgMimeDefault = '';
  spawnMock.mockReset().mockImplementation((command: string) => fakeChild(scripts[command] ?? { exit: 0 }));
  execFileMock.mockReset().mockImplementation(
    (command: string, args: string[], _options: unknown, callback: (e: Error | null, out: string) => void) => {
      if (command === WSLPATH) callback(null, `${windowsPathOf(args[1])}\n`);
      else if (command === 'xdg-mime') callback(null, `${xdgMimeDefault}\n`);
      else callback(new Error(`unexpected ${command}`), '');
    },
  );
  shellMock.openExternal.mockReset().mockResolvedValue(undefined);
  shellMock.openPath.mockReset().mockResolvedValue('');
  shellMock.showItemInFolder.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // Nothing is ever run through a shell.
  for (const call of spawnMock.mock.calls) expect(call[2]?.shell).toBeUndefined();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isWslHost', () => {
  it.each([
    ['linux', { WSL_DISTRO_NAME: 'Ubuntu' }, '', true],
    ['linux', { WSL_INTEROP: '/run/WSL/1_interop' }, '', true],
    ['linux', {}, '6.6.87.2-microsoft-standard-WSL2', true],
    ['linux', {}, '6.8.0-45-generic', false],
    ['win32', { WSL_DISTRO_NAME: 'Ubuntu' }, '', false],
    ['darwin', {}, 'microsoft', false],
  ] as const)('%s %j %s -> %s', (platform, env, osRelease, expected) => {
    expect(isWslHost({ platform, env, osRelease })).toBe(expected);
  });
});

describe('toWindowsUrl', () => {
  it('normalizes web URLs and keeps a mailto URL one command-line token', () => {
    expect(toWindowsUrl('https://example.com/a b?q=$x&r=1')).toBe('https://example.com/a%20b?q=$x&r=1');
    expect(toWindowsUrl('mailto:a"b c@example.com')).toBe('mailto:a%22b%20c@example.com');
  });

  it.each(['file:///etc/passwd', 'ms-settings:notifications', 'javascript:alert(1)', 'not a url'])(
    'keeps %s away from Windows',
    (url) => {
      expect(toWindowsUrl(url)).toBeNull();
    },
  );
});

describe('planSystemOpen', () => {
  const url: OpenTarget = { kind: 'url', url: 'https://example.com/' };
  const filePath: OpenTarget = { kind: 'path', path: '/home/me/notes.md' };
  const reveal: OpenTarget = { kind: 'reveal', path: '/home/me/notes.md' };

  it.each<[string, OpenTarget, OpenEnvironment, Parameters<typeof planSystemOpen>[2], ReturnType<typeof planSystemOpen>]>([
    ['off WSL', url, { ...WSL, wsl: false }, 'unknown', { action: 'electron' }],
    ['off WSL, even after a Linux failure', filePath, { ...WSL, wsl: false }, 'unhandled', { action: 'electron' }],
    ['Linux goes first', url, WSL, 'unknown', { action: 'try-linux' }],
    ['Linux success short-circuits', url, WSL, 'handled', { action: 'done' }],
    ['URL after Linux fails', url, WSL, 'unhandled', { action: 'windows', opener: 'rundll32' }],
    ['URL without rundll32', url, { ...WSL, rundll32: null }, 'unknown', { action: 'electron' }],
    ['URL scheme Windows must not get', { kind: 'url', url: 'ms-settings:privacy' }, WSL, 'unknown', { action: 'electron' }],
    ['file after Linux fails', filePath, WSL, 'unhandled', { action: 'windows', opener: 'rundll32' }],
    ['file without wslpath', filePath, { ...WSL, wslpath: null }, 'unknown', { action: 'electron' }],
    ['reveal with no Linux file manager', reveal, WSL, 'unhandled', { action: 'windows', opener: 'explorer-select' }],
    ['reveal without explorer.exe', reveal, { ...WSL, explorer: null }, 'unknown', { action: 'electron' }],
  ])('%s', (_name, target, env, linux, plan) => {
    expect(planSystemOpen(target, env, linux)).toEqual(plan);
  });
});

describe('createSystemShell', () => {
  const findOpeners = vi.fn(async (): Promise<WindowsOpeners> => ALL_OPENERS);
  const wslShell = (openers: WindowsOpeners = ALL_OPENERS) =>
    createSystemShell({ isWsl: () => true, findOpeners: async () => openers });

  it('logs a rejected background open without leaking an unhandled rejection', async () => {
    const error = new Error('opener failed');
    shellMock.openExternal.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    openExternalInBackground('https://example.com/');
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[systemShell] Failed to open external URL', error));
  });

  it('passes straight through to Electron off WSL', async () => {
    const offWsl = createSystemShell({ isWsl: () => false, findOpeners });
    await offWsl.openExternal('https://example.com/');
    await expect(offWsl.openPath(file)).resolves.toBe('');
    offWsl.showItemInFolder(file);

    expect(shellMock.openExternal).toHaveBeenCalledWith('https://example.com/');
    expect(shellMock.openPath).toHaveBeenCalledWith(file);
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(file);
    expect(findOpeners).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('stops after Linux opens the URL', async () => {
    await wslShell().openExternal('https://example.com/x');
    expect(spawned()).toEqual([['xdg-open', ['https://example.com/x']]]);
    expect(shellMock.openExternal).not.toHaveBeenCalled();
  });

  it('treats a Linux opener that is still running as having opened the target', async () => {
    vi.useFakeTimers();
    scripts['xdg-open'] = 'hang';
    const opened = wslShell().openExternal('https://example.com/');
    await vi.advanceTimersByTimeAsync(LINUX_OPEN_SETTLE_MS);
    await expect(opened).resolves.toBeUndefined();
    expect(spawned()).toEqual([['xdg-open', ['https://example.com/']]]);
  });

  it('hands a URL to rundll32 FileProtocolHandler from the Windows directory when xdg-open fails', async () => {
    scripts['xdg-open'] = { exit: 3 };
    await wslShell().openExternal('https://example.com/?q=$x&r=1');
    expect(spawned()).toEqual([
      ['xdg-open', ['https://example.com/?q=$x&r=1']],
      [RUNDLL32, [FILE_PROTOCOL_HANDLER, 'https://example.com/?q=$x&r=1']],
    ]);
    expect(spawnMock.mock.calls[1][2]).toMatchObject({ cwd: '/mnt/c/Windows' });
  });

  it('uses xdg-email for mailto before handing it to rundll32', async () => {
    scripts['xdg-email'] = { error: 'spawn xdg-email ENOENT' };
    await wslShell().openExternal('mailto:me@example.com');
    expect(spawned()).toEqual([
      ['xdg-email', ['mailto:me@example.com']],
      [RUNDLL32, [FILE_PROTOCOL_HANDLER, 'mailto:me@example.com']],
    ]);
  });

  it('opens a file by its Windows path, passed as one argument', async () => {
    scripts['xdg-open'] = { exit: 3 };
    await expect(wslShell().openPath(file)).resolves.toBe('');
    expect(execFileMock).toHaveBeenCalledWith(WSLPATH, ['-w', file], expect.anything(), expect.any(Function));
    expect(spawned()).toEqual([
      ['xdg-open', [file]],
      [RUNDLL32, [FILE_PROTOCOL_HANDLER, windowsPathOf(file)]],
    ]);
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: tmpDir });
  });

  it.each(['exe', 'BAT', 'cmd', 'lnk', 'com', 'scr', 'msi', 'ps1', 'vbs', 'js', 'exe. '])('reveals a .%s file instead of executing it in Windows', async (extension) => {
    const executable = path.join(tmpDir, `program.${extension}`);
    fs.writeFileSync(executable, 'not executable test content');
    scripts['xdg-open'] = { exit: 3 };
    await expect(wslShell().openPath(executable)).resolves.toBe('');
    expect(spawned()).toEqual([
      ['xdg-open', [executable]],
      [EXPLORER, [`/select,${windowsPathOf(executable)}`]],
    ]);
  });

  it.each([['target.exe', 'alias.txt'], ['target.txt', 'alias.exe']])('reveals symlinks when either %s or %s is executable', async (targetName, aliasName) => {
    const target = path.join(tmpDir, targetName);
    const alias = path.join(tmpDir, aliasName);
    fs.writeFileSync(target, 'not executable test content');
    fs.symlinkSync(target, alias);
    scripts['xdg-open'] = { exit: 3 };
    await expect(wslShell().openPath(alias)).resolves.toBe('');
    expect(spawned()).toEqual([
      ['xdg-open', [alias]],
      [EXPLORER, [`/select,${windowsPathOf(alias)}`]],
    ]);
  });

  it('does not launch an executable when Explorer is unavailable', async () => {
    const executable = path.join(tmpDir, 'blocked.exe');
    fs.writeFileSync(executable, 'not executable test content');
    scripts['xdg-open'] = { exit: 3 };
    await expect(wslShell({ ...ALL_OPENERS, explorer: null }).openPath(executable)).resolves.toContain('explorer.exe is unavailable');
    expect(spawned()).toEqual([['xdg-open', [executable]]]);
  });

  it('opens a directory using its Windows path, even with an executable suffix', async () => {
    const directory = path.join(tmpDir, 'folder.exe');
    fs.mkdirSync(directory);
    scripts['xdg-open'] = { exit: 3 };
    await expect(wslShell().openPath(directory)).resolves.toBe('');
    expect(spawned()).toEqual([
      ['xdg-open', [directory]],
      [RUNDLL32, [FILE_PROTOCOL_HANDLER, windowsPathOf(directory)]],
    ]);
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: tmpDir });
  });

  it('falls back to Electron when Explorer fails to spawn', async () => {
    scripts[EXPLORER] = { error: 'spawn EACCES' };
    wslShell().showItemInFolder(file);
    await vi.waitFor(() => expect(shellMock.showItemInFolder).toHaveBeenCalledWith(file));
    expect(console.warn).toHaveBeenCalledWith(
      '[systemShell] Could not reveal the item in Windows; falling back to Electron',
      expect.objectContaining({ error: expect.stringContaining('spawn EACCES') }),
    );
  });

  it('counts only a zero exit from rundll32 as success', async () => {
    scripts['xdg-open'] = { exit: 3 };
    scripts[RUNDLL32] = { exit: 1 };
    await expect(wslShell().openExternal('https://example.com/')).rejects.toThrow(
      'Failed to open URL: A required tool could not be found; rundll32.exe exited with code 1',
    );
    await expect(wslShell().openPath(file)).resolves.toBe(
      'A required tool could not be found; rundll32.exe exited with code 1',
    );
  });

  it('fails when rundll32 does not finish in time', async () => {
    vi.useFakeTimers();
    scripts['xdg-open'] = { exit: 3 };
    scripts[RUNDLL32] = 'hang';
    const opened = wslShell().openPath(file);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(WINDOWS_OPEN_TIMEOUT_MS);
    await expect(opened).resolves.toMatch(/rundll32\.exe did not finish/);
  });

  it('does not hand a missing file to Windows', async () => {
    scripts['xdg-open'] = { exit: 2 };
    await expect(wslShell().openPath(path.join(tmpDir, 'missing.md'))).resolves.toBe('The item does not exist');
    expect(spawned()).toHaveLength(1);
  });

  it('reveals in Explorer with /select when no Linux file manager is registered', async () => {
    wslShell().showItemInFolder(file);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    expect(spawned()).toEqual([[EXPLORER, [`/select,${windowsPathOf(file)}`]]]);
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it('reveals with the Linux file manager when one is registered', async () => {
    xdgMimeDefault = 'org.gnome.Nautilus.desktop';
    wslShell().showItemInFolder(file);
    await vi.waitFor(() => expect(shellMock.showItemInFolder).toHaveBeenCalledWith(file));
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
