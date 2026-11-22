#!/usr/bin/env node
// Whether the public nimbalyst/nimbalyst-wiki repository needs a new staging,
// and why. That repository is publish output (see stage-wiki-repo.mjs): its
// SOURCE file names the monorepo commit it was staged from, which is the
// baseline here. Installs update by plugin version, so any change that ships
// needs a version bump first, or it never reaches an existing install.
//
// It reads the mirror from its remote (origin/main of a local clone, fetched
// first), not the clone's working tree, so an unpushed staging does not count.
//
//   node scripts/wiki-mirror-status.mjs [--mirror <dir>] [--json]
//
// <dir> defaults to ../nimbalyst-wiki next to this repository.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MIRROR = path.resolve(REPO_ROOT, '../nimbalyst-wiki');

/**
 * What the staged repository is built from. The plugin files change what an
 * install runs; the rest are its docs. The code it runs is @nimbalyst/cli,
 * released with /publish-npm, so packages/cli and packages/wiki-web are not watched here.
 */
export const PLUGIN_WATCH = ['plugins/nimbalyst-wiki', 'plugins/nimbalyst-wiki-team'];
export const OTHER_WATCH = ['scripts/wiki-repo', 'scripts/stage-wiki-repo.mjs', 'packages/local-wiki/FORMAT.md'];

function run(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...options }).trimEnd();
  } catch {
    return null;
  }
}

function lines(text) {
  return text ? text.split('\n').filter(Boolean) : [];
}

function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** The commit a SOURCE file records, or null when it is missing or unreadable. */
export function parseSource(text) {
  const match = text?.match(/ at ([0-9a-f]{40})( \(with uncommitted changes\))?/);
  return match ? { sha: match[1], dirty: Boolean(match[2]) } : null;
}

/**
 * The release decision from the facts. `localVersions` are the Claude Code and
 * Codex manifest versions; `mirrorVersion` is the published one or null.
 */
export function decide({ localVersions, mirrorVersion, changed }) {
  const versions = [...new Set(localVersions)];
  if (versions.length > 1) return { status: 'VERSIONS DIFFER', note: `.claude-plugin and .codex-plugin must match; local has ${versions.join(', ')}` };
  const [local] = versions;
  if (mirrorVersion === null) return { status: 'never staged', note: 'the mirror has no plugin.json on origin/main' };
  const order = compareVersions(local, mirrorVersion);
  if (order < 0) return { status: 'LOCAL BEHIND MIRROR', note: `local ${local} is older than published ${mirrorVersion}` };
  if (order > 0) return { status: 'stage (already bumped)', note: `local ${local}, mirror ${mirrorVersion}` };
  return changed
    ? { status: 'bump+stage', note: `${local} is published and its sources changed since; installs only update on a new version` }
    : { status: 'up to date', note: local };
}

function pluginVersion(readJson) {
  return ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'].map((rel) => readJson(rel)?.version ?? null);
}

export function mirrorStatus(mirrorDir = DEFAULT_MIRROR) {
  if (!existsSync(path.join(mirrorDir, '.git'))) {
    return { status: 'NO MIRROR CLONE', note: `clone git@github.com:nimbalyst/nimbalyst-wiki.git into ${mirrorDir}`, mirrorDir };
  }
  const fetched = run('git', ['-C', mirrorDir, 'fetch', '--quiet', 'origin']) !== null;
  const remoteFile = (rel) => run('git', ['-C', mirrorDir, 'show', `origin/main:${rel}`]);
  const remoteJson = (rel) => {
    const text = remoteFile(rel);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  const localJson = (rel) => JSON.parse(readFileSync(path.join(REPO_ROOT, 'plugins/nimbalyst-wiki', rel), 'utf8'));
  const monorepoMainJson = (rel) => {
    const text = run('git', ['show', `origin/main:plugins/nimbalyst-wiki/${rel}`], { cwd: REPO_ROOT });
    return text ? JSON.parse(text) : null;
  };

  const localVersions = pluginVersion(localJson);
  const [mirrorVersion] = pluginVersion(remoteJson);
  const source = parseSource(remoteFile('SOURCE'));
  const baselineKnown = source && run('git', ['cat-file', '-e', `${source.sha}^{commit}`], { cwd: REPO_ROOT }) !== null;
  const log = (watch) => (baselineKnown
    ? lines(run('git', ['log', '--oneline', `${source.sha}..HEAD`, '--', ...watch], { cwd: REPO_ROOT }))
    : []);
  const pluginCommits = log(PLUGIN_WATCH);
  const otherCommits = log(OTHER_WATCH).filter((c) => !pluginCommits.includes(c));
  const uncommitted = lines(run('git', ['status', '--porcelain', '--', ...PLUGIN_WATCH, ...OTHER_WATCH], { cwd: REPO_ROOT }));
  const clone = {
    dirty: lines(run('git', ['-C', mirrorDir, 'status', '--porcelain'])).length > 0,
    branch: run('git', ['-C', mirrorDir, 'rev-parse', '--abbrev-ref', 'HEAD']),
    unpushed: lines(run('git', ['-C', mirrorDir, 'log', '--oneline', 'origin/main..HEAD'])),
  };
  // The `nimbalyst` marketplace installs straight from this repository's main,
  // so the monorepo's pushed version is a second published channel.
  const [monorepoMainVersion] = pluginVersion(monorepoMainJson);

  const decision = decide({
    localVersions,
    mirrorVersion: mirrorVersion ?? null,
    changed: !baselineKnown || pluginCommits.length > 0 || otherCommits.length > 0 || uncommitted.length > 0,
  });
  const notes = [];
  if (!fetched) notes.push('git fetch failed; origin/main may be stale');
  if (!source) notes.push('the mirror has no readable SOURCE; treating every source as changed');
  else if (!baselineKnown) notes.push(`SOURCE commit ${source.sha.slice(0, 9)} is not in this repository; treating every source as changed`);
  if (source?.dirty) notes.push('the last staging was built from uncommitted changes');
  return {
    ...decision,
    mirrorDir,
    localVersions,
    mirrorVersion: mirrorVersion ?? null,
    monorepoMainVersion,
    baseline: source?.sha ?? null,
    pluginCommits,
    otherCommits,
    uncommitted,
    clone,
    notes,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mirrorArg = args.indexOf('--mirror');
  const r = mirrorStatus(mirrorArg >= 0 ? path.resolve(args[mirrorArg + 1]) : DEFAULT_MIRROR);
  if (args.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`\nnimbalyst-wiki mirror: ${r.status} (${r.note})  [${r.mirrorDir}]`);
    if (r.localVersions) {
      console.log(`  plugin  local ${r.localVersions.join('/')}  mirror ${r.mirrorVersion ?? '-'}  monorepo origin/main ${r.monorepoMainVersion ?? '-'}`);
      if (r.baseline) console.log(`  baseline ${r.baseline.slice(0, 9)} (mirror SOURCE)`);
      for (const note of r.notes) console.log(`  note: ${note}`);
      if (r.pluginCommits.length) console.log(`  plugin commits since:\n    ${r.pluginCommits.join('\n    ')}`);
      if (r.otherCommits.length) console.log(`  docs and staging commits since:\n    ${r.otherCommits.slice(0, 30).join('\n    ')}${r.otherCommits.length > 30 ? '\n    ...' : ''}`);
      if (r.uncommitted.length) console.log(`  UNCOMMITTED:\n    ${r.uncommitted.join('\n    ')}`);
      if (r.clone.dirty || r.clone.unpushed.length || r.clone.branch !== 'main') {
        console.log(`  mirror clone: branch ${r.clone.branch}${r.clone.dirty ? ', uncommitted files' : ''}${r.clone.unpushed.length ? `, ${r.clone.unpushed.length} unpushed commit(s)` : ''}`);
      }
    }
  }
}
