import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';

export interface GhCliStatus {
  installed: boolean;
  version?: string;
  authed: boolean;
  host?: string;
  user?: string;
}

const CACHE_DURATION_MS = 30_000;
const SPAWN_TIMEOUT_MS = 10_000;
/**
 * How long a status whose `gh auth status` timed out is cached. The timeout
 * says nothing about the login (on WSL the network check alone can take 10s),
 * so it is re-probed soon instead of reporting "not signed in" for 30s.
 */
const TIMED_OUT_CACHE_MS = 5_000;

interface AuthCheck {
  authed: boolean;
  host?: string;
  user?: string;
  /** `gh auth status` was killed by the spawn timeout before answering. */
  timedOut?: boolean;
}

/**
 * The `gh` executable to spawn. Honors `NIMBALYST_GH_PATH` so E2E tests can
 * point at a stub and users can pin a non-standard install location.
 */
function ghCommand(): string {
  return process.env.NIMBALYST_GH_PATH || 'gh';
}

/**
 * Service to detect the GitHub CLI (`gh`) installation and authentication state.
 *
 * Used by the PR review panel. Nimbalyst never holds a GitHub token; this
 * detector only inspects `gh --version` and `gh auth status` and lets the
 * GitHub CLI own all credentials.
 */
export class GhCliDetector {
  private cachedStatus: GhCliStatus | null = null;
  private cacheExpiresAt: number = 0;
  private inFlight: Promise<GhCliStatus> | null = null;
  private readonly cacheMs: number;
  private readonly timedOutCacheMs: number;
  private readonly spawnTimeoutMs: number;

  constructor(options: { cacheMs?: number; timedOutCacheMs?: number; spawnTimeoutMs?: number } = {}) {
    this.cacheMs = options.cacheMs ?? CACHE_DURATION_MS;
    this.timedOutCacheMs = options.timedOutCacheMs ?? TIMED_OUT_CACHE_MS;
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS;
  }

  async getStatus(): Promise<GhCliStatus> {
    if (this.cachedStatus && Date.now() < this.cacheExpiresAt) {
      return this.cachedStatus;
    }
    // Callers arriving while a probe runs share it instead of each spawning gh.
    this.inFlight ??= this.probe().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async probe(): Promise<GhCliStatus> {
    const installCheck = await this.checkInstallation();
    let authCheck: AuthCheck = { authed: false };
    if (installCheck.installed) {
      authCheck = await this.checkAuth();
    }

    const prev = this.cachedStatus;
    // A timed-out auth check is not an answer; keep the last one we had.
    const keepPrevAuth = authCheck.timedOut === true && prev !== null && prev.installed;
    const next: GhCliStatus = {
      installed: installCheck.installed,
      version: installCheck.version,
      authed: keepPrevAuth ? prev.authed : authCheck.authed,
      host: keepPrevAuth ? prev.host : authCheck.host,
      user: keepPrevAuth ? prev.user : authCheck.user,
    };

    this.cachedStatus = next;
    this.cacheExpiresAt = Date.now() + (authCheck.timedOut ? this.timedOutCacheMs : this.cacheMs);

    if (!prev || prev.installed !== next.installed || prev.authed !== next.authed) {
      this.broadcastStatusChanged(next);
    }

    return next;
  }

  /**
   * Clear the cache so the next `getStatus()` call re-runs the probes.
   * Used by the "Recheck" action in the onboarding banner.
   */
  clearCache(): void {
    this.cachedStatus = null;
    this.cacheExpiresAt = 0;
  }

  /**
   * List every account `gh` is logged into on github.com (and any other host),
   * marking the active one. Used by the per-project account selector (#307).
   */
  async listAccounts(): Promise<Array<{ login: string; host: string; active: boolean }>> {
    return new Promise((resolve) => {
      try {
        const env = { ...process.env, PATH: this.getEnhancedPath(), NO_COLOR: '1' };
        const child = spawn(ghCommand(), ['auth', 'status'], {
          timeout: this.spawnTimeoutMs,
          shell: true,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        let errorOutput = '';
        child.stdout?.on('data', (d) => { output += d.toString(); });
        child.stderr?.on('data', (d) => { errorOutput += d.toString(); });
        child.on('close', () => {
          resolve(parseAuthAccounts(`${output}\n${errorOutput}`));
        });
        child.on('error', () => resolve([]));
      } catch {
        resolve([]);
      }
    });
  }

  /**
   * Common-install-location PATH so we find `gh` even when it isn't on the
   * default Electron child-process PATH (especially on macOS GUI launches).
   */
  private getEnhancedPath(): string {
    const currentPath = process.env.PATH || '';
    const additionalPaths: string[] = [];

    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      additionalPaths.push(path.join(appData, 'npm'));
      additionalPaths.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm'));
      additionalPaths.push(path.join(os.homedir(), '.local', 'bin'));
      additionalPaths.push('C:\\Program Files\\GitHub CLI');
    } else {
      additionalPaths.push(path.join(os.homedir(), '.local', 'bin'));
      additionalPaths.push(path.join(os.homedir(), '.npm-global', 'bin'));
      additionalPaths.push('/usr/local/bin');
      additionalPaths.push('/opt/homebrew/bin');
    }

    const separator = process.platform === 'win32' ? ';' : ':';
    return [...additionalPaths, currentPath].join(separator);
  }

  private async checkInstallation(): Promise<{ installed: boolean; version?: string }> {
    return new Promise((resolve) => {
      try {
        logger.main.info('[GhCliDetector] Checking for gh installation...');

        const env = {
          ...process.env,
          PATH: this.getEnhancedPath(),
        };

        const child = spawn(ghCommand(), ['--version'], {
          timeout: this.spawnTimeoutMs,
          shell: true,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        let errorOutput = '';

        child.stdout?.on('data', (data) => {
          output += data.toString();
        });
        child.stderr?.on('data', (data) => {
          errorOutput += data.toString();
        });

        child.on('close', (code) => {
          if (code === 0 && output) {
            // `gh --version` first line: "gh version 2.45.0 (2024-03-04)"
            const firstLine = output.split('\n')[0]?.trim() ?? '';
            const match = firstLine.match(/gh version (\S+)/);
            const version = match?.[1];
            // logger.main.info('[GhCliDetector] gh installed, version:', version);
            resolve({ installed: true, version });
          } else {
            logger.main.info('[GhCliDetector] gh not installed. Exit:', code, 'stderr:', errorOutput);
            resolve({ installed: false });
          }
        });

        child.on('error', (error) => {
          logger.main.warn('[GhCliDetector] Failed to spawn gh:', error.message);
          resolve({ installed: false });
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'unknown';
        logger.main.error('[GhCliDetector] Installation check failed:', message);
        resolve({ installed: false });
      }
    });
  }

  private async checkAuth(): Promise<AuthCheck> {
    return new Promise((resolve) => {
      try {
        // logger.main.info('[GhCliDetector] Checking gh auth status...');

        const env = {
          ...process.env,
          PATH: this.getEnhancedPath(),
          NO_COLOR: '1',
        };

        const child = spawn(ghCommand(), ['auth', 'status'], {
          timeout: this.spawnTimeoutMs,
          shell: true,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        let errorOutput = '';

        child.stdout?.on('data', (data) => {
          output += data.toString();
        });
        child.stderr?.on('data', (data) => {
          errorOutput += data.toString();
        });

        child.on('exit', (code, signal) => {
          // The spawn timeout kills the shell, but gh under it keeps the pipes
          // open, so 'close' would still wait for gh to finish on its own.
          if (code === null && signal) {
            logger.main.warn(`[GhCliDetector] gh auth status timed out after ${this.spawnTimeoutMs}ms`);
            resolve({ authed: false, timedOut: true });
          }
        });

        child.on('close', (code, signal) => {
          if (code === null && signal) return; // answered on 'exit'
          // `gh auth status` writes to stderr historically, stdout on newer versions.
          const combined = `${output}\n${errorOutput}`;

          if (code === 0) {
            const parsed = parseAuthStatus(combined);
            logger.main.info('[GhCliDetector] gh authed:', parsed);
            resolve({ authed: true, ...parsed });
          } else {
            logger.main.info('[GhCliDetector] gh not authed. Exit:', code);
            resolve({ authed: false });
          }
        });

        child.on('error', (error) => {
          logger.main.warn('[GhCliDetector] Failed to run gh auth status:', error.message);
          resolve({ authed: false });
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'unknown';
        logger.main.error('[GhCliDetector] Auth check failed:', message);
        resolve({ authed: false });
      }
    });
  }

  private broadcastStatusChanged(status: GhCliStatus): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('pr:gh-status-changed', status);
      }
    }
  }
}

/**
 * Parse `gh auth status` output for the primary host + user.
 *
 * Modern output looks like:
 *   github.com
 *     ✓ Logged in to github.com account <user> (keyring)
 *     - Active account: true
 *     - Git operations protocol: ssh
 *     - Token: gho_************************************
 *     - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
 *
 * Older format:
 *   ✓ Logged in to github.com as <user> (oauth_token)
 */
function parseAuthStatus(text: string): { host?: string; user?: string } {
  // Modern: "Logged in to <host> account <user>"
  const modern = text.match(/Logged in to (\S+) account (\S+)/);
  if (modern) {
    return { host: modern[1], user: modern[2] };
  }
  // Legacy: "Logged in to <host> as <user>"
  const legacy = text.match(/Logged in to (\S+) as (\S+)/);
  if (legacy) {
    return { host: legacy[1], user: legacy[2] };
  }
  return {};
}

/**
 * Parse every account from `gh auth status` output, marking the active one.
 *
 * Each account appears as a "Logged in to <host> account <login>" line; the
 * following "Active account: true/false" line (when present) flags the active
 * one. Falls back to the legacy "Logged in to <host> as <login>" shape.
 */
export function parseAuthAccounts(
  text: string,
): Array<{ login: string; host: string; active: boolean }> {
  const accounts: Array<{ login: string; host: string; active: boolean }> = [];
  const re = /Logged in to (\S+) (?:account|as) (\S+)/g;
  const matches: Array<{ host: string; login: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({ host: m[1], login: m[2], index: m.index });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const block = text.slice(start, end);
    accounts.push({
      host: matches[i].host,
      login: matches[i].login,
      active: /Active account:\s*true/i.test(block),
    });
  }
  // Older gh without an "Active account" line: a single account is active.
  if (accounts.length === 1 && !/Active account:/i.test(text)) {
    accounts[0].active = true;
  }
  return accounts;
}

export const ghCliDetector = new GhCliDetector();
