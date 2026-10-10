/**
 * The one place repo tooling names its package manager. Gate stages, the
 * workspace script runner, and hooks spawn pnpm through here, and read the
 * workspace layout from pnpm-workspace.yaml rather than re-deriving it.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// CI's validation-selection job imports this module before any install, so
// the yaml dependency is only loaded when a caller actually reads the config.
const require = createRequire(import.meta.url);

export const packageManager = 'pnpm';

/** Windows package-manager shims are .cmd files, which Node must launch through cmd.exe. */
export function shimSpawnConfig(tool, platform = process.platform, env = process.env) {
  return platform === 'win32'
    ? { command: env.ComSpec || 'cmd.exe', argsPrefix: ['/d', '/s', '/c', `${tool}.cmd`] }
    : { command: tool, argsPrefix: [] };
}

export function packageManagerSpawnConfig(platform = process.platform, env = process.env) {
  return shimSpawnConfig(packageManager, platform, env);
}

/** Parsed pnpm-workspace.yaml (packages, overrides, allowBuilds, ...). */
export function readWorkspaceConfig(rootDir) {
  const { parse } = require('yaml');
  return parse(readFileSync(path.join(rootDir, 'pnpm-workspace.yaml'), 'utf8')) ?? {};
}
