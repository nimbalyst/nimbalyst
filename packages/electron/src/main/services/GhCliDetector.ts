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
  private cacheTimestamp: number = 0;

  async getStatus(): Promise<GhCliStatus> {
    const now = Date.now();
    if (this.cachedStatus && now - this.cacheTimestamp < CACHE_DURATION_MS) {
      return this.cachedStatus;
    }

    const installCheck = await this.checkInstallation();
    let authCheck: { authed: boolean; host?: string; user?: string } = { authed: false };
    if (installCheck.installed) {
      authCheck = await this.checkAuth();
    }

    const next: GhCliStatus = {
      installed: installCheck.installed,
      version: installCheck.version,
      authed: authCheck.authed,
      host: authCheck.host,
      user: authCheck.user,
    };

    const prev = this.cachedStatus;
    this.cachedStatus = next;
    this.cacheTimestamp = now;

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
    this.cacheTimestamp = 0;
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
          timeout: SPAWN_TIMEOUT_MS,
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
            logger.main.info('[GhCliDetector] gh installed, version:', version);
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

  private async checkAuth(): Promise<{ authed: boolean; host?: string; user?: string }> {
    return new Promise((resolve) => {
      try {
        logger.main.info('[GhCliDetector] Checking gh auth status...');

        const env = {
          ...process.env,
          PATH: this.getEnhancedPath(),
          NO_COLOR: '1',
        };

        const child = spawn(ghCommand(), ['auth', 'status'], {
          timeout: SPAWN_TIMEOUT_MS,
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

export const ghCliDetector = new GhCliDetector();
