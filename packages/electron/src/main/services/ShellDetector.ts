/**
 * ShellDetector - Cross-platform shell detection utility
 *
 * Detects the user's default shell on macOS, Linux, and Windows.
 * On macOS, uses Directory Services for accurate detection (not just $SHELL).
 * On Windows, prefers PowerShell Core, then PowerShell, then cmd.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, execSync } from 'child_process';
import { findExecutableInWindowsPath, getEnhancedWindowsPath } from './WindowsPathResolver';
import { getAppSetting } from '../utils/store';

export interface ShellInfo {
  path: string;
  name: string;
  args: string[];
  provider?: string;
  bootstrapMode?: 'zsh' | 'bash' | 'powershell' | 'none';
  cwdMode?: 'native' | 'wsl';
}

export type TerminalShellPreference = 'auto' | 'pwsh' | 'powershell' | 'git-bash' | 'wsl' | 'cmd';

export class ShellDetector {
  /**
   * Get the user's default shell with appropriate arguments
   */
  static getDefaultShell(): ShellInfo {
    if (process.platform === 'win32') {
      return this.detectWindowsShell();
    }
    return this.detectUnixShell();
  }

  /**
   * Get all detected shells for the current platform.
   */
  static getAvailableShells(): ShellInfo[] {
    if (process.platform === 'win32') {
      return this.detectWindowsShells();
    }
    return [this.detectUnixShell()];
  }

  /**
   * Detect shell on Unix-like systems (macOS, Linux)
   */
  private static detectUnixShell(): ShellInfo {
    // Try SHELL environment variable first
    const envShell = process.env.SHELL;
    if (envShell && fs.existsSync(envShell)) {
      const shellName = path.basename(envShell);
      return {
        path: envShell,
        name: shellName,
        args: ['-i'], // Interactive mode for proper prompt
        provider: shellName,
        bootstrapMode: this.getUnixBootstrapMode(shellName),
        cwdMode: 'native',
      };
    }

    // macOS: Query Directory Services for accurate shell detection
    if (process.platform === 'darwin') {
      try {
        const username = os.userInfo().username;
        const result = execSync(`dscl . -read /Users/${username} UserShell`, {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const match = result.match(/UserShell:\s*(.+)/);
        if (match?.[1] && fs.existsSync(match[1].trim())) {
          const shellPath = match[1].trim();
          const shellName = path.basename(shellPath);
          return {
            path: shellPath,
            name: shellName,
            args: ['-i'],
            provider: shellName,
            bootstrapMode: this.getUnixBootstrapMode(shellName),
            cwdMode: 'native',
          };
        }
      } catch {
        // Fall through to fallback
      }
    }

    // Linux: Check /etc/passwd or fallback to common shells
    if (process.platform === 'linux') {
      try {
        const passwdContent = fs.readFileSync('/etc/passwd', 'utf8');
        const username = os.userInfo().username;
        const userLine = passwdContent
          .split('\n')
          .find((line) => line.startsWith(`${username}:`));
        if (userLine) {
          const shellPath = userLine.split(':').pop()?.trim();
          if (shellPath && fs.existsSync(shellPath)) {
            const shellName = path.basename(shellPath);
            return {
              path: shellPath,
              name: shellName,
              args: ['-i'],
              provider: shellName,
              bootstrapMode: this.getUnixBootstrapMode(shellName),
              cwdMode: 'native',
            };
          }
        }
      } catch {
        // Fall through to fallback
      }
    }

    // Fallback to common shells
    const commonShells = ['/bin/zsh', '/bin/bash', '/bin/sh'];
    for (const shell of commonShells) {
      if (fs.existsSync(shell)) {
        const shellName = path.basename(shell);
        return {
          path: shell,
          name: shellName,
          args: ['-i'],
          provider: shellName,
          bootstrapMode: this.getUnixBootstrapMode(shellName),
          cwdMode: 'native',
        };
      }
    }

    // Last resort
    return {
      path: '/bin/sh',
      name: 'sh',
      args: ['-i'],
      provider: 'sh',
      bootstrapMode: this.getUnixBootstrapMode('sh'),
      cwdMode: 'native',
    };
  }

  /**
   * Detect shell on Windows
   */
  private static detectWindowsShell(): ShellInfo {
    const detectedShells = this.detectWindowsShells();
    const preferredShell = getAppSetting<TerminalShellPreference>('preferredTerminalShell');
    if (preferredShell && preferredShell !== 'auto') {
      const matchingShell = detectedShells.find(shell => shell.provider === preferredShell);
      if (matchingShell) {
        return matchingShell;
      }
    }

    return detectedShells[0] ?? {
      path: process.env.ComSpec || 'cmd.exe',
      name: 'cmd',
      args: [],
      provider: 'cmd',
      bootstrapMode: 'none',
      cwdMode: 'native',
    };
  }

  private static detectWindowsShells(): ShellInfo[] {
    const shells: ShellInfo[] = [];
    const seen = new Set<string>();
    const enhancedPath = getEnhancedWindowsPath();
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';

    const addShell = (shell: ShellInfo | null) => {
      if (!shell) return;
      const key = shell.path.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      shells.push(shell);
    };

    addShell(this.detectPowerShellCore(enhancedPath, programFiles, programFilesX86));
    addShell(this.detectGitBash(enhancedPath, programFiles, programFilesX86));
    addShell(this.detectWsl(enhancedPath, systemRoot));
    addShell(this.detectWindowsPowerShell(enhancedPath, systemRoot));
    addShell(this.detectCmd(systemRoot));

    return shells;
  }

  private static detectPowerShellCore(enhancedPath: string, programFiles: string, programFilesX86: string): ShellInfo | null {
    const pwsh = this.resolveWindowsExecutable([
      findExecutableInWindowsPath('pwsh.exe', enhancedPath),
      path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      path.join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
    ]);
    if (!pwsh) return null;
    return {
      path: pwsh,
      name: 'pwsh',
      args: ['-NoExit', '-NoLogo'],
      provider: 'pwsh',
      bootstrapMode: 'powershell',
      cwdMode: 'native',
    };
  }

  private static detectWindowsPowerShell(enhancedPath: string, systemRoot: string): ShellInfo | null {
    const powershell = this.resolveWindowsExecutable([
      findExecutableInWindowsPath('powershell.exe', enhancedPath),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ]);
    if (!powershell) return null;
    return {
      path: powershell,
      name: 'powershell',
      args: ['-NoExit', '-NoLogo'],
      provider: 'powershell',
      bootstrapMode: 'powershell',
      cwdMode: 'native',
    };
  }

  private static detectGitBash(enhancedPath: string, programFiles: string, programFilesX86: string): ShellInfo | null {
    const pathCandidate = findExecutableInWindowsPath('bash.exe', enhancedPath);
    const gitPathCandidate = pathCandidate && pathCandidate.toLowerCase().includes('\\git\\') ? pathCandidate : null;
    const gitExe = findExecutableInWindowsPath('git.exe', enhancedPath);
    const inferredGitRoot = gitExe ? this.inferGitInstallRoot(gitExe) : null;

    const bash = this.resolveWindowsExecutable([
      gitPathCandidate,
      inferredGitRoot ? path.join(inferredGitRoot, 'bin', 'bash.exe') : null,
      inferredGitRoot ? path.join(inferredGitRoot, 'usr', 'bin', 'bash.exe') : null,
      path.join(programFiles, 'Git', 'bin', 'bash.exe'),
      path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
      path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
      path.join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'),
    ]);

    if (!bash) return null;
    return {
      path: bash,
      name: 'git-bash',
      args: ['--login', '-i'],
      provider: 'git-bash',
      bootstrapMode: 'bash',
      cwdMode: 'native',
    };
  }

  private static detectWsl(enhancedPath: string, systemRoot: string): ShellInfo | null {
    const wsl = this.resolveWindowsExecutable([
      findExecutableInWindowsPath('wsl.exe', enhancedPath),
      path.join(systemRoot, 'System32', 'wsl.exe'),
    ]);
    if (!wsl || !this.hasInstalledWslDistribution(wsl)) {
      return null;
    }

    const defaultWslShell = this.detectDefaultWslShell(wsl);
    const wslShellName = defaultWslShell ? path.posix.basename(defaultWslShell) : 'shell';
    const bootstrapMode = this.getUnixBootstrapMode(wslShellName);
    return {
      path: wsl,
      name: defaultWslShell ? `wsl-${wslShellName}` : 'wsl',
      args: defaultWslShell ? ['--exec', defaultWslShell, '-il'] : [],
      provider: 'wsl',
      bootstrapMode,
      cwdMode: 'wsl',
    };
  }

  private static detectCmd(systemRoot: string): ShellInfo {
    const cmdPath = process.env.ComSpec && fs.existsSync(process.env.ComSpec)
      ? process.env.ComSpec
      : path.join(systemRoot, 'System32', 'cmd.exe');
    return {
      path: cmdPath,
      name: 'cmd',
      args: [],
      provider: 'cmd',
      bootstrapMode: 'none',
      cwdMode: 'native',
    };
  }

  private static inferGitInstallRoot(gitExecutable: string): string | null {
    const normalized = path.win32.normalize(gitExecutable);
    const parent = path.win32.dirname(normalized);
    const parentName = path.win32.basename(parent).toLowerCase();
    if (parentName === 'cmd' || parentName === 'bin') {
      return path.win32.dirname(parent);
    }
    return null;
  }

  private static hasInstalledWslDistribution(wslPath: string): boolean {
    try {
      const result = execFileSync(wslPath, ['-l', '-q'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return result.length > 0;
    } catch {
      return false;
    }
  }

  private static detectDefaultWslShell(wslPath: string): string | null {
    try {
      const result = execFileSync(wslPath, [
        'sh',
        '-lc',
        'getent passwd "$(id -un)" | cut -d: -f7 2>/dev/null || printf "%s" "$SHELL"',
      ], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (!result.startsWith('/')) {
        return null;
      }
      return result;
    } catch {
      return null;
    }
  }

  private static resolveWindowsExecutable(candidates: Array<string | null | undefined>): string | null {
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private static getUnixBootstrapMode(shellName: string): NonNullable<ShellInfo['bootstrapMode']> {
    const normalized = shellName.toLowerCase();
    if (normalized.includes('zsh')) {
      return 'zsh';
    }
    if (normalized.includes('bash') || normalized === 'sh') {
      return 'bash';
    }
    return 'none';
  }
}
