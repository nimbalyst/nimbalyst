import fs from 'fs';
import path from 'path';

type SupportedPlatform = NodeJS.Platform;

export function getCodexTargetTriple(platform: SupportedPlatform, arch: string): string | undefined {
  if (platform === 'linux' || platform === 'android') {
    if (arch === 'x64') return 'x86_64-unknown-linux-musl';
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
    return undefined;
  }

  if (platform === 'darwin') {
    if (arch === 'x64') return 'x86_64-apple-darwin';
    if (arch === 'arm64') return 'aarch64-apple-darwin';
    return undefined;
  }

  if (platform === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc';
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
    return undefined;
  }

  return undefined;
}

function getCodexPackageSubpath(platform: SupportedPlatform, arch: string): string | undefined {
  if (arch !== 'x64' && arch !== 'arm64') {
    return undefined;
  }

  if (platform === 'darwin') {
    return path.join('@openai', `codex-darwin-${arch}`);
  }

  if (platform === 'linux' || platform === 'android') {
    return path.join('@openai', `codex-linux-${arch}`);
  }

  if (platform === 'win32') {
    return path.join('@openai', `codex-win32-${arch}`);
  }

  return undefined;
}

/**
 * Options for resolving the Codex binary path in packaged applications.
 */
export interface CodexBinaryPathResolutionOptions {
  /** Path to the Electron app's resources directory. Defaults to process.resourcesPath. */
  resourcesPath?: string;
  /** Operating system platform. Defaults to process.platform. */
  platform?: SupportedPlatform;
  /** CPU architecture. Defaults to process.arch. */
  arch?: string;
  /** File system existence check function. Defaults to fs.existsSync. */
  existsSync?: (candidatePath: string) => boolean;
}

function getResourcesRoots(resourcesPath: string): string[] {
  const roots = new Set<string>();
  const normalized = path.normalize(resourcesPath);
  roots.add(normalized);

  const asarSuffix = `${path.sep}app.asar`;
  if (normalized.endsWith(asarSuffix)) {
    roots.add(normalized.slice(0, -asarSuffix.length));
  }

  const asarUnpackedSuffix = `${path.sep}app.asar.unpacked`;
  if (normalized.endsWith(asarUnpackedSuffix)) {
    roots.add(normalized.slice(0, -asarUnpackedSuffix.length));
  }

  const asarUnpackedMarker = `${path.sep}app.asar.unpacked${path.sep}`;
  const asarUnpackedIndex = normalized.indexOf(asarUnpackedMarker);
  if (asarUnpackedIndex >= 0) {
    roots.add(normalized.slice(0, asarUnpackedIndex));
  }

  return Array.from(roots);
}

/**
 * Resolve a packaged-app-safe Codex binary path.
 * In Electron packaged apps, SDK module resolution may point inside app.asar,
 * but child_process.spawn cannot execute binaries from asar virtual paths.
 */
export function resolvePackagedCodexBinaryPath(
  options: CodexBinaryPathResolutionOptions = {}
): string | undefined {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (!resourcesPath) {
    return undefined;
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const existsSync = options.existsSync ?? fs.existsSync;

  const targetTriple = getCodexTargetTriple(platform, arch);
  if (!targetTriple) {
    return undefined;
  }

  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
  const resourcesRoots = getResourcesRoots(resourcesPath);
  const codexPackageSubpath = getCodexPackageSubpath(platform, arch);

  const packageRelativeRoots = [
    path.join('app.asar.unpacked', 'node_modules', '@openai', 'codex-sdk'),
    path.join('node_modules', '@openai', 'codex-sdk'),
    path.join('app.asar.unpacked', '@openai', 'codex-sdk'),
    ...(codexPackageSubpath
      ? [
          path.join('app.asar.unpacked', 'node_modules', codexPackageSubpath),
          path.join('node_modules', codexPackageSubpath),
          path.join('app.asar.unpacked', codexPackageSubpath),
        ]
      : []),
  ];

  const binaryRelativePaths = [
    // 0.131+ layout (codex-sdk renamed the binary directory to `bin/`).
    path.join('vendor', targetTriple, 'bin', binaryName),
    path.join('vendor', targetTriple, 'codex', binaryName),
    path.join('vendor', targetTriple, binaryName),
  ];

  const candidatesSet = new Set<string>();
  for (const root of resourcesRoots) {
    for (const packageRelativeRoot of packageRelativeRoots) {
      for (const binaryRelativePath of binaryRelativePaths) {
        candidatesSet.add(path.join(root, packageRelativeRoot, binaryRelativePath));
      }
    }
  }
  const candidates = Array.from(candidatesSet);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
