import { spawn, ChildProcess, exec, execSync } from 'child_process';
import { BrowserWindow } from 'electron';
import { openExternalInBackground } from '../utils/systemShell';
import { safeHandle } from '../utils/ipcRegistry';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import { createGit } from './gitClient';
import {AnalyticsService} from "./analytics/AnalyticsService.ts";
import { getAppSetting } from '../utils/store';
import { findExecutableInWindowsPath } from './WindowsPathResolver';
import { getEnhancedPath } from './shellEnvironment';

const execAsync = promisify(exec);

function findExecutableInPathEntries(
  executableNames: string[],
  pathValue: string
): string | undefined {
  const entries = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);

  for (const entry of entries) {
    for (const executableName of executableNames) {
      const candidate = path.join(entry, executableName);
      if (fsSync.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

interface InstallationStatus {
  installed: boolean;
  version?: string;
  updateAvailable?: boolean;
  path?: string;
  latestVersion?: string;
  claudeDesktopVersion?: string; // Version installed by Claude Desktop (if any)
}

export interface ClaudeForWindowsInstallation {
  isPlatformWindows: boolean;
  gitVersion?: string;
  claudeCodeVersion?: string;
}

interface NodeInstallProgress {
  percent: number;
  status: string;
  log?: string;
}

interface InstallOptions {
  localInstall?: boolean;
}

type CLITool =
  | 'claude-code'
  | 'openai-codex'
  | 'opencode'
  | 'copilot-cli'
  | 'grok-build'
  | 'cursor-agent';

/**
 * How a CLI gets onto the machine.
 *
 * `'npm'` tools are ones Nimbalyst installs, upgrades and uninstalls itself.
 * `'script'` tools ship only as a vendor install script; Nimbalyst does not
 * pipe a remote script to a shell, so the strategy is display-only — the
 * settings panel shows `command` and links `docsUrl`, and install/upgrade/
 * uninstall refuse. Detection is deliberately independent of all this: a tool
 * we cannot install is still a tool we must find.
 */
type CLIInstallStrategy =
  | { kind: 'npm'; package: string }
  | { kind: 'script'; command: string; docsUrl: string };

const CLI_INSTALL_STRATEGIES: Record<CLITool, CLIInstallStrategy> = {
  'claude-code': { kind: 'npm', package: '@anthropic-ai/claude-agent-sdk' },  // renamed from claude-code
  'openai-codex': { kind: 'npm', package: '@openai/codex' },
  'opencode': { kind: 'npm', package: 'opencode-ai' },      // npm: opencode-ai, binary: opencode
  'copilot-cli': { kind: 'npm', package: '@github/copilot' },  // npm: @github/copilot, binary: copilot
  'grok-build': {
    kind: 'script',
    command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    docsUrl: 'https://docs.x.ai/build/cli/headless-scripting',
  },
  'cursor-agent': {
    kind: 'script',
    command: 'curl -fsSL https://cursor.com/install | bash',
    docsUrl: 'https://cursor.com/docs/cli/using',
  },
};

function npmPackageFor(tool: CLITool): string {
  const strategy = CLI_INSTALL_STRATEGIES[tool];
  if (strategy.kind !== 'npm') {
    throw new Error(
      `${tool} is not an npm package. Install it with: ${strategy.command}`
    );
  }
  return strategy.package;
}

const CLI_COMMANDS: Record<CLITool, string> = {
  'claude-code': 'claude',        // The actual command once installed
  'openai-codex': 'codex',
  'opencode': 'opencode',
  'copilot-cli': 'copilot',
  'grok-build': 'grok',
  'cursor-agent': 'cursor-agent',  // NOT `agent`: both vendors symlink that name
};

/**
 * Where a script-installed CLI lands, beyond whatever is on the enhanced PATH.
 *
 * GUI-launched Electron does not inherit a login shell, so `~/.local/bin` and
 * friends are frequently absent from PATH even when the tool is installed and
 * working in the user's terminal. Probing the known locations directly is what
 * makes detection independent of install.
 */
const CLI_EXTRA_INSTALL_LOCATIONS: Partial<Record<CLITool, readonly string[]>> = {
  'grok-build': ['.grok/bin/grok', '.local/bin/grok'],
  'cursor-agent': ['.local/bin/cursor-agent'],
};

export class CLIManager {
  private installingTools = new Map<CLITool, ChildProcess>();
  private npmAvailable: boolean | null = null;

  constructor() {
    this.setupIPCHandlers();
  }

  private setupIPCHandlers() {
    safeHandle('cli:checkInstallation', async (_event, tool: CLITool) => {
      return this.checkInstallation(tool);
    });

    // Lets a settings panel render the vendor's install command for a tool
    // Nimbalyst cannot install itself, instead of offering a button that fails.
    safeHandle('cli:getInstallStrategy', async (_event, tool: CLITool) => {
      return CLI_INSTALL_STRATEGIES[tool] ?? null;
    });

    safeHandle('cli:install', async (_event, tool: CLITool, options: InstallOptions) => {
      return this.install(tool, options);
    });

    safeHandle('cli:uninstall', async (_event, tool: CLITool) => {
      return this.uninstall(tool);
    });

    safeHandle('cli:upgrade', async (_event, tool: CLITool) => {
      return this.upgrade(tool);
    });

    safeHandle('cli:checkNpmAvailable', async () => {
      return this.checkNpmAvailable();
    });

    safeHandle('cli:installNodeJs', async () => {
      return this.installNodeJs();
    });

    safeHandle('cli:checkClaudeCodeWindowsInstallation', async (): Promise<ClaudeForWindowsInstallation> => {
      return this.checkClaudeCodeWindowsInstallation();
    });
  }

  async checkNpmAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
    // Don't use cache - always check fresh to detect new installations
    console.log('[CLIManager] Checking npm availability...');
    console.log('[CLIManager] Current PATH:', process.env.PATH);
    console.log('[CLIManager] Enhanced PATH:', this.getEnhancedPath());

    try {

      // Try multiple approaches to find npm
      const enhancedPath = this.getEnhancedPath();

      // First try with enhanced PATH
      try {
        const version = execSync('npm --version', {
          encoding: 'utf8',
          env: { ...process.env, PATH: enhancedPath },
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        console.log('[CLIManager] ✓ npm found via enhanced PATH, version:', version);
        this.npmAvailable = true;
        return { available: true, version };
      } catch (e1: any) {
        console.log('[CLIManager] npm not found with enhanced PATH:', e1.message);
      }

      // Try with system PATH
      try {
        const version = execSync('npm --version', {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        console.log('[CLIManager] ✓ npm found in system PATH, version:', version);
        this.npmAvailable = true;
        return { available: true, version };
      } catch (e2: any) {
        console.log('[CLIManager] npm not found in system PATH:', e2.message);
      }

      // Try finding npm with where/which
      try {
        const findCommand = process.platform === 'win32' ? 'where' : 'which';
        const npmPath = execSync(`${findCommand} npm`, {
          encoding: 'utf8',
          env: { ...process.env, PATH: enhancedPath },
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim().split('\n')[0]; // Get first result

        console.log('[CLIManager] Found npm at:', npmPath);

        const version = execSync(`"${npmPath}" --version`, {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        console.log('[CLIManager] ✓ npm version:', version);
        this.npmAvailable = true;
        return { available: true, version };
      } catch (e3: any) {
        console.log('[CLIManager] which/where npm failed:', e3.message);
      }

      // Try common npm paths directly
      const commonPaths = process.platform === 'win32' ? [
        'C:\\Program Files\\nodejs\\npm.cmd',
        'C:\\Program Files (x86)\\nodejs\\npm.cmd',
        path.join(process.env.APPDATA || '', 'npm', 'npm.cmd'),
        path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'npm', 'npm.cmd')
      ] : [
        '/usr/local/bin/npm',
        '/usr/bin/npm',
        '/opt/homebrew/bin/npm',
        path.join(os.homedir(), '.npm-global', 'bin', 'npm'),
        '/snap/bin/npm'
      ];

      console.log('[CLIManager] Checking common paths:', commonPaths);

      for (const npmPath of commonPaths) {
        try {
          // Check if file exists
          await fs.access(npmPath, fs.constants.F_OK);
          console.log('[CLIManager] Found npm file at:', npmPath);

          const version = execSync(`"${npmPath}" --version`, {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();
          console.log('[CLIManager] ✓ npm at', npmPath, 'version:', version);
          this.npmAvailable = true;
          return { available: true, version };
        } catch (e) {
          // Continue checking
        }
      }

      // Not found anywhere
      this.npmAvailable = false;
      console.error('[CLIManager] ✗ npm not available after checking all paths');
      return {
        available: false,
        error: 'npm is not installed. Please install Node.js from nodejs.org to use this feature.'
      };
    } catch (error: any) {
      this.npmAvailable = false;
      console.error('[CLIManager] Error checking npm availability:', error.message);
      console.error('[CLIManager] Stack:', error.stack);
      return {
        available: false,
        error: 'npm is not installed. Please install Node.js from nodejs.org to use this feature.'
      };
    }
  }

  async checkGitInstallation(): Promise<{ gitInstalled: boolean; gitVersion?: string }> {
    try {
      const gitVersion = await createGit().version();
      if (!gitVersion.installed) {
        return { gitInstalled: false };
      }
      return { gitInstalled: true, gitVersion: String(gitVersion) };
    } catch (e) {
      return { gitInstalled: false };
    }
  }

  async checkClaudeCodeWindowsInstallation(): Promise<ClaudeForWindowsInstallation> {
    console.log('[CLIManager] Checking Claude for Windows installation...');
    if (process.platform !== 'win32') {
      return { isPlatformWindows: false };
    }
    const {gitVersion} = await this.checkGitInstallation();
    const enhancedPath = this.getEnhancedPath();

    // Check for Claude executable in common locations and on the enhanced PATH.
    // Windows npm installs typically expose `claude.cmd`, not `claude.exe`.
    const directExecutableCandidates = [
      path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
      path.join(os.homedir(), '.local', 'bin', 'claude.cmd'),
      path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      findExecutableInWindowsPath(['claude.cmd', 'claude.exe'], enhancedPath) || undefined,
      'claude',
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const claudePath of [...new Set(directExecutableCandidates)]) {
      try {
        const command = claudePath === 'claude' ? 'claude --version' : `"${claudePath}" --version`;
        const claudeCodeVersion = execSync(command, {
          encoding: 'utf8',
          env: { ...process.env, PATH: enhancedPath },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }).trim();
        return { isPlatformWindows: true, gitVersion, claudeCodeVersion };
      } catch (e) {
        // continue searching
      }
    }

    // Check for npm global installation (both old and new package names)
    // npm global on Windows is typically at %APPDATA%\npm\node_modules\
    const npmGlobalPaths = [
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code'),
    ];

    // Also try to get the dynamic npm root
    try {
      const globalNpmRoot = execSync('npm root -g', {
        encoding: 'utf8',
        env: { ...process.env, PATH: enhancedPath },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }).trim();
      if (globalNpmRoot) {
        npmGlobalPaths.unshift(path.join(globalNpmRoot, '@anthropic-ai', 'claude-agent-sdk'));
        npmGlobalPaths.unshift(path.join(globalNpmRoot, '@anthropic-ai', 'claude-code'));
      }
    } catch (e) {
      // Ignore error, will use fallback paths
    }

    for (const packagePath of npmGlobalPaths) {
      try {
        const packageJsonPath = path.join(packagePath, 'package.json');
        await fs.access(packageJsonPath, fsSync.constants.R_OK);
        // Found it, get version from package.json
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
        const claudeCodeVersion = packageJson.version || 'unknown';
        return { isPlatformWindows: true, gitVersion, claudeCodeVersion };
      } catch (e) {
        // continue searching
      }
    }

    return { isPlatformWindows: true, gitVersion };
  }

  private getCodexExecutableCandidates(enhancedPath: string): string[] {
    const candidates = new Set<string>();
    const addCandidate = (candidate: string | undefined) => {
      if (!candidate) return;
      candidates.add(candidate);
    };

    if (process.platform === 'win32') {
      addCandidate(path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'));
      addCandidate(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd'));
      addCandidate(path.join(os.homedir(), '.openai', 'codex', 'bin', 'codex.exe'));
      addCandidate(path.join(os.homedir(), '.openai', 'codex', 'bin', 'codex.cmd'));
      addCandidate(findExecutableInWindowsPath(['codex.cmd', 'codex.exe'], enhancedPath) || undefined);
      addCandidate('codex');
      return Array.from(candidates);
    }

    addCandidate(path.join(os.homedir(), '.openai', 'codex', 'bin', 'codex'));
    addCandidate(path.join(os.homedir(), '.local', 'bin', 'codex'));
    addCandidate(path.join(os.homedir(), '.npm-global', 'bin', 'codex'));
    addCandidate('/usr/local/bin/codex');
    addCandidate('/opt/homebrew/bin/codex');
    addCandidate(findExecutableInPathEntries(['codex'], enhancedPath));
    addCandidate('codex');
    return Array.from(candidates);
  }

  /**
   * Candidates for a CLI that Nimbalyst does not install: the enhanced PATH
   * first, then the vendor's known install locations, then the bare command as
   * a last resort (shell resolution may still find it).
   */
  private getScriptInstalledExecutableCandidates(
    tool: CLITool,
    enhancedPath: string
  ): string[] {
    const command = CLI_COMMANDS[tool];
    const candidates = new Set<string>();

    const fromPath = process.platform === 'win32'
      ? findExecutableInWindowsPath([`${command}.cmd`, `${command}.exe`], enhancedPath) || undefined
      : findExecutableInPathEntries([command], enhancedPath);
    if (fromPath) candidates.add(fromPath);

    for (const relativePath of CLI_EXTRA_INSTALL_LOCATIONS[tool] ?? []) {
      const absolute = path.join(os.homedir(), ...relativePath.split('/'));
      if (fsSync.existsSync(absolute)) candidates.add(absolute);
    }

    candidates.add(command);
    return Array.from(candidates);
  }

  private async checkVersionedExecutableInstallation(
    tool: CLITool,
    executableCandidates: string[],
    enhancedPath: string
  ): Promise<InstallationStatus> {
    for (const executablePath of executableCandidates) {
      try {
        const status = await new Promise<InstallationStatus>((resolve) => {
          const checkProcess = executablePath === CLI_COMMANDS[tool]
            ? spawn(executablePath, ['--version'], {
                shell: true,
                env: { ...process.env, PATH: enhancedPath },
                stdio: ['ignore', 'pipe', 'pipe'],
              })
            : spawn(executablePath, ['--version'], {
                shell: false,
                env: { ...process.env, PATH: enhancedPath },
                stdio: ['ignore', 'pipe', 'pipe'],
              });

          let output = '';
          let errorOutput = '';
          let settled = false;
          const finish = async (result: InstallationStatus) => {
            if (settled) return;
            settled = true;
            resolve(result);
          };

          checkProcess.stdout?.on('data', (data) => {
            output += data.toString();
          });

          checkProcess.stderr?.on('data', (data) => {
            errorOutput += data.toString();
          });

          checkProcess.on('close', async (code) => {
            const combinedOutput = `${output}\n${errorOutput}`.trim();
            if (code === 0 && combinedOutput) {
              const versionMatch = combinedOutput.match(/(\d+\.\d+\.\d+)/);
              const currentVersion = versionMatch ? versionMatch[1] : 'unknown';
              const latestVersion = await this.getLatestVersion(tool);
              const updateAvailable = !!(
                latestVersion &&
                currentVersion !== 'unknown' &&
                this.isNewerVersion(latestVersion, currentVersion)
              );

              await finish({
                installed: true,
                version: currentVersion,
                updateAvailable,
                path: executablePath,
                latestVersion: updateAvailable ? latestVersion : undefined,
              });
              return;
            }

            await finish({ installed: false });
          });

          checkProcess.on('error', async () => {
            await finish({ installed: false });
          });

          setTimeout(() => {
            checkProcess.kill();
            void finish({ installed: false });
          }, 5000);
        });

        if (status.installed) {
          return status;
        }
      } catch {
        // Continue checking other candidates
      }
    }

    return { installed: false };
  }

  async checkInstallation(tool: CLITool): Promise<InstallationStatus> {
    const command = CLI_COMMANDS[tool];

    // Special handling for claude - check common installation paths
    if (tool === 'claude-code') {
      // Get global npm root dynamically
      let globalNpmRoot: string | null = null;
      try {
          globalNpmRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch (error) {
        // Ignore error, will use fallback paths
      }

      // Check ONLY global npm locations that we manage
      // Don't check Claude Desktop's location - let user manage their own installation
      const claudePackagePaths = [
        // Dynamic global npm path (where we install it)
        ...(globalNpmRoot ? [path.join(globalNpmRoot, '@anthropic-ai', 'claude-agent-sdk')] : []),
        // Other common global locations
        path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
        path.join(os.homedir(), '.config', 'yarn', 'global', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
      ];

      // Also check if Claude Desktop has it installed (for display purposes)
      const claudeDesktopPath = path.join(os.homedir(), '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
      let claudeDesktopVersion: string | null = null;
      try {
        const packageJsonPath = path.join(claudeDesktopPath, 'package.json');
        await fs.access(packageJsonPath, fs.constants.R_OK);
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
        claudeDesktopVersion = packageJson.version;
      } catch (e) {
        // Claude Desktop version not found
      }

      // Check our managed global installations
      for (const claudePackagePath of claudePackagePaths) {
        try {
          // Check if the package exists by looking for package.json
          const packageJsonPath = path.join(claudePackagePath, 'package.json');
          await fs.access(packageJsonPath, fs.constants.R_OK);

          // Read the package.json to get version
          const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
          const currentVersion = packageJson.version || 'unknown';

          // Check for latest version
          const latestVersion = await this.getLatestVersion(tool);
          const updateAvailable = !!(latestVersion && currentVersion !== 'unknown' &&
                                this.isNewerVersion(latestVersion, currentVersion));

          return {
            installed: true,
            version: currentVersion,
            updateAvailable,
            path: claudePackagePath,
            latestVersion: updateAvailable ? latestVersion : undefined,
            claudeDesktopVersion: claudeDesktopVersion ?? undefined // Include this for UI display
          };
        } catch (e) {
          // Continue checking other paths
        }
      }

      // If not found in global, return not installed (even if Claude Desktop has it)
      return {
        installed: false,
        claudeDesktopVersion: claudeDesktopVersion ?? undefined // Include this for UI display
      };
    }

    // Special handling for openai-codex - check common installation paths
    if (tool === 'openai-codex') {
      return this.checkVersionedExecutableInstallation(
        tool,
        this.getCodexExecutableCandidates(this.getEnhancedPath()),
        this.getEnhancedPath()
      );
    }

    // Script-installed tools: probe known locations directly, because a
    // GUI-launched Electron often has no `~/.local/bin` on PATH.
    if (CLI_INSTALL_STRATEGIES[tool].kind === 'script') {
      return this.checkVersionedExecutableInstallation(
        tool,
        this.getScriptInstalledExecutableCandidates(tool, this.getEnhancedPath()),
        this.getEnhancedPath()
      );
    }

    // Default check for other tools
    return new Promise((resolve) => {
      const checkProcess = spawn(command, ['--version'], {
        shell: true,
        env: { ...process.env, PATH: this.getEnhancedPath() },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      let errorOutput = '';

      checkProcess.stdout?.on('data', (data) => {
        output += data.toString();
      });

      checkProcess.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      checkProcess.on('close', (code) => {
        if (code === 0 && output) {
          // Extract version from output
          const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
          resolve({
            installed: true,
            version: versionMatch ? versionMatch[1] : 'unknown',
            updateAvailable: false,  // Would need to check npm registry
            path: 'global'
          });
        } else {
          resolve({ installed: false });
        }
      });

      checkProcess.on('error', () => {
        resolve({ installed: false });
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        checkProcess.kill();
        resolve({ installed: false });
      }, 5000);
    });
  }

  async install(tool: CLITool, options: InstallOptions = {}): Promise<void> {
    // First check if npm is available
    const npmCheck = await this.checkNpmAvailable();
    if (!npmCheck.available) {
      throw new Error(npmCheck.error || 'npm is not available');
    }

    const packageName = npmPackageFor(tool);
    const isLocal = options.localInstall;

    // Check if already installing
    if (this.installingTools.has(tool)) {
      throw new Error(`${tool} is already being installed`);
    }

    // Check if we're using Homebrew's npm and need to configure prefix
    try {
      const npmPath = execSync('which npm', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const npmPrefix = execSync('npm config get prefix', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

      console.log('[CLIManager] npm path:', npmPath);
      console.log('[CLIManager] npm prefix:', npmPrefix);

      if (npmPath.includes('/opt/homebrew') || npmPrefix.includes('/opt/homebrew')) {
        console.log('[CLIManager] Detected Homebrew npm, configuring user-local prefix...');

        // Set up user-local npm prefix
        const userNpmPrefix = path.join(os.homedir(), '.npm-global');

        // Create the directory if it doesn't exist
        try {
          await fs.mkdir(userNpmPrefix, { recursive: true });
          await fs.mkdir(path.join(userNpmPrefix, 'bin'), { recursive: true });
        } catch (e) {
          // Directory might already exist
        }

        // Configure npm to use this prefix
        execSync(`npm config set prefix '${userNpmPrefix}'`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        console.log('[CLIManager] Set npm prefix to:', userNpmPrefix);

        this.sendProgressToRenderer(tool, {
          percent: 5,
          status: 'Configured npm for user-local installation',
          log: `npm prefix set to ${userNpmPrefix}`
        });

        // Add to PATH reminder
        this.sendProgressToRenderer(tool, {
          percent: 8,
          status: 'Important: Add to your PATH',
          log: `Add this to your ~/.zshrc or ~/.bash_profile:\nexport PATH="${userNpmPrefix}/bin:$PATH"`
        });
      }
    } catch (e) {
      console.log('[CLIManager] Could not check npm configuration:', e);
    }

    // Use execSync with a completely clean environment to avoid workspace detection
    return new Promise((resolve, reject) => {
      try {
  
        // Build the npm command - if we're using Homebrew npm with user prefix, it's still -g
        const npmCommand = `npm install -g ${packageName}`;

        // Send initial progress
        this.sendProgressToRenderer(tool, {
          percent: 10,
          status: 'Starting installation...',
          log: npmCommand
        });

        // Create a minimal environment that excludes npm workspace variables
        // Use os.homedir() instead of process.env.HOME for packaged builds on Intel Macs
        // where HOME may not be set correctly
        const homedir = os.homedir();
        const cleanEnv = {
          PATH: this.getEnhancedPath(),
          HOME: homedir,
          USERPROFILE: homedir, // Windows compatibility
          USER: process.env.USER || os.userInfo().username,
          SHELL: process.env.SHELL,
          TERM: process.env.TERM,
          // Explicitly exclude npm workspace-related environment variables
        };

        // Execute npm install with clean environment from user's home directory
        this.sendProgressToRenderer(tool, {
          percent: 30,
          status: 'Installing package globally...',
          log: 'This may take a few moments...'
        });

        const output = execSync(npmCommand, {
          encoding: 'utf8',
          cwd: os.homedir(), // Run from home directory
          env: cleanEnv, // Use minimal clean environment
          stdio: ['pipe', 'pipe', 'pipe'] // Capture all output
        });

        console.log('[CLIManager] Install output:', output);

        this.sendProgressToRenderer(tool, {
          percent: 70,
          status: 'Installation successful',
          log: output.trim()
        });

        // Verify installation
        this.sendProgressToRenderer(tool, {
          percent: 90,
          status: 'Verifying installation...',
          log: 'Checking installed version...'
        });

        this.checkInstallation(tool).then((status) => {
          if (status.installed) {
            this.sendProgressToRenderer(tool, {
              percent: 100,
              status: 'Installation complete!',
              log: `${tool} v${status.version} installed successfully`
            });
            resolve();
          } else {
            reject(new Error('Installation verification failed'));
          }
        }).catch(reject);

      } catch (error: any) {
        console.error('[CLIManager] Install error:', error);
        this.sendProgressToRenderer(tool, {
          percent: 0,
          status: 'Installation failed',
          log: error.message || 'Unknown error occurred'
        });
        reject(error);
      }
    });
  }

  async uninstall(tool: CLITool): Promise<void> {
    // First check if npm is available
    const npmCheck = await this.checkNpmAvailable();
    if (!npmCheck.available) {
      throw new Error(npmCheck.error || 'npm is not available');
    }

    const packageName = npmPackageFor(tool);

    return new Promise((resolve, reject) => {
      try {
  
        // Build the npm command
        const npmCommand = `npm uninstall -g ${packageName}`;

        // Create a minimal environment that excludes npm workspace variables
        // Use os.homedir() instead of process.env.HOME for packaged builds on Intel Macs
        const homedir = os.homedir();
        const cleanEnv = {
          PATH: this.getEnhancedPath(),
          HOME: homedir,
          USERPROFILE: homedir, // Windows compatibility
          USER: process.env.USER || os.userInfo().username,
          SHELL: process.env.SHELL,
          TERM: process.env.TERM,
        };

        console.log(`[CLIManager] Uninstalling ${packageName}...`);
        console.log(`[CLIManager] Working directory: ${os.homedir()}`);
        console.log(`[CLIManager] Command: ${npmCommand}`);

        // Execute npm uninstall with clean environment from user's home directory
        // Use inherit for stderr to see errors immediately
        const output = execSync(npmCommand, {
          encoding: 'utf8',
          cwd: os.homedir(), // Run from home directory
          env: cleanEnv, // Use minimal clean environment
          stdio: ['pipe', 'pipe', 'pipe']
        });

        console.log('[CLIManager] Uninstall output:', output || '(no output)');

        // Check if package was actually removed
        if (output.includes('removed') || output.includes('uninstalled')) {
          console.log('[CLIManager] Package successfully uninstalled');
        } else if (output.includes('up to date')) {
          console.log('[CLIManager] Package was not installed or already removed');
        }

        resolve();

      } catch (error: any) {
        console.error('[CLIManager] Uninstall error:', error.message);
        if (error.stdout) {
          console.error('[CLIManager] Stdout:', error.stdout);
        }
        if (error.stderr) {
          console.error('[CLIManager] Stderr:', error.stderr);
        }
        reject(error);
      }
    });
  }

  private sendProgressToRenderer(tool: CLITool, progress: any) {
    // Send to all windows
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send(`cli-install-progress-${tool}`, progress);
    });
  }

  private async getLatestVersion(tool: CLITool): Promise<string | null> {
    // Script-installed tools have their own updaters and no registry to query;
    // "no known latest" is the honest answer rather than a thrown error in the
    // middle of a detection pass.
    if (CLI_INSTALL_STRATEGIES[tool].kind !== 'npm') return null;
    const packageName = npmPackageFor(tool);

    try {
      const { stdout } = await execAsync(`npm view ${packageName} version`);
      return stdout.trim();
    } catch (error) {
      console.error(`[CLIManager] Failed to get latest version for ${tool}:`, error);
      return null;
    }
  }

  private isNewerVersion(latest: string, current: string): boolean {
    try {
      const latestParts = latest.split('.').map(Number);
      const currentParts = current.split('.').map(Number);

      for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
        const latestPart = latestParts[i] || 0;
        const currentPart = currentParts[i] || 0;

        if (latestPart > currentPart) return true;
        if (latestPart < currentPart) return false;
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  async upgrade(tool: CLITool): Promise<void> {
    // First check if npm is available
    const npmCheck = await this.checkNpmAvailable();
    if (!npmCheck.available) {
      throw new Error(npmCheck.error || 'npm is not available');
    }

    const packageName = npmPackageFor(tool);

    return new Promise((resolve, reject) => {
      try {
  
        // Build the npm command - use install with @latest to ensure we get the latest version
        const npmCommand = `npm install -g ${packageName}@latest`;

        // Send progress updates
        this.sendProgressToRenderer(tool, {
          percent: 10,
          status: 'Checking for updates...',
          log: npmCommand
        });

        // Create a minimal environment that excludes npm workspace variables
        // Use os.homedir() instead of process.env.HOME for packaged builds on Intel Macs
        const homedir = os.homedir();
        const cleanEnv = {
          PATH: this.getEnhancedPath(),
          HOME: homedir,
          USERPROFILE: homedir, // Windows compatibility
          USER: process.env.USER || os.userInfo().username,
          SHELL: process.env.SHELL,
          TERM: process.env.TERM,
        };

        this.sendProgressToRenderer(tool, {
          percent: 30,
          status: 'Updating package...',
          log: 'This may take a few moments...'
        });

        // Execute npm install @latest with clean environment from user's home directory
        const output = execSync(npmCommand, {
          encoding: 'utf8',
          cwd: os.homedir(), // Run from home directory
          env: cleanEnv, // Use minimal clean environment
          stdio: ['pipe', 'pipe', 'pipe']
        });

        console.log('[CLIManager] Update output:', output);

        this.sendProgressToRenderer(tool, {
          percent: 100,
          status: 'Update complete!',
          log: `Successfully updated ${tool}`
        });

        resolve();

      } catch (error: any) {
        console.error('[CLIManager] Update error:', error);
        this.sendProgressToRenderer(tool, {
          percent: 0,
          status: 'Update failed',
          log: error.message || 'Unknown error occurred'
        });
        reject(error);
      }
    });
  }

  async installNodeJs(): Promise<void> {
    const platform = process.platform;

    return new Promise((resolve, reject) => {
      try {
  
        this.sendProgressToRenderer('nodejs' as CLITool, {
          percent: 10,
          status: 'Starting Node.js installation...',
          log: 'Detecting platform and package manager...'
        });

        if (platform === 'darwin') {
          // macOS - DO NOT use Homebrew for Node.js! It creates permission issues.
          // Direct users to download the official installer for user-local installation.

          this.sendProgressToRenderer('nodejs' as CLITool, {
            percent: 30,
            status: 'Opening Node.js download page...',
            log: 'Please download the macOS installer from nodejs.org'
          });

          // Check if user has Homebrew Node.js and warn them
          try {
            const whichNode = execSync('which node', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            if (whichNode.includes('/opt/homebrew') || whichNode.includes('/usr/local/Cellar')) {
              this.sendProgressToRenderer('nodejs' as CLITool, {
                percent: 0,
                status: 'Warning: Homebrew Node.js detected',
                log: '⚠️ You have Node.js installed via Homebrew which causes permission issues.\nPlease uninstall it with: brew uninstall node\nThen install from nodejs.org'
              });
            }
          } catch (e) {
            // Node not found, which is fine
          }

          openExternalInBackground('https://nodejs.org/en/download/');

          reject(new Error('Please download and install Node.js from the opened webpage (NOT via Homebrew), then restart Nimbalyst.'));
        } else if (platform === 'win32') {
          // Windows - download the installer
          this.sendProgressToRenderer('nodejs' as CLITool, {
            percent: 30,
            status: 'Opening Node.js download page...',
            log: 'Please download and run the Windows installer'
          });

          openExternalInBackground('https://nodejs.org/en/download/');

          reject(new Error('Please download and install Node.js from the opened webpage, then restart Nimbalyst.'));
        } else if (platform === 'linux') {
          // Linux - try package managers
          this.sendProgressToRenderer('nodejs' as CLITool, {
            percent: 30,
            status: 'Installing Node.js via package manager...',
            log: 'Attempting installation...'
          });

          // Try different package managers
          const packageManagers = [
            { cmd: 'apt-get', install: 'sudo apt-get update && sudo apt-get install -y nodejs npm' },
            { cmd: 'yum', install: 'sudo yum install -y nodejs npm' },
            { cmd: 'dnf', install: 'sudo dnf install -y nodejs npm' },
            { cmd: 'pacman', install: 'sudo pacman -S --noconfirm nodejs npm' },
            { cmd: 'snap', install: 'sudo snap install node --classic' }
          ];

          let installed = false;
          for (const pm of packageManagers) {
            try {
              execSync(`which ${pm.cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

              this.sendProgressToRenderer('nodejs' as CLITool, {
                percent: 50,
                status: `Found ${pm.cmd}, installing Node.js...`,
                log: pm.install
              });

              execSync(pm.install, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
              });

              installed = true;
              break;
            } catch (e) {
              // Try next package manager
            }
          }

          if (!installed) {
              openExternalInBackground('https://nodejs.org/en/download/');
            reject(new Error('Could not install Node.js automatically. Please install from the opened webpage.'));
            return;
          }

          this.sendProgressToRenderer('nodejs' as CLITool, {
            percent: 100,
            status: 'Node.js installed successfully!',
            log: 'Installation complete'
          });

          // Clear the cached npm availability
          this.npmAvailable = null;
          resolve();
        } else {
          reject(new Error(`Unsupported platform: ${platform}`));
        }
      } catch (error: any) {
        console.error('[CLIManager] Node.js install error:', error);
        this.sendProgressToRenderer('nodejs' as CLITool, {
          percent: 0,
          status: 'Installation failed',
          log: error.message || 'Unknown error occurred'
        });
        reject(error);
      }
    });
  }

  private getEnhancedPath(): string {
    return getEnhancedPath();
  }

  // Clean up on app quit
  cleanup() {
    this.installingTools.forEach((process, tool) => {
      console.log(`[CLIManager] Killing installation process for ${tool}`);
      process.kill();
    });
    this.installingTools.clear();
  }
}

// Export singleton
export const cliManager = new CLIManager();
