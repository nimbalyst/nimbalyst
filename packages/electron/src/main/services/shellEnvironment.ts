import { exec } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import { getAppSetting } from '../utils/store';
import { getEnhancedWindowsPath } from './WindowsPathResolver';

/**
 * PATH and login-shell environment detection for spawning external tools.
 *
 * A GUI app on macOS inherits launchd's minimal PATH, not the user's shell
 * PATH, so anything we spawn (git, node, the agent CLIs) needs the enriched
 * value these functions build.
 *
 * Split out of CLIManager.ts because that module constructs its singleton at
 * import time, and constructing a CLIManager registers the `cli:*` IPC
 * handlers. Eight modules wanted nothing but `getEnhancedPath()` and were
 * paying for handler registration -- plus the whole install/upgrade machinery
 * -- to get a path string. Importing this module has no side effects.
 */

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

/** Test-only: seed the detection cache without spawning a login shell. */
export function __setDetectedPathsForTest(detected: DetectedPaths | null): void {
  cachedDetectedPaths = detected;
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

  // The login shell's PATH comes before the inherited one so tools resolve the
  // same way they do in Terminal. A Dock launch inherits launchd's
  // /usr/bin:/bin:/usr/sbin:/sbin, which would otherwise shadow version
  // managers like mise or rbenv (#1934). Until async detection finishes,
  // shellPath is unset and the inherited PATH leads as before.
  if ((process.platform === 'darwin' || process.platform === 'linux') && detected.shellPath) {
    paths.push(detected.shellPath);
  }

  if (process.env.PATH) {
    paths.push(process.env.PATH);
  }

  if (process.platform === 'darwin' || process.platform === 'linux') {

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

  return dedupePathEntries(paths, ':');
}

/**
 * Split each entry on the delimiter (some entries are whole PATH strings) and
 * keep the first occurrence of each folder. Empty segments are dropped and a
 * trailing slash does not make a folder distinct.
 */
function dedupePathEntries(entries: string[], delimiter: string): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    for (const raw of entry.split(delimiter)) {
      const dir = raw.trim();
      if (!dir) continue;
      const folder = dir.replace(/\/+$/, '') || dir;
      if (seen.has(folder)) continue;
      seen.add(folder);
      result.push(folder);
    }
  }
  return result.join(delimiter);
}
