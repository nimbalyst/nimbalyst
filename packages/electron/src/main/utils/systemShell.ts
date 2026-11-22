/**
 * Drop-in replacements for Electron's `shell.openExternal`, `shell.openPath`
 * and `shell.showItemInFolder` that also work when Nimbalyst runs under WSL.
 *
 * Under WSL (WSLg) Electron hands every open to `xdg-open`, and a typical
 * distro has no Linux browser, file handler or file manager registered, so
 * links and "open file/folder" actions do nothing. Electron cannot tell us that
 * it failed: on Linux (checked against Electron 43) `openExternal` resolves as
 * soon as xdg-open starts, whatever its exit code, and `openPath` never settles.
 *
 * So under WSL this module runs the Linux opener itself and reads its exit
 * code. When Linux cannot open the target, it hands it to Windows:
 * `rundll32.exe url.dll,FileProtocolHandler` opens URLs and files, and
 * `explorer.exe /select,` reveals a file. Off WSL every call goes straight to
 * Electron's `shell`, unchanged.
 *
 * rundll32 takes the target as a plain argument and reports a real exit code.
 * `explorer.exe <url>` exits 1 without opening a browser on current Windows
 * builds, and wslview (wslu 3.x) splices its argument into PowerShell code.
 *
 * Every process is spawned with an argument array, never through a shell.
 * Only http(s) and mailto URLs are ever handed to Windows.
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import { shell } from 'electron';
import { constants as fsConstants, promises as fsPromises, readFileSync } from 'fs';
import * as path from 'path';

export type OpenTarget =
  | { kind: 'url'; url: string }
  | { kind: 'path'; path: string }
  | { kind: 'reveal'; path: string };

/** Windows programs reachable from this WSL distro, as absolute paths. */
export interface WindowsOpeners {
  rundll32: string | null;
  explorer: string | null;
  wslpath: string | null;
}

export interface OpenEnvironment extends WindowsOpeners {
  wsl: boolean;
}

/**
 * What the Linux side did with the target: not tried yet, opened it (or has a
 * handler for it), or could not.
 */
export type LinuxResult = 'unknown' | 'handled' | 'unhandled';

/** `rundll32` opens a URL or file; `explorer-select` reveals a file in Explorer. */
export type WindowsOpener = 'rundll32' | 'explorer-select';

export type OpenPlan =
  /** Call Electron's `shell` exactly as before. */
  | { action: 'electron' }
  /** Run the Linux opener, then plan again with its result. */
  | { action: 'try-linux' }
  | { action: 'done' }
  /** Hand the target to Windows. */
  | { action: 'windows'; opener: WindowsOpener };

/** How long a Linux opener may run before we take it as having opened the target. */
export const LINUX_OPEN_SETTLE_MS = 6000;
/** How long rundll32 may take to hand the target over before we call it a failure. */
export const WINDOWS_OPEN_TIMEOUT_MS = 15000;
const HELPER_TIMEOUT_MS = 5000;
const DEFAULT_RUNDLL32_PATH = '/mnt/c/Windows/System32/rundll32.exe';
const DEFAULT_EXPLORER_PATH = '/mnt/c/Windows/explorer.exe';
export const FILE_PROTOCOL_HANDLER = 'url.dll,FileProtocolHandler';

// File types Windows can execute through file associations. Explicit Open file
// reveals these instead; a missing Explorer must never fall back to execution.
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.lnk', '.scr', '.pif', '.cpl', '.msc',
  '.msi', '.msp', '.mst', '.ps1', '.ps1xml', '.ps2', '.ps2xml', '.psc1', '.psc2',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.reg', '.application', '.appref-ms',
]);

const WINDOWS_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function isWslHost(facts: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  osRelease: string;
}): boolean {
  if (facts.platform !== 'linux') return false;
  return Boolean(facts.env.WSL_DISTRO_NAME || facts.env.WSL_INTEROP) || /microsoft/i.test(facts.osRelease);
}

/**
 * The URL to give Windows, or null when it must stay on Linux. The URL
 * serializer has already percent-encoded everything non-ASCII; whitespace and
 * `"`, which a mailto URL can still carry, are encoded so the URL stays one
 * token on the Windows command line.
 */
export function toWindowsUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!WINDOWS_URL_PROTOCOLS.has(parsed.protocol)) return null;
  return parsed.href.replace(
    /[\s"]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

function windowsOpenerFor(target: OpenTarget, env: WindowsOpeners): WindowsOpener | null {
  switch (target.kind) {
    case 'url':
      return env.rundll32 && toWindowsUrl(target.url) !== null ? 'rundll32' : null;
    case 'path':
      return env.rundll32 && env.wslpath ? 'rundll32' : null;
    case 'reveal':
      return env.explorer && env.wslpath ? 'explorer-select' : null;
  }
}

/**
 * The WSL decision. Off WSL, or when no Windows program can take this target,
 * Electron's `shell` handles it as before. Otherwise Linux gets the first try
 * and Windows gets the target only when Linux could not open it.
 */
export function planSystemOpen(target: OpenTarget, env: OpenEnvironment, linux: LinuxResult): OpenPlan {
  if (!env.wsl) return { action: 'electron' };
  const opener = windowsOpenerFor(target, env);
  if (!opener) return { action: 'electron' };
  if (linux === 'unknown') return { action: 'try-linux' };
  if (linux === 'handled') return { action: 'done' };
  return { action: 'windows', opener };
}

type LaunchResult =
  | { status: 'started' }
  | { status: 'exited'; code: number | null }
  | { status: 'still-running' }
  | { status: 'failed-to-start'; error: string };

/**
 * Spawn `command` with an argument array (never a shell). With `waitForExit`
 * the result is its exit code, or `still-running` once `settleMs` passes;
 * otherwise it is `started` as soon as the process exists.
 */
function launch(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; waitForExit: boolean; settleMs?: number },
): Promise<LaunchResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: 'ignore' });
    } catch (error) {
      resolve({ status: 'failed-to-start', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: LaunchResult) => {
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.once('error', (error) => finish({ status: 'failed-to-start', error: error.message }));
    if (!options.waitForExit) {
      child.once('spawn', () => {
        child.unref();
        finish({ status: 'started' });
      });
      return;
    }
    child.once('exit', (code) => finish({ status: 'exited', code }));
    timer = setTimeout(() => {
      child.unref();
      finish({ status: 'still-running' });
    }, options.settleMs ?? LINUX_OPEN_SETTLE_MS);
  });
}

function runForOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: HELPER_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout).replace(/[\r\n]+$/, ''));
    });
  });
}

// Descriptions match Electron's for xdg-open exit codes.
function describeXdgExit(code: number | null): string {
  switch (code) {
    case 1:
      return 'Error in command line syntax';
    case 2:
      return 'The item does not exist';
    case 3:
      return 'A required tool could not be found';
    case 4:
      return 'The action failed';
    default:
      return `xdg-open exited with code ${code}`;
  }
}

function describeLaunch(name: string, result: LaunchResult): string {
  if (result.status === 'failed-to-start') return `${name} could not start: ${result.error}`;
  if (result.status === 'exited') return `${name} exited with code ${result.code}`;
  return `${name} did not finish`;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await fsPromises.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `name` on PATH, else `fallback` (an app started from the WSLg Start menu may lack the Windows PATH). */
export async function findExecutable(name: string, fallback?: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return fallback && (await isExecutable(fallback)) ? fallback : null;
}

async function findWindowsOpeners(): Promise<WindowsOpeners> {
  const [rundll32, explorer, wslpath] = await Promise.all([
    findExecutable('rundll32.exe', DEFAULT_RUNDLL32_PATH),
    findExecutable('explorer.exe', DEFAULT_EXPLORER_PATH),
    findExecutable('wslpath'),
  ]);
  return { rundll32, explorer, wslpath };
}

async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await fsPromises.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

function readOsRelease(): string {
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8');
  } catch {
    return '';
  }
}

let wslHost: boolean | undefined;
export function detectWsl(): boolean {
  if (wslHost === undefined) {
    // Only the Electron app hands work to Windows. Unit tests that load a
    // call site under vitest on a WSL machine must never launch Windows apps.
    wslHost =
      Boolean(process.versions.electron) &&
      isWslHost({ platform: process.platform, env: process.env, osRelease: readOsRelease() });
  }
  return wslHost;
}

export interface SystemShellDeps {
  isWsl: () => boolean;
  findOpeners: () => Promise<WindowsOpeners>;
}

export interface SystemShell {
  openExternal(url: string): Promise<void>;
  openPath(fullPath: string): Promise<string>;
  showItemInFolder(fullPath: string): void;
}

export function createSystemShell(deps: SystemShellDeps): SystemShell {
  let openersPromise: Promise<WindowsOpeners> | null = null;
  const getEnvironment = async (): Promise<OpenEnvironment> => {
    openersPromise ??= deps.findOpeners();
    return { wsl: true, ...(await openersPromise) };
  };

  let fileManagerPromise: Promise<boolean> | null = null;
  const hasLinuxFileManager = (): Promise<boolean> => {
    fileManagerPromise ??= runForOutput('xdg-mime', ['query', 'default', 'inode/directory']).then(
      (desktopFile) => desktopFile.trim().length > 0,
      () => false,
    );
    return fileManagerPromise;
  };

  const xdgEnv = (): NodeJS.ProcessEnv => ({ ...process.env, MM_NOTTTY: '1' });

  /** The Linux attempt. Resolves to '' when Linux opened it, else why it could not. */
  async function tryLinux(target: OpenTarget): Promise<string> {
    if (target.kind === 'reveal') {
      if (!(await hasLinuxFileManager())) return 'No Linux file manager is registered';
      shell.showItemInFolder(target.path);
      return '';
    }
    const isMail = target.kind === 'url' && new URL(target.url).protocol === 'mailto:';
    const command = isMail ? 'xdg-email' : 'xdg-open';
    const arg = target.kind === 'url' ? new URL(target.url).href : target.path;
    const result = await launch(command, [arg], {
      cwd: target.kind === 'path' ? path.dirname(target.path) : undefined,
      env: xdgEnv(),
      waitForExit: true,
      settleMs: LINUX_OPEN_SETTLE_MS,
    });
    if (result.status === 'still-running') return '';
    if (result.status === 'exited') return result.code === 0 ? '' : describeXdgExit(result.code);
    return describeLaunch(command, result);
  }

  async function toWindowsPath(env: OpenEnvironment, linuxPath: string): Promise<string> {
    if (!env.wslpath) throw new Error('wslpath is unavailable');
    const windowsPath = await runForOutput(env.wslpath, ['-w', linuxPath]);
    if (!windowsPath) throw new Error('wslpath returned an empty path');
    return windowsPath;
  }

  /** Hand the target to Windows. Resolves to '' on success, else why it failed. */
  async function openInWindows(opener: WindowsOpener, target: OpenTarget, env: OpenEnvironment): Promise<string> {
    let arg: string | null;
    try {
      arg = target.kind === 'url' ? toWindowsUrl(target.url) : await toWindowsPath(env, target.path);
    } catch (error) {
      return `Could not convert the path for Windows: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (arg === null) return 'Windows cannot open this URL';

    if (target.kind === 'path') {
      try {
        const resolvedPath = await fsPromises.realpath(target.path);
        const executableName = [target.path, resolvedPath].some((candidate) =>
          WINDOWS_EXECUTABLE_EXTENSIONS.has(path.extname(candidate.replace(/[ .]+$/, '')).toLowerCase()),
        );
        if ((await fsPromises.stat(resolvedPath)).isFile() && executableName) {
          opener = 'explorer-select';
        }
      } catch (error) {
        return `Could not inspect the file before opening it in Windows: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (opener === 'explorer-select') {
      if (!env.explorer) return 'explorer.exe is unavailable';
      // explorer.exe exits 1 even when it succeeds, so a started process is
      // all we can check.
      const result = await launch(env.explorer, [`/select,${arg}`], {
        cwd: path.dirname(env.explorer),
        waitForExit: false,
      });
      return result.status === 'started' ? '' : describeLaunch('explorer.exe', result);
    }

    if (!env.rundll32) return 'rundll32.exe is unavailable';
    // Start it from the Windows directory rather than a UNC working directory.
    const result = await launch(env.rundll32, [FILE_PROTOCOL_HANDLER, arg], {
      cwd: path.dirname(path.dirname(env.rundll32)),
      waitForExit: true,
      settleMs: WINDOWS_OPEN_TIMEOUT_MS,
    });
    return result.status === 'exited' && result.code === 0 ? '' : describeLaunch('rundll32.exe', result);
  }

  /**
   * Run the plan for `target` under WSL. Resolves to '' on success, an error
   * description on failure, or null when Electron's `shell` should handle it.
   */
  async function openUnderWsl(target: OpenTarget): Promise<string | null> {
    const env = await getEnvironment();
    let plan = planSystemOpen(target, env, 'unknown');
    if (plan.action === 'electron') return null;

    let linuxError = '';
    if (plan.action === 'try-linux') {
      linuxError = await tryLinux(target);
      plan = planSystemOpen(target, env, linuxError ? 'unhandled' : 'handled');
    }
    if (plan.action === 'done') return '';
    if (plan.action !== 'windows') return null;
    // Windows would show its own error, or a default folder, for a missing path.
    if (target.kind !== 'url' && !(await pathExists(target.path))) return 'The item does not exist';

    console.info('[systemShell] Linux could not open the target under WSL; handing it to Windows', {
      kind: target.kind,
      reason: linuxError,
      opener: plan.opener,
    });
    const windowsError = await openInWindows(plan.opener, target, env);
    if (!windowsError) return '';
    console.warn('[systemShell] Windows could not open the target', { opener: plan.opener, error: windowsError });
    return `${linuxError}; ${windowsError}`;
  }

  return {
    openExternal(url) {
      if (!deps.isWsl()) return shell.openExternal(url);
      return openUnderWsl({ kind: 'url', url }).then((error) => {
        if (error === null) return shell.openExternal(url);
        if (error) throw new Error(`Failed to open URL: ${error}`);
        return undefined;
      });
    },

    openPath(fullPath) {
      if (!deps.isWsl()) return shell.openPath(fullPath);
      return openUnderWsl({ kind: 'path', path: path.resolve(fullPath) }).then((error) =>
        error === null ? shell.openPath(fullPath) : error,
      );
    },

    showItemInFolder(fullPath) {
      if (!deps.isWsl()) {
        shell.showItemInFolder(fullPath);
        return;
      }
      openUnderWsl({ kind: 'reveal', path: path.resolve(fullPath) })
        .then((error) => {
          if (error === null) {
            shell.showItemInFolder(fullPath);
          } else if (error) {
            console.warn('[systemShell] Could not reveal the item in Windows; falling back to Electron', {
              error,
            });
            shell.showItemInFolder(fullPath);
          }
        })
        .catch((error) => console.error('[systemShell] showItemInFolder failed', error));
    },
  };
}

/** Use in place of Electron's `shell` for opening URLs, files and folders. */
export const systemShell: SystemShell = createSystemShell({
  isWsl: detectWsl,
  findOpeners: findWindowsOpeners,
});

/** For UI callbacks that cannot await an opener failure. Awaited callers keep the rejection. */
export function openExternalInBackground(url: string): void {
  void systemShell.openExternal(url).catch((error) => {
    console.error('[systemShell] Failed to open external URL', error);
  });
}
