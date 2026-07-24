import { spawn, ChildProcess, exec, execSync } from 'child_process';
import { BrowserWindow, shell } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import { simpleGit } from 'simple-git';
import {AnalyticsService} from "./analytics/AnalyticsService.ts";
import { getAppSetting } from '../utils/store';
import { findExecutableInWindowsPath, getEnhancedWindowsPath } from './WindowsPathResolver';

const execAsync = promisify(exec);

// Cache for dynamically detected paths (populated asynchronously at startup)
interface DetectedPaths {
  homebrewPrefix?: string;
  homebrewNodePath?: string;
  nvmBinPath?: string;
  shellPath?: string;
  npmPrefix?: string;
  yarnBin?: string;
}

let cachedDetectedPaths: DetectedPaths | null = null;
let pathDetectionPromise: Promise<DetectedPaths> | null = null;

// Cache for the full shell environment (populated alongside path detection)
// Contains all env vars from the user's login shell EXCEPT PATH (which has special handling)
let cachedShellEnvironment: Record<string, string> | null = null;

function getPotentialNodeModulesDirs(): string[] {
  const dirs: string[] = [];

  // Start from cwd and walk up to find hoisted node_modules directories.
  let currentDir = process.cwd();
  for (let i = 0; i < 8; i++) {
    dirs.push(path.join(currentDir, 'node_modules'));
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  // Packaged app locations.
  if (process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'));
    dirs.push(path.join(process.resourcesPath, 'node_modules'));
  }

  return [...new Set(dirs)];
}

function resolveAnthropicRipgrepDir(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  let binaryDir: string | null = null;
  if (platform === 'darwin') {
    binaryDir = arch === 'arm64' ? 'arm64-darwin' : 'x64-darwin';
  } else if (platform === 'linux') {
    binaryDir = arch === 'arm64' ? 'arm64-linux' : 'x64-linux';
  } else if (platform === 'win32') {
    binaryDir = arch === 'arm64' ? 'arm64-win32' : 'x64-win32';
  }

  if (!binaryDir) return null;

  const binaryName = platform === 'win32' ? 'rg.exe' : 'rg';
  for (const nodeModulesDir of getPotentialNodeModulesDirs()) {
    const binaryPath = path.join(
      nodeModulesDir,
      '@anthropic-ai',
      'claude-agent-sdk',
      'vendor',
      'ripgrep',
      binaryDir,
      binaryName
    );
    if (fsSync.existsSync(binaryPath)) {
      return path.dirname(binaryPath);
    }
  }

  return null;
}

function resolveOpenAICodexRipgrepDir(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  let packageName: string | null = null;
  let targetTriple: string | null = null;

  if (platform === 'darwin' && arch === 'arm64') {
    packageName = 'codex-darwin-arm64';
    targetTriple = 'aarch64-apple-darwin';
  } else if (platform === 'darwin' && arch === 'x64') {
    packageName = 'codex-darwin-x64';
    targetTriple = 'x86_64-apple-darwin';
  } else if (platform === 'linux' && arch === 'arm64') {
    packageName = 'codex-linux-arm64';
    targetTriple = 'aarch64-unknown-linux-musl';
  } else if (platform === 'linux' && arch === 'x64') {
    packageName = 'codex-linux-x64';
    targetTriple = 'x86_64-unknown-linux-musl';
  } else if (platform === 'win32' && arch === 'arm64') {
    packageName = 'codex-win32-arm64';
    targetTriple = 'aarch64-pc-windows-msvc';
  } else if (platform === 'win32' && arch === 'x64') {
    packageName = 'codex-win32-x64';
    targetTriple = 'x86_64-pc-windows-msvc';
  }

  if (!packageName || !targetTriple) return null;

  const binaryName = platform === 'win32' ? 'rg.exe' : 'rg';
  for (const nodeModulesDir of getPotentialNodeModulesDirs()) {
    const binaryPath = path.join(
      nodeModulesDir,
      '@openai',
      packageName,
      'vendor',
      targetTriple,
      'path',
      binaryName
    );
    if (fsSync.existsSync(binaryPath)) {
      return path.dirname(binaryPath);
    }
  }

  return null;
}

function getVendoredRipgrepDirs(): string[] {
  const dirs: string[] = [];

  const openAIRipgrepDir = resolveOpenAICodexRipgrepDir();
  if (openAIRipgrepDir) {
    dirs.push(openAIRipgrepDir);
  }

  const anthropicRipgrepDir = resolveAnthropicRipgrepDir();
  if (anthropicRipgrepDir) {
    dirs.push(anthropicRipgrepDir);
  }

  return dirs;
}

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

type CLITool = 'claude-code' | 'openai-codex' | 'opencode' | 'copilot-cli';

// CLI commands and their npm packages
const CLI_PACKAGES: Record<CLITool, string> = {
  'claude-code': '@anthropic-ai/claude-agent-sdk',  // Claude Agent SDK (renamed from claude-code)
  'openai-codex': '@openai/codex',                   // OpenAI Codex package (actual on npm!)
  'opencode': 'opencode-ai',                           // OpenCode open source agent (npm: opencode-ai, binary: opencode)
  'copilot-cli': '@github/copilot',                       // GitHub Copilot CLI (npm: @github/copilot, binary: copilot)
};

const CLI_COMMANDS: Record<CLITool, string> = {
  'claude-code': 'claude',     // The actual command once installed
  'openai-codex': 'codex',     // The actual command once installed
  'opencode': 'opencode',      // The actual command once installed
  'copilot-cli': 'copilot',    // The actual command once installed
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
      const gitVersion = await simpleGit().version();
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

    const packageName = CLI_PACKAGES[tool];
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

    const packageName = CLI_PACKAGES[tool];

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
    const packageName = CLI_PACKAGES[tool];

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

    const packageName = CLI_PACKAGES[tool];

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

          shell.openExternal('https://nodejs.org/en/download/');

          reject(new Error('Please download and install Node.js from the opened webpage (NOT via Homebrew), then restart Nimbalyst.'));
        } else if (platform === 'win32') {
          // Windows - download the installer
          this.sendProgressToRenderer('nodejs' as CLITool, {
            percent: 30,
            status: 'Opening Node.js download page...',
            log: 'Please download and run the Windows installer'
          });

          shell.openExternal('https://nodejs.org/en/download/');

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
              shell.openExternal('https://nodejs.org/en/download/');
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

/**
 * Parse null-byte separated environment output from `env -0`.
 * Each entry is KEY=VALUE separated by \0.
 * Handles multiline values safely since \0 is the only delimiter.
 */
function parseNullSeparatedEnv(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  const entries = output.split('\0');

  for (const entry of entries) {
    if (!entry) continue;

    const eqIndex = entry.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = entry.substring(0, eqIndex);
    const value = entry.substring(eqIndex + 1);

    // Only accept valid env var names
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    env[key] = value;
  }

  return env;
}

/**
 * Asynchronously detect paths for Homebrew, nvm, npm, yarn, and shell environment.
 * This runs the expensive shell commands once and caches the results.
 */
async function detectPaths(): Promise<DetectedPaths> {
  const detected: DetectedPaths = {};
  const homeDir = os.homedir();

  if (process.platform === 'darwin' || process.platform === 'linux') {
    // Detect full shell environment (PATH + credentials, certificates, etc.)
    // Uses `env -0` for null-separated output to safely handle multiline values
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const shellName = path.basename(shell);

      let command: string;
      if (shellName === 'zsh') {
        const sourceCommand =
          `source /etc/zprofile 2>/dev/null || true; ` +
          `source ${homeDir}/.zprofile 2>/dev/null || true; ` +
          `source /etc/zshrc 2>/dev/null || true; ` +
          `source ${homeDir}/.zshrc 2>/dev/null || true; `;
        command = `${shell} -c '${sourceCommand}env -0'`;
      } else if (shellName === 'bash') {
        const sourceCommand =
          `source /etc/profile 2>/dev/null || true; ` +
          `source ${homeDir}/.bash_profile 2>/dev/null || true; ` +
          `source ${homeDir}/.bashrc 2>/dev/null || true; `;
        command = `${shell} -c '${sourceCommand}env -0'`;
      } else {
        command = `${shell} -ilc 'env -0' 2>/dev/null`;
      }

      const { stdout } = await execAsync(command, {
        timeout: 5000,
        env: { HOME: homeDir },
        maxBuffer: 1024 * 1024,
      });

      const shellEnv = parseNullSeparatedEnv(stdout);

      if (shellEnv && Object.keys(shellEnv).length > 0) {
        // Extract PATH for the existing path detection system
        if (shellEnv.PATH) {
          console.log(`[detectPaths] Got PATH from ${shellName}: ${shellEnv.PATH.substring(0, 200)}...`);
          detected.shellPath = shellEnv.PATH;
        }

        // Cache full environment (excluding PATH which has its own enhanced handling)
        const { PATH: _path, ...envWithoutPath } = shellEnv;
        cachedShellEnvironment = envWithoutPath;
        console.log(`[detectPaths] Captured ${Object.keys(envWithoutPath).length} shell environment variables`);
      }
    } catch (e: any) {
      console.warn('[detectPaths] Could not get environment from shell:', e.message || e);
    }

    // Detect Homebrew (macOS only)
    if (process.platform === 'darwin') {
      const brewLocations = [
        '/opt/homebrew/bin/brew',      // Apple Silicon default
        '/usr/local/bin/brew',          // Intel Mac default
        path.join(homeDir, '.brew/bin/brew')  // Custom install
      ];

      for (const brewPath of brewLocations) {
        if (fsSync.existsSync(brewPath)) {
          try {
            const { stdout } = await execAsync(`${brewPath} --prefix`, { timeout: 2000 });
            const brewPrefix = stdout.trim();
            if (brewPrefix) {
              console.log(`[detectPaths] Found homebrew at: ${brewPrefix}`);
              detected.homebrewPrefix = brewPrefix;

              // Check for node-specific paths from homebrew
              const nodeBrewPath = path.join(brewPrefix, 'opt', 'node', 'bin');
              if (fsSync.existsSync(nodeBrewPath)) {
                detected.homebrewNodePath = nodeBrewPath;
              }
              break;
            }
          } catch (e) {
            // Continue to next location
          }
        }
      }
    }

    // Detect nvm
    const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm');
    const nvmCurrentPath = path.join(nvmDir, 'current', 'bin');

    if (fsSync.existsSync(nvmCurrentPath)) {
      detected.nvmBinPath = nvmCurrentPath;
    } else {
      // Try to run nvm to get the current version
      try {
        const shell = process.env.SHELL || '/bin/zsh';
        const nvmCommand = `${shell} -c 'source ${nvmDir}/nvm.sh 2>/dev/null && nvm which current 2>/dev/null'`;

        const { stdout } = await execAsync(nvmCommand, { timeout: 2000 });
        const nvmWhich = stdout.trim();

        if (nvmWhich && !nvmWhich.includes('command not found')) {
          const nvmBinPath = path.dirname(nvmWhich);
          console.log(`[detectPaths] Found active nvm node at: ${nvmBinPath}`);
          detected.nvmBinPath = nvmBinPath;
        }
      } catch (e) {
        // Try to find the latest installed version
        const versionsPath = path.join(nvmDir, 'versions', 'node');
        if (fsSync.existsSync(versionsPath)) {
          try {
            const versions = fsSync.readdirSync(versionsPath);
            if (versions.length > 0) {
              // Sort versions properly (handle semver)
              versions.sort((a, b) => {
                const parseVersion = (v: string) => {
                  const match = v.match(/v?(\d+)\.(\d+)\.(\d+)/);
                  return match ? [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])] : [0, 0, 0];
                };
                const [aMajor, aMinor, aPatch] = parseVersion(a);
                const [bMajor, bMinor, bPatch] = parseVersion(b);
                if (aMajor !== bMajor) return bMajor - aMajor;
                if (aMinor !== bMinor) return bMinor - aMinor;
                return bPatch - aPatch;
              });
              const latestVersion = versions[0];
              const latestBinPath = path.join(versionsPath, latestVersion, 'bin');
              console.log(`[detectPaths] Using latest nvm version: ${latestVersion}`);
              detected.nvmBinPath = latestBinPath;
            }
          } catch (e) {
            console.warn('[detectPaths] Could not read nvm versions directory:', e);
          }
        }
      }
    }

    // Detect npm global bin
    try {
      const { stdout } = await execAsync('npm config get prefix', { timeout: 2000, shell: '/bin/sh' });
      const npmPrefix = stdout.trim();
      if (npmPrefix && npmPrefix !== 'undefined') {
        detected.npmPrefix = npmPrefix;
      }
    } catch (e) {
      // Ignore if npm is not available
    }

    // Detect yarn global bin
    try {
      const { stdout } = await execAsync('yarn global bin', { timeout: 2000, shell: '/bin/sh' });
      const yarnBin = stdout.trim();
      if (yarnBin && yarnBin.length > 0) {
        detected.yarnBin = yarnBin;
      }
    } catch (e) {
      // Ignore if yarn is not available
    }
  }

  return detected;
}

/**
 * Initialize the enhanced PATH detection asynchronously.
 * Call this at app startup to pre-populate the cache.
 * The detection runs in the background and doesn't block startup.
 */
export async function initEnhancedPath(): Promise<void> {
  if (pathDetectionPromise) {
    await pathDetectionPromise;
    return;
  }

  console.log('[initEnhancedPath] Starting async path detection...');
  const startTime = Date.now();

  pathDetectionPromise = detectPaths();

  try {
    cachedDetectedPaths = await pathDetectionPromise;
    const duration = Date.now() - startTime;
    console.log(`[initEnhancedPath] Path detection completed in ${duration}ms`);
  } catch (e: any) {
    console.error('[initEnhancedPath] Path detection failed:', e.message || e);
    cachedDetectedPaths = {};
  }
}

/**
 * Get the cached shell environment variables detected at startup.
 * Returns all env vars from the user's login shell EXCEPT PATH
 * (PATH has its own enhanced handling via getEnhancedPath()).
 *
 * This ensures env vars like AWS credentials, NODE_EXTRA_CA_CERTS, etc.
 * are available even when Nimbalyst is launched from Dock/Finder.
 *
 * Returns null if detection hasn't completed or failed.
 */
export function getShellEnvironment(): Record<string, string> | null {
  return cachedShellEnvironment;
}

/**
 * Get an enhanced PATH that includes common CLI installation locations.
 * This is needed because GUI apps on macOS don't inherit the shell's PATH
 * when launched from Finder/dock, so commands like npx, node, uvx etc.
 * installed via Homebrew, nvm, or other tools won't be found.
 *
 * Uses cached values from async detection when available, with fallback
 * to hardcoded defaults if detection hasn't completed.
 *
 * Used by:
 * - CLIManager for CLI tool installation/detection
 * - MCPConfigService for spawning MCP servers
 */
export function getEnhancedPath(): string {
  const detected = cachedDetectedPaths || {};
  // Add custom user-configured paths first (highest priority)
  const paths: string[] = [];

  // Get custom PATH directories from app settings
  const customPathDirs = getAppSetting('customPathDirs');
  if (customPathDirs && typeof customPathDirs === 'string' && customPathDirs.trim()) {
    // Split by platform separator and add to paths
    const separator = process.platform === 'win32' ? ';' : ':';
    const customPaths = customPathDirs.split(separator).map(p => p.trim()).filter(Boolean);
    paths.push(...customPaths);
  }

  // Ensure vendored ripgrep is available even when rg is not system-installed.
  paths.push(...getVendoredRipgrepDirs());

  // Start with existing PATH
  if (process.env.PATH) {
    paths.push(process.env.PATH);
  }

  if (process.platform === 'darwin' || process.platform === 'linux') {
    // Use cached shell PATH if available (populated asynchronously at startup)
    if (detected.shellPath) {
      paths.push(detected.shellPath);
    }

    // Common Unix paths
    paths.push('/usr/local/bin');
    paths.push('/usr/bin');
    paths.push('/bin');
    paths.push(path.join(os.homedir(), '.npm-global', 'bin'));
    paths.push(path.join(os.homedir(), '.local', 'bin'));
    paths.push(path.join(os.homedir(), 'bin'));

    // Add Homebrew paths for macOS
    if (process.platform === 'darwin') {
      // Use cached homebrew prefix if available
      if (detected.homebrewPrefix) {
        paths.push(path.join(detected.homebrewPrefix, 'bin'));
        paths.push(path.join(detected.homebrewPrefix, 'sbin'));
        if (detected.homebrewNodePath) {
          paths.push(detected.homebrewNodePath);
        }
      } else {
        // Fall back to common hardcoded paths
        paths.push('/opt/homebrew/bin');
        paths.push('/opt/homebrew/sbin');
        paths.push('/usr/local/bin');
        paths.push('/usr/local/sbin');
      }

      // Add common node version paths from homebrew
      paths.push('/usr/local/opt/node/bin');
      paths.push('/usr/local/opt/node@20/bin');
      paths.push('/usr/local/opt/node@18/bin');

      // MacPorts
      paths.push('/opt/local/bin');
      paths.push('/opt/local/sbin');
    }

    // Linux specific
    if (process.platform === 'linux') {
      paths.push('/usr/local/sbin');
      paths.push('/usr/sbin');
      paths.push('/sbin');
      // Snap packages
      paths.push('/snap/bin');
    }

    // Node.js version manager paths
    const homeDir = os.homedir();

    // NVM (Node Version Manager) - use cached path if available
    const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm');
    if (detected.nvmBinPath) {
      paths.push(detected.nvmBinPath);
    } else {
      // Fall back to trying the 'current' symlink
      paths.push(path.join(nvmDir, 'current', 'bin'));
    }

    // Volta
    paths.push(path.join(homeDir, '.volta', 'bin'));

    // fnm (Fast Node Manager)
    if (process.env.FNM_DIR) {
      paths.push(path.join(process.env.FNM_DIR, 'bin'));
    }

    // asdf (version manager)
    paths.push(path.join(homeDir, '.asdf', 'shims'));

    // npm global bin directory (use cached value if available)
    if (detected.npmPrefix) {
      paths.push(path.join(detected.npmPrefix, 'bin'));
    }

    // yarn global bin directory (use cached value if available)
    if (detected.yarnBin) {
      paths.push(detected.yarnBin);
    }

    // Yarn global paths (fallback if yarn command not available)
    paths.push(path.join(homeDir, '.yarn', 'bin'));
    paths.push(path.join(homeDir, '.config', 'yarn', 'global', 'node_modules', '.bin'));
  } else if (process.platform === 'win32') {
    const windowsPaths = [
      ...getVendoredRipgrepDirs(),
      ...getEnhancedWindowsPath().split(';').map(p => p.trim()).filter(Boolean),
    ];
    return [...new Set(windowsPaths)].join(';');
  }

  const uniquePaths = [...new Set(paths.filter(Boolean))];
  const pathString = uniquePaths.join(':');

  return pathString;
}

// Export singleton
export const cliManager = new CLIManager();
