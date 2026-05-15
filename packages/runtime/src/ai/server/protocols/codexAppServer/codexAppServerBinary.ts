// Locate the codex binary for spawning `codex app-server --listen stdio://`.
//
// In packaged builds the binary path is provided by the existing
// `resolvePackagedCodexBinaryPath` helper used by the SDK transport.
//
// In dev / unpackaged Node contexts we use module resolution against the
// platform-specific `@openai/codex-<platform>-<arch>` package (the same
// approach the SDK takes internally). This keeps both transports using the
// SAME binary so version mismatches are impossible.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getCodexTargetTriple } from '../../providers/codex/codexBinaryPath';

const moduleRequire = createRequire(import.meta.url);

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

/**
 * Resolve the codex binary path via npm module resolution. Mirrors the
 * @openai/codex-sdk's own approach so dev/test contexts work without an
 * Electron packaged-app resources path.
 */
export function resolveCodexBinaryFromModules(): string | undefined {
  const target = getCodexTargetTriple(process.platform, process.arch);
  if (!target) return undefined;
  const platformPkg = PLATFORM_PACKAGE_BY_TARGET[target];
  if (!platformPkg) return undefined;
  try {
    const codexPkgJson = moduleRequire.resolve('@openai/codex/package.json');
    const codexRequire = createRequire(codexPkgJson);
    const platformPkgJson = codexRequire.resolve(`${platformPkg}/package.json`);
    const vendor = path.join(path.dirname(platformPkgJson), 'vendor');
    const binName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const candidate = path.join(vendor, target, 'codex', binName);
    if (fs.existsSync(candidate)) return candidate;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the codex binary path, preferring an explicit override (used in
 * packaged Electron builds) and falling back to module resolution.
 */
export function resolveCodexBinaryPath(
  packagedResolver?: () => string | undefined,
): string {
  const packaged = packagedResolver?.();
  if (packaged) return packaged;
  const fromModules = resolveCodexBinaryFromModules();
  if (fromModules) return fromModules;
  throw new Error(
    '[CodexAppServer] could not resolve codex binary. Install @openai/codex with optional platform dependencies, or provide a packaged-resources resolver.',
  );
}
