// This module no longer imports Electron: it asks the injected HostEnvironment
// the two questions it used to ask `app`. The file stays under `src/electron/`
// because ~15 test files mock it by that specifier, and a rename that misses
// one turns that mock into a silent no-op. See the testing rule in CLAUDE.md.
import path from 'path';
import { preservedClaudeFiles, recoverClaudeRuntime } from './claudeRuntimeRecovery';
import { managedClaudeEnvironment } from './managedClaudeEnvironment';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
import { getHostEnvironment } from '../host/hostEnvironment';

/**
 * A `require` usable for module resolution regardless of how this file was
 * loaded.
 *
 * Under the Node build target this module is emitted as plain ESM, where bare
 * `require` is not defined. Every call site below sits inside a `catch` that
 * returns undefined, so the ReferenceError was invisible: a headless host could
 * never resolve the bundled Claude binary and simply fell through to the SDK
 * self-resolving. Bundled builds keep their own `require`, so prefer it.
 */
let cachedRequire: NodeRequire | undefined;
function resolverRequire(): NodeRequire | undefined {
  if (cachedRequire) return cachedRequire;
  if (typeof require === 'function') {
    cachedRequire = require;
    return cachedRequire;
  }
  try {
    cachedRequire = createRequire(import.meta.url);
  } catch {
    return undefined;
  }
  return cachedRequire;
}

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
 * The unpacked native package dir + binary name for the current platform in a
 * packaged build. Returns undefined in dev (where require.resolve handles it).
 * Shared by resolveNativeBinaryPath and the orphaned-self-update detection so
 * both look in exactly the same place.
 */
function getPackagedNativeBinaryLocation(): { dir: string; binaryName: string } | undefined {
  if (!getHostEnvironment().isPackaged()) return undefined;
  const platform = process.platform;
  const arch = process.arch;
  const binaryName = getClaudeExecutableNameForPlatform(platform);
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;

  const appPath = getHostEnvironment().getAppPath();
  const unpackedPath = appPath.includes('app.asar')
    ? appPath.replace(/app\.asar(?=[\/\\]|$)/, 'app.asar.unpacked')
    : appPath;

  return { dir: path.join(unpackedPath, 'node_modules', packageName), binaryName };
}

/**
 * Base message shown when the bundled Claude runtime can't be resolved. Kept in
 * one place so the run path (sdkOptionsBuilder / cliPathResolver) and the
 * check-login path surface identical, honest wording -- never the SDK's
 * misleading "does not match this system's libc ... musl" ReferenceError that a
 * missing binary otherwise produces. See NIM-1573 / NIM-895.
 */
export const MISSING_CLAUDE_RUNTIME_MESSAGE =
  "Nimbalyst's bundled Claude runtime is missing or could not be found. " +
  'Nimbalyst could not verify a recoverable preserved copy. Update or repair Nimbalyst.';

export function findOrphanedClaudeUpdateFiles(): string[] {
  const location = getPackagedNativeBinaryLocation();
  return location ? preservedClaudeFiles(location.dir, location.binaryName) : [];
}

export function describeMissingClaudeRuntime(): string {
  const orphans = findOrphanedClaudeUpdateFiles();
  return MISSING_CLAUDE_RUNTIME_MESSAGE + (orphans.length
    ? ` (${orphans.length} preserved self-update file(s) could not be verified.)`
    : '');
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
  if (!getHostEnvironment().isPackaged()) {
    try {
      return resolverRequire()?.resolve(`${packageName}/${binaryName}`);
    } catch {
      return undefined;
    }
  }

  // Packaged mode: construct path to the asar-unpacked binary
  const location = getPackagedNativeBinaryLocation()!;
  const appPath = getHostEnvironment().getAppPath();
  const binaryPath = path.join(location.dir, binaryName);
  const relocatedPath = path.join(path.dirname(appPath), 'claude-runtime', `${platform}-${arch}`, binaryName);
  if (fs.existsSync(relocatedPath)) return relocatedPath;
  recoverClaudeRuntime({
    legacyDir: location.dir,
    destination: relocatedPath,
    manifestPath: path.join(location.dir, '..', 'claude-agent-sdk', 'manifest.json'),
    platformKey: `${platform}-${arch}`,
    binaryName,
  });
  if (fs.existsSync(relocatedPath)) return relocatedPath;

  if (fs.existsSync(binaryPath)) {
    return binaryPath;
  }

  // Binary not found -- log diagnostics to help debug cross-arch packaging issues
  console.error(`[resolveNativeBinaryPath] Binary not found at: ${binaryPath}`);
  console.error(`[resolveNativeBinaryPath] platform=${platform} arch=${arch} appPath=${appPath}`);
  try {
    const anthropicDir = path.resolve(location.dir, '..');
    if (fs.existsSync(anthropicDir)) {
      const entries = fs.readdirSync(anthropicDir);
      console.error(`[resolveNativeBinaryPath] Contents of ${anthropicDir}: ${entries.join(', ')}`);
    } else {
      console.error(`[resolveNativeBinaryPath] Directory does not exist: ${anthropicDir}`);
    }
  } catch { /* ignore */ }

  // Fallback: try require.resolve in case asar-unpacked layout differs
  try {
    const resolvedPath = resolverRequire()?.resolve(`${packageName}/${binaryName}`);
    if (!resolvedPath) return undefined;
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
    // NIM-1573: never hand back a path that doesn't exist. require.resolve can
    // succeed off a stale module cache while the file itself was renamed away by
    // an interrupted self-update; returning it would defeat the honest-error
    // path and resurface the misleading SDK libc error at spawn time.
    if (!fs.existsSync(resolvedPath)) {
      console.error(`[resolveNativeBinaryPath] require.resolve path no longer exists on disk: ${resolvedPath}`);
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

  const appPath = getHostEnvironment().getAppPath();
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
  const isPackaged = getHostEnvironment().isPackaged();
  const env = { ...process.env };

  const nodePaths = getCandidateNodePaths(isPackaged);
  if (nodePaths.length > 0) {
    env.NODE_PATH = nodePaths.join(path.delimiter);
  }

  if (!isPackaged) {
    return managedClaudeEnvironment(env);
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

  return managedClaudeEnvironment(env);
}
