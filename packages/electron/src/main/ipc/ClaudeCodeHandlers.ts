import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { claudeCodeDetector } from '../services/ClaudeCodeDetector';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../utils/logger';
import { setupClaudeCodeEnvironment, resolveClaudeCodeExecutablePath } from '@nimbalyst/runtime/electron/claudeCodeEnvironment';
import { AnalyticsService } from "../services/analytics/AnalyticsService.ts";
import { shouldShowClaudeCodeWindowsWarning, dismissClaudeCodeWindowsWarning } from '../utils/store';
import os from "os";
import { safeHandle, safeOn } from '../utils/ipcRegistry';

// Use IPC component logger for this file
const log = logger.ipc;
const analytics = AnalyticsService.getInstance();

/**
 * Register Claude Code related IPC handlers
 */
export function registerClaudeCodeHandlers() {
  // Check if Claude Code is installed
  safeHandle('claude-code:check-installation', async () => {
    const status = await claudeCodeDetector.getStatus();
    return {
      installed: status.installed,
      version: status.version,
    };
  });

  // Get full Claude Code status
  safeHandle('claude-code:get-status', async () => {
    const status = await claudeCodeDetector.getStatus();
    return status;
  });

  // Refresh Claude Code detection (clears cache)
  safeHandle('claude-code:refresh-status', async () => {
    claudeCodeDetector.clearCache();
    const status = await claudeCodeDetector.getStatus();
    return status;
  });
  // Check login status
  safeHandle('claude-code:check-login', async () => {
    try {
      // Setup environment for packaged builds
      const env = setupClaudeCodeEnvironment();

      // Build options for query - CRITICAL: pass env to options so SDK can find credentials
      // This is especially important on Intel Macs where HOME may not be set correctly
      // in packaged builds without explicitly passing the environment.
      const nativeBinaryPath = resolveClaudeCodeExecutablePath({
        pathValue: env.PATH,
        allowSystemFallback: true,
      });
      const options: any = {
        env,
        ...(nativeBinaryPath ? { pathToClaudeCodeExecutable: nativeBinaryPath } : {}),
      };

      // Call query with proper signature: { prompt, options }
      // Use empty string prompt - SDK will write it directly without async iteration
      const session = query({
        prompt: '',
        options
      });

      // Get account info
      const accountInfo = await session.accountInfo();

      // If we got account info, user is logged in
      if (accountInfo && accountInfo.email) {
        analytics.sendEvent('check_claude_login_status', { isLoggedIn: true });
        return {
          isLoggedIn: true,
          hasOAuthToken: true,
          isExpired: false,
          email: accountInfo.email,
          organization: accountInfo.organization,
          subscriptionType: accountInfo.subscriptionType,
          tokenSource: accountInfo.tokenSource,
          apiKeySource: accountInfo.apiKeySource
        };
      }

      // No account info means not logged in
      analytics.sendEvent('check_claude_login_status', { isLoggedIn: false });
      return {
        isLoggedIn: false,
        hasOAuthToken: false,
        isExpired: true
      };
    } catch (error: any) {
      log.error('[ClaudeCodeHandlers] Login check failed:', error.message);
      analytics.sendEvent('check_claude_login_error');

      return {
        isLoggedIn: false,
        hasOAuthToken: false,
        isExpired: true,
        error: error.message
      };
    }
  });

  // Handle claude login command
  safeHandle('claude-code:login', async () => {
    try {
      const platform = process.platform;
      analytics.sendEvent('do_claude_code_login', {platform: platform});
      const binaryPath = resolveClaudeCodeExecutablePath({
        pathValue: setupClaudeCodeEnvironment().PATH,
        allowSystemFallback: true,
      }) ?? (platform === 'win32' ? findWindowsClaudeExecutable() : null);
      if (!binaryPath) {
        const expectedPkg = `@anthropic-ai/claude-agent-sdk-${platform}-${process.arch}`;
        throw new Error(`Claude Agent SDK native binary not found (looking for ${expectedPkg}, arch=${process.arch}). Check main.log for details.`);
      }

      if (platform === 'darwin') {
        const script = `
tell application "Terminal"
  activate
  do script "clear && echo 'Claude Code Authentication' && echo '' && echo 'Type /login and press Enter to authenticate.' && echo 'Complete the OAuth flow in your browser when prompted.' && echo 'When finished, type /quit to exit and close this window.' && echo '' && '${binaryPath}'"
end tell`;

        spawn('osascript', ['-e', script], {
          detached: true,
          stdio: 'ignore'
        }).unref();
      } else if (platform === 'win32') {
        spawn('cmd', ['/c', 'start', '"Claude Code Authentication"', 'cmd', '/k', `echo Claude Code Authentication && echo. && echo Type /login and press Enter to authenticate. && echo Complete the OAuth flow in your browser when prompted. && echo When finished, type /quit to exit and close this window. && echo. && "${binaryPath}"`], {
          detached: true,
          stdio: 'ignore',
          shell: true
        }).unref();
      } else {
        const terminals = ['gnome-terminal', 'konsole', 'xterm', 'x-terminal-emulator'];
        let terminalOpened = false;

        for (const terminal of terminals) {
          try {
            spawn(terminal, ['-e', `bash -c "clear; echo 'Claude Code Authentication'; echo ''; echo 'Type /login and press Enter to authenticate.'; echo 'Complete the OAuth flow in your browser when prompted.'; echo 'When finished, type /quit to exit.'; echo ''; '${binaryPath}'"`], {
              detached: true,
              stdio: 'ignore'
            }).unref();
            terminalOpened = true;
            break;
          } catch (error) {
            // Terminal not available, try next one
          }
        }

        if (!terminalOpened) {
          throw new Error('No terminal emulator found. Please run "' + binaryPath + '" manually and type /login to authenticate.');
        }
      }

      return {
        success: true,
        message: 'Terminal window opened. Type /login and press Enter to authenticate, then click "Refresh Status" to verify.'
      };
    } catch (error) {
      log.error('[ClaudeCodeHandlers] Login error:', error);
      throw error;
    }
  });

  // Handle claude logout command
  safeHandle('claude-code:logout', async () => {
    try {
      const platform = process.platform;
      analytics.sendEvent('do_claude_code_logout', {platform: platform});
      const binaryPath = resolveClaudeCodeExecutablePath({
        pathValue: setupClaudeCodeEnvironment().PATH,
        allowSystemFallback: true,
      }) ?? (platform === 'win32' ? findWindowsClaudeExecutable() : null);
      if (!binaryPath) {
        const expectedPkg = `@anthropic-ai/claude-agent-sdk-${platform}-${process.arch}`;
        throw new Error(`Claude Agent SDK native binary not found (looking for ${expectedPkg}, arch=${process.arch}). Check main.log for details.`);
      }

      if (platform === 'darwin') {
        const script = `
tell application "Terminal"
  activate
  do script "clear && echo 'Claude Code Logout' && echo '' && echo 'Type /logout and press Enter to logout:' && echo '' && '${binaryPath}'"
end tell`;

        spawn('osascript', ['-e', script], {
          detached: true,
          stdio: 'ignore'
        }).unref();
      } else if (platform === 'win32') {
        spawn('cmd', ['/c', 'start', '"Claude Code Logout"', 'cmd', '/k', `"${binaryPath}"`], {
          detached: true,
          stdio: 'ignore',
          shell: true
        }).unref();
      } else {
        const terminals = ['gnome-terminal', 'konsole', 'xterm', 'x-terminal-emulator'];
        let terminalOpened = false;

        for (const terminal of terminals) {
          try {
            spawn(terminal, ['-e', `bash -c "clear; echo 'Claude Code Logout'; echo ''; echo 'Type /logout and press Enter to logout:'; echo ''; '${binaryPath}'"`], {
              detached: true,
              stdio: 'ignore'
            }).unref();
            terminalOpened = true;
            break;
          } catch (error) {
            // Terminal not available, try next one
          }
        }

        if (!terminalOpened) {
          throw new Error('No terminal emulator found. Please run "' + binaryPath + '" manually and type /logout in your terminal.');
        }
      }

      return {
        success: true,
        message: 'Terminal window opened. Type /logout and press Enter to complete logout.'
      };
    } catch (error) {
      log.error('[ClaudeCodeHandlers] Logout error:', error);
      throw error;
    }
  });

  // Check if Windows Claude Code warning should be shown
  safeHandle('claude-code:should-show-windows-warning', async () => {
    return shouldShowClaudeCodeWindowsWarning();
  });

  // Dismiss Windows Claude Code warning permanently
  safeHandle('claude-code:dismiss-windows-warning', async () => {
    dismissClaudeCodeWindowsWarning();
    return { success: true };
  });
}

/**
 * Find the Claude Code executable on Windows
 * Checks native installer location and npm global location
 */
function findWindowsClaudeExecutable(): string | null {
  // Check native installer location first
  const nativePath = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(nativePath)) {
    log.info('[ClaudeCodeHandlers] Found Claude at native path:', nativePath);
    return nativePath;
  }

  // Check npm global bin directory (where claude.cmd is installed)
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const npmCmdPath = path.join(appData, 'npm', 'claude.cmd');
  if (fs.existsSync(npmCmdPath)) {
    log.info('[ClaudeCodeHandlers] Found Claude at npm path:', npmCmdPath);
    return npmCmdPath;
  }

  // Fallback: check the homedir variant
  const npmCmdPathAlt = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');
  if (fs.existsSync(npmCmdPathAlt)) {
    log.info('[ClaudeCodeHandlers] Found Claude at npm alt path:', npmCmdPathAlt);
    return npmCmdPathAlt;
  }

  log.error('[ClaudeCodeHandlers] Claude executable not found in any known location');
  return null;
}
