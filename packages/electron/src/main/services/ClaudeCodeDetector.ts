import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../utils/logger';

export interface ClaudeCodeStatus {
  installed: boolean;
  loggedIn: boolean;
  version?: string;
  hasSession?: boolean;
  hasApiKey?: boolean;
}

/**
 * Service to detect Claude Code CLI installation and login status
 */
export class ClaudeCodeDetector {
  private cachedStatus: ClaudeCodeStatus | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_DURATION = 30000; // 30 seconds

  /**
   * Check if Claude Code CLI is installed
   */
  async isInstalled(): Promise<boolean> {
    const status = await this.getStatus();
    return status.installed;
  }

  /**
   * Check if user is logged in to Claude Code
   */
  async isLoggedIn(): Promise<boolean> {
    const status = await this.getStatus();
    return status.loggedIn;
  }

  /**
   * Get full installation and login status
   */
  async getStatus(): Promise<ClaudeCodeStatus> {
    const now = Date.now();

    // Return cached result if still valid
    if (this.cachedStatus && (now - this.cacheTimestamp) < this.CACHE_DURATION) {
      return this.cachedStatus;
    }

    // Check installation
    const installed = await this.checkInstallation();

    // Check login status
    const loginStatus = await this.checkLoginStatus();

    const status: ClaudeCodeStatus = {
      installed: installed.installed,
      version: installed.version,
      loggedIn: loginStatus.loggedIn,
      hasSession: loginStatus.hasSession,
      hasApiKey: loginStatus.hasApiKey,
    };

    // Cache the result
    this.cachedStatus = status;
    this.cacheTimestamp = now;

    return status;
  }

  /**
   * Clear the cache to force a fresh check
   */
  clearCache(): void {
    this.cachedStatus = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Get enhanced PATH that includes common Claude Code installation locations
   */
  private getEnhancedPath(): string {
    const currentPath = process.env.PATH || '';
    const additionalPaths: string[] = [];

    if (process.platform === 'win32') {
      // Windows: npm global bin is in %APPDATA%\npm
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      additionalPaths.push(path.join(appData, 'npm'));
      // Also check user profile path variant
      additionalPaths.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm'));
      // Native installer location
      additionalPaths.push(path.join(os.homedir(), '.local', 'bin'));
    } else {
      // macOS/Linux: ~/.local/bin for native installs
      additionalPaths.push(path.join(os.homedir(), '.local', 'bin'));
      // npm global paths
      additionalPaths.push(path.join(os.homedir(), '.npm-global', 'bin'));
      additionalPaths.push('/usr/local/bin');
    }

    const separator = process.platform === 'win32' ? ';' : ':';
    return [...additionalPaths, currentPath].join(separator);
  }

  /**
   * Check if the user has Claude Code CLI installed globally
   */
  private async checkInstallation(): Promise<{ installed: boolean; version?: string }> {
    return new Promise((resolve) => {
      try {
        // Try to run: claude --version
        logger.main.info('[ClaudeCodeDetector] Checking for Claude Code CLI installation...');

        const enhancedPath = this.getEnhancedPath();
        logger.main.info('[ClaudeCodeDetector] Using PATH:', enhancedPath);

        const env = {
          ...process.env,
          PATH: enhancedPath,
        };

        const childProcess = spawn('claude', ['--version'], {
          timeout: 10000,
          shell: true,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        let errorOutput = '';

        childProcess.stdout?.on('data', (data) => {
          output += data.toString();
        });

        childProcess.stderr?.on('data', (data) => {
          errorOutput += data.toString();
        });

        childProcess.on('close', (code) => {
          if (code === 0 && output) {
            const version = output.trim();
            logger.main.info('[ClaudeCodeDetector] CLI installed, version:', version);
            resolve({ installed: true, version });
          } else {
            logger.main.info('[ClaudeCodeDetector] CLI not installed or failed to run. Exit code:', code);
            if (errorOutput) {
              logger.main.info('[ClaudeCodeDetector] Error output:', errorOutput);
            }
            resolve({ installed: false });
          }
        });

        childProcess.on('error', (error) => {
          logger.main.error('[ClaudeCodeDetector] Failed to spawn claude:', error);
          resolve({ installed: false });
        });
      } catch (error) {
        logger.main.error('[ClaudeCodeDetector] Installation check failed:', error);
        resolve({ installed: false });
      }
    });
  }

  /**
   * Check login status by running `claude -p status`
   */
  private async checkLoginStatus(): Promise<{
    loggedIn: boolean;
    hasSession?: boolean;
    hasApiKey?: boolean;
  }> {
    return new Promise((resolve) => {
      try {
        logger.main.info('[ClaudeCodeDetector] Checking login status with claude -p status...');

        // Use enhanced PATH and set vars to indicate non-interactive mode
        const env = {
          ...process.env,
          PATH: this.getEnhancedPath(),
          TERM: 'dumb', // Indicate non-interactive terminal
          CI: 'true',   // Some CLIs use this to detect non-interactive mode
        };

        const childProcess = spawn('claude', ['-p', 'status'], {
          timeout: 10000, // 10 seconds should be enough - fails fast when not logged in
          shell: true,
          env,
          stdio: ['ignore', 'pipe', 'pipe'], // Ignore stdin, capture stdout/stderr
        });

        let output = '';
        let errorOutput = '';

        childProcess.stdout?.on('data', (data) => {
          output += data.toString();
        });

        childProcess.stderr?.on('data', (data) => {
          errorOutput += data.toString();
        });

        childProcess.on('close', (code) => {
          const combinedOutput = output + errorOutput;

          // If output contains "Invalid API key" or "Please run /login", user is not logged in
          if (combinedOutput.includes('Invalid API key') || combinedOutput.includes('Please run /login')) {
            logger.main.info('[ClaudeCodeDetector] User not logged in');
            resolve({ loggedIn: false });
          } else if (code === 0) {
            // Exit code 0 and no error message means logged in
            logger.main.info('[ClaudeCodeDetector] User is logged in (exit code 0)');
            resolve({ loggedIn: true, hasSession: true });
          } else if (code === 143 || code === null) {
            // Exit code 143 = SIGTERM timeout, or null = process was killed by timeout
            // The command times out when it's actually working (generating status output),
            // which only happens when logged in. When not logged in, it fails fast with
            // "Invalid API key" message.
            logger.main.info('[ClaudeCodeDetector] User is logged in (command timed out but was working)');
            resolve({ loggedIn: true, hasSession: true });
          } else {
            logger.main.info('[ClaudeCodeDetector] Unexpected output from status command:', combinedOutput, 'Exit code:', code);
            // Some other error
            logger.main.info('[ClaudeCodeDetector] Login status check failed, assuming not logged in');
            resolve({ loggedIn: false });
          }
        });

        childProcess.on('error', (error) => {
          logger.main.error('[ClaudeCodeDetector] Failed to run claude -p status:', error);
          resolve({ loggedIn: false });
        });
      } catch (error) {
        logger.main.error('[ClaudeCodeDetector] Login status check failed:', error);
        resolve({ loggedIn: false });
      }
    });
  }
}

// Singleton instance
export const claudeCodeDetector = new ClaudeCodeDetector();
