#!/usr/bin/env node

/**
 * Normalizes extraResources sources before electron-builder packs.
 *
 * npm's hoisting behavior across workspaces is not always stable: the
 * same lockfile can place a dependency in packages/electron/node_modules/
 * on one machine and in the repo-root node_modules/ on another. The
 * electron-builder `extraResources` entries use literal paths, so if a
 * package lands at the other location, packaging silently ships a broken
 * build (or validate-extra-resources refuses to continue).
 *
 * For any extraResources entry that is missing at its expected location
 * but exists at an alternate location (the paired root vs packages/electron
 * node_modules), this script creates a symlink at the expected location
 * pointing back to wherever npm actually put the package.
 *
 * Handles both top-level `build.extraResources` and platform-specific
 * `build.{mac,win,linux}.extraResources`. The `${arch}` macro in
 * platform-specific paths is expanded using BUILD_ARCH env var (CI sets
 * this from the matrix arch), falling back to process.arch.
 */

const fs = require('fs');
const path = require('path');

const packageDir = path.join(__dirname, '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')
);

const buildArch = process.env.BUILD_ARCH || process.arch;

function expandMacros(str) {
  return str.replace(/\$\{arch\}/g, buildArch);
}

function collectFromPaths() {
  const out = [];
  const top = packageJson.build?.extraResources;
  if (Array.isArray(top)) {
    for (const entry of top) {
      const from = typeof entry === 'string' ? entry : entry?.from;
      if (typeof from === 'string') out.push(from);
    }
  }
  for (const key of ['mac', 'win', 'linux']) {
    const list = packageJson.build?.[key]?.extraResources;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const from = typeof entry === 'string' ? entry : entry?.from;
      if (typeof from === 'string') out.push(expandMacros(from));
    }
  }
  return out;
}

// A from path is either anchored at packageDir (starts with `node_modules/`
// or `../../node_modules/`) or somewhere else we don't try to auto-repair.
// Return the paired alternate-root path, or null if not auto-repairable.
function pairedLocation(from) {
  // Points into packages/electron/node_modules/; alternate = repo root.
  if (from.startsWith('node_modules/')) {
    return {
      expected: path.resolve(packageDir, from),
      alternate: path.resolve(repoRoot, from),
    };
  }
  // Points into repo-root node_modules/; alternate = packages/electron.
  if (from.startsWith('../../node_modules/')) {
    const rel = from.slice('../../'.length);
    return {
      expected: path.resolve(repoRoot, rel),
      alternate: path.resolve(packageDir, rel),
    };
  }
  return null;
}

const fromPaths = collectFromPaths();

// Sort shallowest first so a broader symlink (e.g. the @openai scope dir)
// is created before any nested entries inside it (e.g. @openai/codex-sdk).
// Nested entries then satisfy via the parent symlink and are skipped.
fromPaths.sort((a, b) => a.split('/').length - b.split('/').length);

let linked = 0;

for (const from of fromPaths) {
  const paired = pairedLocation(from);
  if (!paired) continue;
  if (fs.existsSync(paired.expected)) continue;
  if (!fs.existsSync(paired.alternate)) continue;

  const parent = path.dirname(paired.expected);
  fs.mkdirSync(parent, { recursive: true });
  const target = path.relative(parent, paired.alternate);
  fs.symlinkSync(target, paired.expected);
  linked++;
  console.log(`[normalize-extra-resources] Linked ${from} -> ${target}`);
}

if (linked === 0) {
  console.log('[normalize-extra-resources] Nothing to normalize.');
} else {
  console.log(`[normalize-extra-resources] Linked ${linked} package(s).`);
}
