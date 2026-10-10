/**
 * Finding the browser app. `nim` stays small by not carrying it: the assets are
 * the separate `@nimbalyst/wiki-web` package, installed next to `nim` the first
 * time someone runs `nim wiki serve`. Nothing is installed silently; when the
 * package is missing we print the command.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIKI_API_VERSION } from './api.js';

export const WIKI_WEB_PACKAGE = '@nimbalyst/wiki-web';

export interface ResolvedAssets {
  dir: string;
  version: string | null;
  source: 'flag' | 'installed' | 'workspace';
}

export type AssetResolution = { ok: true; assets: ResolvedAssets } | { ok: false; reason: 'missing' | 'incompatible' | 'unbuilt'; detail: string };

interface WikiWebManifest {
  version?: string;
  nimbalystWikiApi?: number;
}

function readManifest(packageDir: string): WikiWebManifest | null {
  try {
    return JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as WikiWebManifest;
  } catch {
    return null;
  }
}

function fromPackageDir(packageDir: string, source: ResolvedAssets['source']): AssetResolution {
  const dir = path.join(packageDir, 'dist');
  const manifest = readManifest(packageDir);
  if (manifest?.nimbalystWikiApi !== undefined && manifest.nimbalystWikiApi !== WIKI_API_VERSION) {
    return {
      ok: false,
      reason: 'incompatible',
      detail: `${packageDir} speaks wiki API ${manifest.nimbalystWikiApi}; this nim speaks ${WIKI_API_VERSION}`,
    };
  }
  if (!existsSync(path.join(dir, 'index.html'))) return { ok: false, reason: 'unbuilt', detail: `${dir} has no index.html` };
  return { ok: true, assets: { dir, version: manifest?.version ?? null, source } };
}

/** The package directory of an installed `@nimbalyst/wiki-web`, looked up from `from`. */
function installedPackageDir(from: string): string | null {
  try {
    const require = createRequire(path.join(from, 'noop.js'));
    return path.dirname(require.resolve(`${WIKI_WEB_PACKAGE}/package.json`));
  } catch {
    return null;
  }
}

/** In this monorepo, the workspace package beside `packages/cli`. */
function workspacePackageDir(from: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'packages', 'wiki-web');
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * Order: `--assets <dir>`, the package installed beside `nim` (global installs
 * put both under one node_modules), the package installed in the project, the
 * monorepo's workspace package.
 */
export function resolveWikiWebAssets(options: { flag?: string; projectRoot?: string; selfDir?: string }): AssetResolution {
  if (options.flag) {
    const dir = path.resolve(options.flag);
    if (!existsSync(path.join(dir, 'index.html'))) return { ok: false, reason: 'unbuilt', detail: `${dir} has no index.html` };
    return { ok: true, assets: { dir, version: null, source: 'flag' } };
  }
  const selfDir = options.selfDir ?? path.dirname(fileURLToPath(import.meta.url));
  let firstFailure: AssetResolution | null = null;
  for (const from of [selfDir, options.projectRoot].filter((d): d is string => Boolean(d))) {
    const packageDir = installedPackageDir(from);
    if (!packageDir) continue;
    const result = fromPackageDir(packageDir, 'installed');
    if (result.ok) return result;
    firstFailure ??= result;
  }
  const workspace = workspacePackageDir(selfDir);
  if (workspace) {
    const result = fromPackageDir(workspace, 'workspace');
    if (result.ok) return result;
    firstFailure ??= result;
  }
  return firstFailure ?? { ok: false, reason: 'missing', detail: `${WIKI_WEB_PACKAGE} is not installed` };
}

/** What to tell someone whose `nim` has no browser assets. */
export function installHint(cliVersion: string, resolution: Exclude<AssetResolution, { ok: true }>): string {
  const spec = cliVersion && cliVersion !== '0.0.0' ? `${WIKI_WEB_PACKAGE}@${cliVersion}` : WIKI_WEB_PACKAGE;
  const lines = [`nim wiki serve needs the browser app, which ships separately as ${WIKI_WEB_PACKAGE}.`, `  ${resolution.detail}`, '', 'Install it next to nim:', `  npm install -g ${spec}`];
  if (resolution.reason === 'unbuilt') lines.push('', 'In the Nimbalyst repo, build it instead:', '  pnpm --filter @nimbalyst/wiki-web run build');
  lines.push('', 'Or point at a built copy with --assets <dir>.');
  return lines.join('\n') + '\n';
}
