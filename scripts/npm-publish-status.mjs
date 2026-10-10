#!/usr/bin/env node
// Which npm packages this repo publishes need a new release, and why.
//
// For each release group it compares the local version with the registry and
// lists the commits (and uncommitted files) since the last publish that touch
// what the package is built from. The baseline is the published `gitHead` when
// npm recorded one, else the commit at the version's publish time (a hand
// `npm publish <tarball>` records no gitHead), which can be off by a commit.
//
// npm is run from the OS temp dir: inside this repo the root package.json's
// devEngines (pnpm only) makes every npm command fail.
//
//   node scripts/npm-publish-status.mjs [cli|sdk] [--json]

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Release groups. Packages in a group share one version and one workflow.
 * `watch` is everything the published files are built from; collab-client and
 * the runtime editor reach wiki-web through the prebuilt collab-bundle, so a
 * change there may not change wiki-web (it can over-report, never under-report).
 */
export const GROUPS = {
  cli: {
    workflow: 'publish-cli.yml',
    packages: ['packages/cli', 'packages/wiki-web'],
    watch: [
      'packages/cli/src', 'packages/cli/scripts', 'packages/cli/package.json', 'packages/cli/README.md',
      'packages/local-wiki/src', 'packages/tracker-core/src', 'packages/collab-protocol/src',
      'packages/wiki-web/src', 'packages/wiki-web/index.html', 'packages/wiki-web/vite.config.ts', 'packages/wiki-web/package.json',
      'packages/collab-bundle/src', 'packages/collab-client/src', 'packages/runtime/src/editor',
    ],
  },
  sdk: {
    workflow: 'publish-extension-sdk.yml',
    packages: ['packages/extension-sdk'],
    watch: ['packages/extension-sdk/src', 'packages/extension-sdk/package.json', 'packages/extension-sdk/README.md', 'packages/extension-sdk/CHANGELOG.md'],
  },
};

function run(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...options }).trimEnd();
  } catch {
    return null;
  }
}

function npmView(name) {
  const out = run('npm', ['view', name, '--json'], { cwd: tmpdir() });
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * The release decision from the facts. `published` is the registry's latest
 * version or null; `changed` is whether anything watched moved since then.
 */
export function decide({ localVersions, published, changed }) {
  const versions = [...new Set(localVersions)];
  if (versions.length > 1) return { status: 'VERSIONS DIFFER', note: `the group must share one version; local has ${versions.join(', ')}` };
  const [local] = versions;
  if (published === null) return { status: 'never published', note: 'the first version is published by hand (see RELEASING.md)' };
  const order = compareVersions(local, published);
  if (order < 0) return { status: 'LOCAL BEHIND NPM', note: `local ${local} is older than published ${published}` };
  if (order > 0) return { status: 'publish (already bumped)', note: `local ${local}, npm ${published}` };
  return changed ? { status: 'bump+publish', note: `${local} is published and the source changed since` } : { status: 'up to date', note: `${local}` };
}

function baselineCommit(meta, version) {
  if (meta?.gitHead && run('git', ['cat-file', '-e', `${meta.gitHead}^{commit}`], { cwd: REPO_ROOT }) !== null) {
    return { sha: meta.gitHead, how: 'published gitHead' };
  }
  const at = meta?.time?.[version];
  if (!at) return null;
  const sha = run('git', ['rev-list', '-1', `--before=${at}`, 'HEAD'], { cwd: REPO_ROOT });
  return sha ? { sha, how: `last commit before the publish time (${at}), estimated` } : null;
}

export function groupStatus(key) {
  const group = GROUPS[key];
  const pkgs = group.packages.map((dir) => {
    const json = JSON.parse(readFileSync(path.join(REPO_ROOT, dir, 'package.json'), 'utf8'));
    const meta = npmView(json.name);
    return { dir, name: json.name, version: json.version, published: meta?.version ?? null, meta };
  });
  // The group's baseline: the oldest of its packages' last publishes, so nothing is missed.
  const lead = pkgs[0];
  const baseline = lead.published ? baselineCommit(lead.meta, lead.published) : null;
  const commits = baseline
    ? (run('git', ['log', '--oneline', `${baseline.sha}..HEAD`, '--', ...group.watch], { cwd: REPO_ROOT }) ?? '').split('\n').filter(Boolean)
    : [];
  const uncommitted = (run('git', ['status', '--porcelain', '--', ...group.watch], { cwd: REPO_ROOT }) ?? '').split('\n').filter(Boolean);
  const published = pkgs.every((p) => p.published) ? pkgs.map((p) => p.published).sort(compareVersions)[0] : null;
  const decision = decide({ localVersions: pkgs.map((p) => p.version), published, changed: commits.length > 0 || uncommitted.length > 0 });
  return {
    group: key,
    workflow: group.workflow,
    packages: pkgs.map(({ name, version, published: p }) => ({ name, local: version, npm: p })),
    baseline,
    commits,
    uncommitted,
    ...decision,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const keys = args.filter((a) => !a.startsWith('--'));
  const results = (keys.length ? keys : Object.keys(GROUPS)).map((key) => {
    if (!GROUPS[key]) {
      console.error(`Unknown group '${key}'. Known: ${Object.keys(GROUPS).join(', ')}`);
      process.exit(2);
    }
    return groupStatus(key);
  });
  if (args.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n${r.group}: ${r.status} (${r.note})  [workflow ${r.workflow}]`);
      for (const p of r.packages) console.log(`  ${p.name}  local ${p.local}  npm ${p.npm ?? '-'}`);
      if (r.baseline) console.log(`  baseline ${r.baseline.sha.slice(0, 9)} (${r.baseline.how})`);
      if (r.commits.length) console.log(`  ${r.commits.length} commit(s) since:\n    ${r.commits.slice(0, 30).join('\n    ')}${r.commits.length > 30 ? '\n    ...' : ''}`);
      if (r.uncommitted.length) console.log(`  UNCOMMITTED:\n    ${r.uncommitted.join('\n    ')}`);
    }
  }
}
