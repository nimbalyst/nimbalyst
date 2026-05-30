/**
 * Vitest global setup.
 *
 * The Electron app rebuilds better-sqlite3 for Electron's ABI (postinstall
 * runs `electron-builder install-app-deps`). vitest, however, runs under
 * the system Node which has a different NODE_MODULE_VERSION, so the native
 * binding in `node_modules/better-sqlite3/build/Release/` won't load and any
 * test that touches the SQLite stack crashes the worker.
 *
 * Rather than rebuilding back-and-forth (which would break dev mode between
 * test runs), we fetch a Node-ABI prebuild into a cache directory that lives
 * OUTSIDE `build/Release/`, ad-hoc codesign it for macOS Gatekeeper, then
 * point SQLiteDatabase at it via NIMBALYST_BETTER_SQLITE3_NATIVE.
 * SQLiteDatabase passes that path through to better-sqlite3's `nativeBinding`
 * option, bypassing the bindings-resolver entirely.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawnSync } from 'child_process';
import { createRequire } from 'module';

const ELECTRON_DIR = __dirname;
const REPO_ROOT = path.resolve(ELECTRON_DIR, '..', '..');

function readBetterSqliteVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(ELECTRON_DIR, 'node_modules', 'better-sqlite3', 'package.json'),
      'utf-8',
    ),
  );
  return pkg.version as string;
}

function ensureNodePrebuild(): string {
  const modulesAbi = process.versions.modules; // e.g. '127' for Node 22
  const bsqliteVersion = readBetterSqliteVersion();
  const cacheRoot = path.join(
    ELECTRON_DIR,
    'node_modules',
    '.cache',
    'nimbalyst-better-sqlite3-node',
  );
  const targetPath = path.join(
    cacheRoot,
    `better_sqlite3-v${bsqliteVersion}-modules${modulesAbi}-${process.platform}-${process.arch}.node`,
  );
  if (fs.existsSync(targetPath)) return targetPath;

  fs.mkdirSync(cacheRoot, { recursive: true });

  // Stage prebuild-install in a scratch directory pointed at a fake
  // better-sqlite3 package so the downloaded binary lands somewhere we can
  // pluck it out of, without ever touching the real `build/Release/` that
  // dev mode depends on.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-bsqlite-stage-'));
  try {
    const stagePkg = path.join(stage, 'node_modules', 'better-sqlite3');
    fs.mkdirSync(stagePkg, { recursive: true });
    // Minimal package.json so prebuild-install knows the version + repo.
    fs.writeFileSync(
      path.join(stagePkg, 'package.json'),
      JSON.stringify({
        name: 'better-sqlite3',
        version: bsqliteVersion,
        repository: { type: 'git', url: 'git+https://github.com/WiseLibs/better-sqlite3.git' },
      }),
    );

    const prebuildInstall = path.join(REPO_ROOT, 'node_modules', 'prebuild-install', 'bin.js');
    execFileSync(
      process.execPath,
      [
        prebuildInstall,
        '--download',
        '--runtime=node',
        `--target=${process.version}`,
      ],
      { cwd: stagePkg, stdio: 'pipe' },
    );

    const downloaded = path.join(stagePkg, 'build', 'Release', 'better_sqlite3.node');
    if (!fs.existsSync(downloaded)) {
      throw new Error(`prebuild-install ran but produced no binary at ${downloaded}`);
    }
    fs.copyFileSync(downloaded, targetPath);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  // macOS Gatekeeper kills downloaded .node files unless they carry a valid
  // signature. Ad-hoc sign (-s -) is enough for local execution.
  if (process.platform === 'darwin') {
    const r = spawnSync('codesign', ['--force', '--sign', '-', targetPath], { stdio: 'pipe' });
    if (r.status !== 0) {
      throw new Error(
        `codesign failed for ${targetPath}: ${r.stderr?.toString() || r.stdout?.toString() || 'unknown'}`,
      );
    }
  }

  return targetPath;
}

export default async function globalSetup(): Promise<void> {
  // Only relevant for tests that load native better-sqlite3. Skip if the
  // current Node can already load the in-tree binary (e.g. CI may already
  // ship a Node-version binary).
  const electronBinary = path.join(
    ELECTRON_DIR,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  if (!fs.existsSync(electronBinary)) return;

  // Probe-load the in-tree binary; if it works, no override needed.
  try {
    const req = createRequire(electronBinary);
    req(electronBinary);
    return;
  } catch {
    // Falls through to the prebuild path below.
  }

  const nodeBinary = ensureNodePrebuild();
  process.env.NIMBALYST_BETTER_SQLITE3_NATIVE = nodeBinary;
  // vitest globalSetup mutations don't propagate to workers, so also stash on
  // an explicit file path that the per-worker setup can re-read.
  fs.writeFileSync(
    path.join(ELECTRON_DIR, 'node_modules', '.cache', 'nimbalyst-better-sqlite3-node', 'binary-path.txt'),
    nodeBinary,
  );
}
