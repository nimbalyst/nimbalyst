#!/usr/bin/env node
// Assembles the public nimbalyst/nimbalyst-wiki repository from this one. That
// repository is publish output: the plugin and its team add-on, laid out so
// `/plugin marketplace add nimbalyst/nimbalyst-wiki` (Claude Code), `codex
// plugin marketplace add nimbalyst/nimbalyst-wiki` and the Anthropic plugin
// directory install it without cloning the monorepo. It holds no code: the
// plugin runs `@nimbalyst/cli` from npm, pinned to its version, which also
// brings the browser app. The source stays here; changes land here and are
// staged out.
//
// Layout of the staged repository (the plugin is its root):
//
//   .claude-plugin/plugin.json, marketplace.json   Claude Code and Codex
//   .codex-plugin/, .codex-mcp.json, .mcp.json      from plugins/nimbalyst-wiki
//   skills/, hooks/                                 from plugins/nimbalyst-wiki
//   nimbalyst-wiki-team/                            the team server add-on, from plugins/nimbalyst-wiki-team
//   README.md, LICENSE, FORMAT.md, CONTRIBUTING.md
//
//   node scripts/stage-wiki-repo.mjs <dir>                      stage into <dir>
//   node scripts/stage-wiki-repo.mjs <dir> --skip-npm-check     stage before npx can install @nimbalyst/cli@<version> (testing only)
//
// <dir> is usually a clone of nimbalyst/nimbalyst-wiki. Everything in it but
// .git is replaced. Committing, tagging and pushing that clone is a separate,
// manual step.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGenerated, checkManifestVersions, cliSpec, listFiles, PLUGIN_DIR, TEAM_PLUGIN_DIR } from './build-wiki-plugin.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = path.join(REPO_ROOT, 'scripts/wiki-repo');
const FORMAT_DOC = path.join(REPO_ROOT, 'packages/local-wiki/FORMAT.md');

/** Links in the plugin README that point into the monorepo, and where they point in the staged repository. */
const README_LINKS = [['../../packages/local-wiki/FORMAT.md', 'FORMAT.md']];

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Plugin files that differ from an earlier staging of the same version. Installs
 * update by version, so a changed plugin published under an unchanged version
 * never reaches anyone who already has it. README.md is rewritten on staging and
 * changes nothing an install runs, so it is not compared.
 */
export function unbumpedChanges(pluginDir, outDir) {
  const versionIn = (dir) => {
    const file = path.join(dir, '.claude-plugin/plugin.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : undefined;
  };
  const staged = versionIn(outDir);
  if (staged === undefined || staged !== versionIn(pluginDir)) return [];
  return listFiles(pluginDir).filter((rel) => {
    if (rel === 'README.md') return false;
    const previous = path.join(outDir, rel);
    return !existsSync(previous) || !readFileSync(previous).equals(readFileSync(path.join(pluginDir, rel)));
  });
}

const KIB = 1024;
const MIB = 1024 * KIB;
const IMAGE_OR_FONT = /\.(svg|png|jpe?g|gif|webp|woff2?|ttf|otf)$/i;
const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * The plugin directory's file limits (claude.com/docs/plugins/pre-submission-checklist)
 * checked against a staged repository, whose root is the nimbalyst-wiki plugin
 * folder. `blocking` stops validation or submission; `held` lets a version
 * through to an Anthropic reviewer before it goes live. The 50 MiB limit on the
 * repository as GitHub archives it is not checked here.
 */
export function directoryLimitFindings(outDir) {
  const files = readdirSync(outDir)
    .filter((entry) => entry !== '.git')
    .flatMap((entry) => (statSync(path.join(outDir, entry)).isDirectory() ? listFiles(path.join(outDir, entry), outDir) : [entry]));
  const blocking = [];
  const held = [];
  let total = 0;
  for (const rel of files) {
    const { size } = statSync(path.join(outDir, rel));
    total += size;
    if (size >= 5 * MIB) blocking.push(`${rel} is ${(size / MIB).toFixed(1)} MiB; every file must be under 5 MiB`);
    else if (size > 256 * KIB && !IMAGE_OR_FONT.test(rel)) held.push(`${rel} is ${Math.round(size / KIB)} KiB; non-image files over 256 KiB are held for a reviewer`);
    if (SYSTEM_FILES.has(path.basename(rel)) || rel.split('/').includes('__MACOSX')) blocking.push(`${rel} is a system file the directory refuses`);
  }
  if (files.length >= 10_000) blocking.push(`${files.length} files; the repository must hold fewer than 10,000`);
  if (total >= 256 * MIB) blocking.push(`${(total / MIB).toFixed(1)} MiB unpacked; the repository must be under 256 MiB`);
  if (files.length > 512) held.push(`${files.length} files; plugins over 512 files are held for a reviewer`);
  return { blocking, held };
}

/**
 * Whether npx can install and run `spec` (`name@x.y.z`) the way the plugin
 * does: the plugin must never point at a version a user can't install. For a
 * few minutes after a publish `npm view` already reports the CLI while npx
 * still fails with ETARGET on its pinned wiki-web, so this runs npx itself,
 * with fresh registry metadata, from outside this repository (whose devEngines
 * npm refuses).
 */
export function canRunPinnedCli(spec, run = (command, args, options) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 180_000, ...options })) {
  try {
    return run('npx', ['-y', '--prefer-online', spec, '--version'], { cwd: tmpdir() }).trim() === spec.slice(spec.lastIndexOf('@') + 1);
  } catch {
    return false;
  }
}

/**
 * Stages the repository, refusing anything the Anthropic plugin directory
 * would block or hold for a reviewer (beyond the pinned npx package itself),
 * and a plugin whose pinned CLI isn't on npm yet.
 */
export function stage(outDir, { npmCheck = true } = {}) {
  const stale = [...checkGenerated(), ...checkManifestVersions()];
  if (stale.length > 0) fail(`The plugin is stale; run node scripts/build-wiki-plugin.mjs first:\n  ${stale.join('\n  ')}`);
  const teamName = path.basename(TEAM_PLUGIN_DIR);
  const unbumped = [...unbumpedChanges(PLUGIN_DIR, outDir), ...unbumpedChanges(TEAM_PLUGIN_DIR, path.join(outDir, teamName)).map((rel) => `${teamName}/${rel}`)];
  if (unbumped.length > 0) {
    fail(`The plugin changed since the last staging but its version did not; bump .claude-plugin and .codex-plugin plugin.json:\n  ${unbumped.join('\n  ')}`);
  }
  const spec = cliSpec();
  if (npmCheck && !canRunPinnedCli(spec)) fail(`npx can't install ${spec} yet; publish it first (/publish-npm cli), or wait a few minutes after publishing for the registry to serve it and its wiki-web`);

  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(outDir)) {
    if (entry !== '.git') rmSync(path.join(outDir, entry), { recursive: true, force: true });
  }

  cpSync(PLUGIN_DIR, outDir, { recursive: true });
  cpSync(TEAM_PLUGIN_DIR, path.join(outDir, teamName), { recursive: true });
  cpSync(TEMPLATE_DIR, outDir, { recursive: true });
  cpSync(FORMAT_DOC, path.join(outDir, 'FORMAT.md'));

  let readme = readFileSync(path.join(PLUGIN_DIR, 'README.md'), 'utf8');
  for (const [from, to] of README_LINKS) {
    if (!readme.includes(`](${from})`)) fail(`README.md no longer links ${from}; update README_LINKS in scripts/stage-wiki-repo.mjs`);
    readme = readme.replaceAll(`](${from})`, `](${to})`);
  }
  writeFileSync(path.join(outDir, 'README.md'), readme);

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'plugins/nimbalyst-wiki', 'plugins/nimbalyst-wiki-team', 'scripts/wiki-repo'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const version = JSON.parse(readFileSync(path.join(PLUGIN_DIR, '.claude-plugin/plugin.json'), 'utf8')).version;
  writeFileSync(path.join(outDir, 'SOURCE'), `Staged from https://github.com/nimbalyst/nimbalyst at ${commit}${dirty ? ' (with uncommitted changes)' : ''}\n`);

  const { blocking, held } = directoryLimitFindings(outDir);
  if (blocking.length > 0) fail(`The staged repository would fail plugin directory validation; do not commit it:\n  ${blocking.join('\n  ')}`);
  if (held.length > 0) fail(`The staged repository would wait for a reviewer in the plugin directory; do not commit it:\n  ${held.join('\n  ')}`);
  return { version, commit, dirty: Boolean(dirty) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (!outArg) fail('usage: node scripts/stage-wiki-repo.mjs <dir> [--skip-npm-check]');
  const outDir = path.resolve(outArg);
  if (outDir === REPO_ROOT || REPO_ROOT.startsWith(outDir + path.sep)) fail(`refusing to stage into ${outDir}: it holds this repository`);
  const result = stage(outDir, { npmCheck: !process.argv.includes('--skip-npm-check') });
  console.log(`Staged nimbalyst-wiki ${result.version} into ${outDir}${result.dirty ? ' (source has uncommitted changes)' : ''}.`);
}
