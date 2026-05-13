import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';

function isAsarPackagedPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/');
  return normalized.includes('/app.asar/') && !normalized.includes('/app.asar.unpacked/');
}

function getClaudeExecutableNameForPlatform(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'claude.exe' : 'claude';
}

function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function findExecutableInPathEntries(
  executableNames: string[],
  pathValue: string | undefined
): string | undefined {
  for (const entry of splitPathEntries(pathValue)) {
    for (const executableName of executableNames) {
      const candidate = path.join(entry, executableName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function getSystemClaudeExecutableCandidates(pathValue?: string): string[] {
  const platform = process.platform;
  const homeDir = os.homedir();
  const seen = new Set<string>();
  const candidates: string[] = [];
  const addCandidate = (candidate: string | undefined) => {
    if (!candidate) return;
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(candidate);
  };

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    const executableNames = ['claude.cmd', 'claude.exe'];
    addCandidate(path.join(homeDir, '.local', 'bin', 'claude.exe'));
    addCandidate(path.join(homeDir, '.local', 'bin', 'claude.cmd'));
    addCandidate(path.join(appData, 'npm', 'claude.cmd'));
    addCandidate(path.join(homeDir, 'AppData', 'Roaming', 'npm', 'claude.cmd'));
    addCandidate(findExecutableInPathEntries(executableNames, pathValue ?? process.env.PATH));
    return candidates;
  }

  const executableName = getClaudeExecutableNameForPlatform(platform);
  addCandidate(path.join(homeDir, '.local', 'bin', executableName));
  addCandidate(path.join(homeDir, '.npm-global', 'bin', executableName));
  addCandidate(path.join(homeDir, 'bin', executableName));
  addCandidate('/usr/local/bin/claude');
  addCandidate('/opt/homebrew/bin/claude');
  addCandidate('/usr/bin/claude');
  addCandidate(findExecutableInPathEntries([executableName], pathValue ?? process.env.PATH));
  return candidates;
}

/**
 * Resolve the path to the SDK's native binary for the current platform.
 *
 * SDK 0.2.114+ ships per-platform native binaries as optional dependencies
 * (e.g., @anthropic-ai/claude-agent-sdk-darwin-arm64/claude). In dev mode
 * require.resolve() finds them directly. In packaged builds the binary lives
 * inside app.asar.unpacked and require.resolve may not work, so we construct
 * the path manually.
 */
export function resolveNativeBinaryPath(): string | undefined {
  const platform = process.platform;
  const arch = process.arch;
  const binaryName = getClaudeExecutableNameForPlatform(platform);
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;

  // Dev mode: require.resolve works fine
  if (!app.isPackaged) {
    try {
      return require.resolve(`${packageName}/${binaryName}`);
    } catch {
      return undefined;
    }
  }

  // Packaged mode: construct path to the asar-unpacked binary
  const appPath = app.getAppPath();
  const unpackedPath = appPath.includes('app.asar')
    ? appPath.replace(/app\.asar(?=[\/\\]|$)/, 'app.asar.unpacked')
    : appPath;

  const binaryPath = path.join(unpackedPath, 'node_modules', packageName, binaryName);

  if (fs.existsSync(binaryPath)) {
    return binaryPath;
  }

  // Binary not found -- log diagnostics to help debug cross-arch packaging issues
  console.error(`[resolveNativeBinaryPath] Binary not found at: ${binaryPath}`);
  console.error(`[resolveNativeBinaryPath] platform=${platform} arch=${arch} appPath=${appPath}`);
  try {
    const anthropicDir = path.join(unpackedPath, 'node_modules', '@anthropic-ai');
    if (fs.existsSync(anthropicDir)) {
      const entries = fs.readdirSync(anthropicDir);
      console.error(`[resolveNativeBinaryPath] Contents of ${anthropicDir}: ${entries.join(', ')}`);
    } else {
      console.error(`[resolveNativeBinaryPath] Directory does not exist: ${anthropicDir}`);
    }
  } catch { /* ignore */ }

  // Fallback: try require.resolve in case asar-unpacked layout differs
  try {
    const resolvedPath = require.resolve(`${packageName}/${binaryName}`);
    if (isAsarPackagedPath(resolvedPath)) {
      console.error(`[resolveNativeBinaryPath] Ignoring non-executable asar path from require.resolve: ${resolvedPath}`);
      return undefined;
    }
    const resourcesRoot = path.dirname(appPath);
    const normalizedResolvedPath = path.normalize(resolvedPath);
    const normalizedResourcesRoot = path.normalize(resourcesRoot);
    if (!normalizedResolvedPath.startsWith(`${normalizedResourcesRoot}${path.sep}`)) {
      console.error(`[resolveNativeBinaryPath] Ignoring packaged fallback outside resources root: ${resolvedPath}`);
      return undefined;
    }
    return resolvedPath;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a Claude executable path that is safe to hand to the SDK.
 *
 * By default this only returns the bundled unpacked native binary.
 * Pass `allowSystemFallback: true` only for login/status-style flows where
 * using a standalone Claude installation is acceptable.
 *
 * Agent sessions must not silently fall back to a standalone Claude CLI:
 * prior NIM-838 investigation showed that packaged builds could then lose
 * `--resume` semantics and break multi-turn sessions.
 */
export function resolveClaudeCodeExecutablePath(options?: {
  pathValue?: string;
  allowSystemFallback?: boolean;
}): string | undefined {
  const bundledPath = resolveNativeBinaryPath();
  if (bundledPath) {
    return bundledPath;
  }

  if (!options?.allowSystemFallback) {
    return undefined;
  }

  for (const candidate of getSystemClaudeExecutableCandidates(options?.pathValue)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function getCandidateNodePaths(isPackaged: boolean): string[] {
  const candidates = new Set<string>();
  const existingNodePath = process.env.NODE_PATH;

  if (existingNodePath) {
    for (const entry of existingNodePath.split(path.delimiter)) {
      if (entry) {
        candidates.add(entry);
      }
    }
  }

  const appPath = app.getAppPath();
  const unpackedPath = appPath.includes('app.asar')
    ? appPath.replace(/app\.asar(?=[\/\\]|$)/, 'app.asar.unpacked')
    : appPath;

  if (isPackaged) {
    candidates.add(path.join(unpackedPath, 'node_modules'));
  } else {
    candidates.add(path.join(appPath, 'node_modules'));
    // In dev, the Electron app lives under packages/electron while optional SDK
    // image binaries are often hoisted to the repo root node_modules directory.
    candidates.add(path.resolve(appPath, '../../node_modules'));
    candidates.add(path.resolve(appPath, '../runtime/node_modules'));
  }

  return Array.from(candidates).filter((candidate) => fs.existsSync(candidate));
}

/**
 * Setup environment for Claude Agent SDK in packaged builds.
 *
 * Even though SDK 0.2.114+ spawns a native binary (not Electron-as-Node),
 * the subprocess still needs a proper environment with PATH, home directory,
 * and temp directories set up correctly.
 */
export function setupClaudeCodeEnvironment(): NodeJS.ProcessEnv {
  const isPackaged = app.isPackaged;
  const env = { ...process.env };

  const nodePaths = getCandidateNodePaths(isPackaged);
  if (nodePaths.length > 0) {
    env.NODE_PATH = nodePaths.join(path.delimiter);
  }

  if (!isPackaged) {
    return env;
  }

  // Packaged mode - set up enhanced environment
  const platform = process.platform;
  const homedir = os.homedir();
  const username = os.userInfo().username;

  // Platform-specific environment setup
  // NOTE: Custom PATH directories from app settings are handled by the electron package
  // (CLIManager.getEnhancedPath) and should already be in process.env.PATH when this is called.
  if (platform === 'win32') {
    // Windows environment setup
    env.USERPROFILE = homedir;
    env.USERNAME = username;
    env.TEMP = env.TEMP || path.join(homedir, 'AppData', 'Local', 'Temp');
    env.TMP = env.TMP || env.TEMP;

    // Windows PATH - preserve existing and add common locations
    const pathSeparator = ';';
    const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
    const commonPaths = [
      env.PATH || '',
      path.join(appData, 'npm'),  // npm global bin directory
      path.join(homedir, 'AppData', 'Roaming', 'npm'),  // fallback npm path
      path.join(homedir, '.local', 'bin'),  // native installer location
      path.join(homedir, 'AppData', 'Local', 'Programs'),
      'C:\\Program Files\\nodejs',
      'C:\\Program Files (x86)\\nodejs',
    ].filter(Boolean);
    env.PATH = commonPaths.join(pathSeparator);
  } else {
    // Unix-like (macOS/Linux) environment setup
    env.HOME = homedir;
    env.USER = username;
    env.LOGNAME = username;
    env.SHELL = env.SHELL || process.env.SHELL || '/bin/bash';
    env.TMPDIR = env.TMPDIR || os.tmpdir() || '/tmp';

    // Unix PATH - preserve existing and add common locations
    const pathSeparator = ':';
    const commonPaths = [
      env.PATH || '',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      path.join(homedir, '.local', 'bin'),
      path.join(homedir, 'bin'),
      '/opt/homebrew/bin',
      '/opt/local/bin',
    ].filter(Boolean);
    env.PATH = commonPaths.join(pathSeparator);
  }

  if (nodePaths.length === 0) {
    const error = `Unable to resolve any unpacked node_modules directories for Claude Code. ` +
                 `This indicates a build configuration issue. The Claude Agent SDK must be unpacked during the build process.`;
    throw new Error(error);
  }

  return env;
}
