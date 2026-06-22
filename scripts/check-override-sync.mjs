// Guardrail: root `overrides` pins must stay compatible with the workspace
// dependency ranges they force. An override is a hard pin applied to the whole
// tree -- if it drifts below (or outside) the range a package declares, npm
// silently resolves the OLD pinned version and the dependency bump is neutered
// with no error. This bit us when claude-agent-sdk deps were bumped to ^0.3.161
// in a feature commit but the root override stayed at 0.2.126.
//
// Run by the pre-push hook and CI. Fails (exit 1) on any mismatch.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Collect every workspace package.json (packages/* and packages/extensions/*).
function workspacePackageFiles() {
  const roots = [path.join(repoRoot, 'packages'), path.join(repoRoot, 'packages', 'extensions')];
  const files = [];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = path.join(dir, entry.name, 'package.json');
      if (existsSync(pkg)) files.push(pkg);
    }
  }
  return files;
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const rootPkg = readJson(path.join(repoRoot, 'package.json'));
const overrides = rootPkg.overrides ?? {};

// Only bare-version overrides (e.g. "0.3.161"); skip nested objects like
// { concurrently: { 'shell-quote': '...' } } which target a specific dep tree.
const pinned = Object.entries(overrides).filter(([, v]) => typeof v === 'string');

const pkgFiles = workspacePackageFiles();
const errors = [];

for (const [name, override] of pinned) {
  for (const file of pkgFiles) {
    const pkg = readJson(file);
    for (const field of DEP_FIELDS) {
      const range = pkg[field]?.[name];
      if (!range || !semver.validRange(range) || !semver.validRange(override)) continue;
      // If the override range and the declared range don't overlap, npm forces a
      // version outside what this package expects -- the dependency bump is
      // silently neutered. An exact pin ("0.3.161") is a single-version range,
      // so this also catches a stranded pin below a bumped range.
      if (!semver.intersects(override, range)) {
        errors.push(
          `${name}: override "${override}" does not overlap ${path.relative(repoRoot, file)} ` +
            `(${field}) range "${range}" -- npm would force a version outside the declared range.`,
        );
      }
    }
  }
}

if (errors.length > 0) {
  console.error('[check-override-sync] Root override(s) out of sync with workspace deps:\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    '\nBump the root `overrides` pin in package.json to match the dependency range ' +
      '(see /update-libs Phase 2), then re-run `npm install`.',
  );
  process.exit(1);
}

console.log(`[check-override-sync] OK -- ${pinned.length} pinned override(s) consistent with workspace deps.`);
