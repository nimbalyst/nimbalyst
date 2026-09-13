#!/usr/bin/env node
/**
 * Stage the Docker build context for the Nimbalyst Cloudflare Sandbox image.
 *
 *   node packages/cloudflare-sandbox/container/stage-build-context.mjs [--out <dir>]
 *
 * Copies exactly the paths named in `buildContextAllowlist.mjs` into a scratch
 * directory and writes `<dir>-manifest.json` -- beside that directory, never
 * inside it -- describing what landed there. `docker build` is then pointed at
 * the directory, so the checkout, with its private notes, credentials and
 * host-platform `node_modules`, is never reachable from a Dockerfile
 * instruction, and the manifest itself cannot become part of a layer.
 *
 * The staging directory is disposable, but it is still a directory this script
 * deletes, so it refuses to delete anything that is not one it created: the
 * marker file `.nimbalyst-build-context` must be present, or the run aborts and
 * asks for a different `--out`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWLISTED_DIRS,
  ALLOWLISTED_DIR_MAPPINGS,
  ALLOWLISTED_FILES,
  classifyEntry,
  expandWorkspaceGlobs,
  normalizeStagedPath,
} from './buildContextAllowlist.mjs';

/**
 * The set of paths under `repoRoot` that are in git's index.
 *
 * The name filter can only catch a file that is *named* like a credential. It
 * is no help against `scratch.ts` in an allowlisted source directory with a key
 * pasted into it. Tracking is the property that helps: a tracked file is one
 * somebody put in front of git, and therefore one that shows up in a diff.
 *
 * Index membership specifically, not "git is aware of it". Admitting untracked
 * files as long as they were not *ignored* sounds equivalent and is not: the
 * dangerous file is usually an ordinary scratch file nobody has added yet, and
 * it is not gitignored either. Being unignored says nothing about having been
 * reviewed.
 *
 * Working-tree bytes are what gets staged, not the indexed blob -- the image
 * should reflect the tree that was built, and a mismatch between the two is
 * something the manifest digest records rather than something this hides.
 */
function gitTrackedFiles(repoRoot) {
  let toplevel;
  try {
    toplevel = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(
      `[stage] ${repoRoot} is not a git repository, so the staged files cannot be checked against `
      + 'git. Staging refuses to run rather than copy whatever happens to be on disk.',
    );
  }
  // A repoRoot below the toplevel would make git's output relative to a
  // different directory than the paths being staged, and every lookup would
  // miss -- which would fail closed, but with an error blaming the wrong file.
  // Compared through realpath because git reports the resolved path, and on
  // macOS the temp directory the fixtures use is itself a symlink.
  if (realpathSync(toplevel) !== realpathSync(repoRoot)) {
    throw new Error(
      `[stage] ${repoRoot} is not the root of its git repository (${toplevel}).`,
    );
  }
  const listed = execFileSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '-z'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return new Set(listed.split('\0').filter((line) => line.length > 0));
}

const CONTAINER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CONTAINER_DIR, '../../..');
const DEFAULT_OUT = path.join(CONTAINER_DIR, '.build-context');
const MARKER = '.nimbalyst-build-context';

/**
 * Where the manifest for a staging directory is written: beside it, never in
 * it. `docker build` is handed `outDir` and `COPY . /build` takes all of it, so
 * a file written inside is a file that ships.
 */
export function manifestPathFor(outDir) {
  const resolved = path.resolve(outDir);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}-manifest.json`);
}

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out requires a directory');
      args.out = path.resolve(value);
    } else if (argv[i] === '--print-manifest') {
      args.printManifest = true;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

/** Delete a previous staging directory, but only one this script produced. */
function resetOutDir(outDir) {
  if (existsSync(outDir)) {
    if (!existsSync(path.join(outDir, MARKER))) {
      throw new Error(
        `[stage] refusing to delete ${outDir}: it has no ${MARKER} marker, so it was not `
        + 'produced by this script. Pass a different --out.',
      );
    }
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, MARKER),
    'Generated by packages/cloudflare-sandbox/container/stage-build-context.mjs. Safe to delete.\n',
  );
}

/**
 * Stage one tree. Exported, and parameterised on `repoRoot`, so the symlink and
 * credential refusals can be exercised against a real fixture directory rather
 * than asserted against this file's source text.
 */
export function stageBuildContext({ repoRoot = REPO_ROOT, outDir }) {
  const staged = [];
  const tracked = gitTrackedFiles(repoRoot);

  /**
   * Refuse a symlink at `relPath` or at any directory above it.
   *
   * A symlink is a hole in the allowlist: following one copies whatever it
   * points at, which is by definition a path nobody allowlisted.
   * `~/.aws/credentials` is one `ln -s` away from a layer that ships, and a
   * layer cannot be un-published. No staged path legitimately contains a link,
   * so one appearing means the assumption behind this script has changed and a
   * human should look -- hence refuse, rather than skip or recreate.
   *
   * Checking only the final component is not enough: `packages/runtime` can be
   * a link while `packages/runtime/src` is an ordinary directory, and every
   * `lstat` on the child then reports a real directory. The link is one level
   * up, and the whole subtree it resolves to gets staged. So each segment from
   * the repository root down is checked in turn, and the first link anywhere on
   * the path aborts the stage naming the exact segment.
   */
  function assertNoSymlinkOnPath(relPath) {
    const segments = relPath.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const ancestorRel = segments.slice(0, i + 1).join('/');
      const ancestorAbs = path.join(repoRoot, ancestorRel);
      const stats = lstatSafe(ancestorAbs);
      if (stats?.isSymbolicLink()) {
        throw new Error(
          `[stage] refusing to stage a symlink: ${ancestorRel} -> ${readlinkSync(ancestorAbs)}`
          + (ancestorRel === relPath ? '. ' : ` (an ancestor of ${relPath}). `)
          + 'Following it would copy files the allowlist never named.',
        );
      }
    }
  }

  function lstatSafe(absPath) {
    try {
      return lstatSync(absPath);
    } catch {
      return undefined;
    }
  }

  function stageFile(relPath, targetRel = relPath) {
    const normalized = normalizeStagedPath(relPath);
    const targetPath = normalizeStagedPath(targetRel);
    const source = path.join(repoRoot, normalized);
    if (!existsSync(source)) {
      throw new Error(`[stage] allowlisted path is missing from the checkout: ${normalized}`);
    }
    assertNoSymlinkOnPath(normalized);
    if (!tracked.has(normalized)) {
      throw new Error(
        `[stage] git does not track ${normalized}, so it has never appeared in a diff and nothing `
        + 'has reviewed what is in it. Add it to the index (`git add`) if it belongs in the image; '
        + 'if it is scratch, remove it -- anything the image needs at run time belongs in its '
        + 'config file, not in a layer.',
      );
    }
    const target = path.join(outDir, targetPath);
    mkdirSync(path.dirname(target), { recursive: true });
    // Read once, then hash and write THAT buffer. Copying and re-reading the
    // source leaves a window in which the bytes recorded in the manifest are
    // not the bytes in the context -- and the manifest's only job is to let a
    // reviewer say "the tree I approved is the tree that was built".
    const contents = readFileSync(source);
    writeFileSync(target, contents);
    staged.push({
      path: targetPath,
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    });
  }

  function stageDir(relDir, targetRel = relDir) {
    const normalized = normalizeStagedPath(relDir);
    const targetDir = normalizeStagedPath(targetRel);
    const source = path.join(repoRoot, normalized);
    if (!existsSync(source)) {
      throw new Error(`[stage] allowlisted directory is missing from the checkout: ${normalized}`);
    }
    assertNoSymlinkOnPath(normalized);
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const childRel = `${normalized}/${entry.name}`;
      const childTarget = `${targetDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        // Checked before the name policy: a symlink named `index.ts` is still a
        // symlink, and its name tells you nothing about where it points.
        assertNoSymlinkOnPath(childRel);
      }
      const verdict = classifyEntry({ name: entry.name, isDirectory: entry.isDirectory() });
      if (verdict === 'reject') {
        throw new Error(
          `[stage] refusing to stage a credential-shaped file: ${childRel}. If this file is `
          + 'genuinely required, it does not belong in a container image -- pass it as sandbox '
          + 'configuration at run time instead.',
        );
      }
      if (verdict === 'skip') continue;
      if (entry.isDirectory()) {
        stageDir(childRel, childTarget);
      } else if (entry.isFile()) {
        stageFile(childRel, childTarget);
      }
      // Anything else -- sockets, fifos, devices -- is not stageable and is left
      // behind. Symlinks never reach here; they threw above.
    }
  }

  function workspaceManifests() {
    const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const dirs = expandWorkspaceGlobs(rootPkg.workspaces ?? [], (parent) => {
      const abs = path.join(repoRoot, parent);
      if (!existsSync(abs)) return [];
      return readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(path.join(abs, e.name, 'package.json')))
        .map((e) => e.name);
    });
    return dirs
      .map((dir) => `${dir}/package.json`)
      .filter((rel) => existsSync(path.join(repoRoot, rel)));
  }

  resetOutDir(outDir);

  for (const rel of ALLOWLISTED_FILES) stageFile(rel);
  for (const rel of workspaceManifests()) {
    // Some workspace manifests are already staged by name above.
    if (!staged.some((s) => s.path === normalizeStagedPath(rel))) stageFile(rel);
  }
  for (const rel of ALLOWLISTED_DIRS) stageDir(rel);
  for (const { from, to } of ALLOWLISTED_DIR_MAPPINGS) stageDir(from, to);

  staged.sort((a, b) => a.path.localeCompare(b.path));
  // Over each file's path AND its content hash. A digest over paths and sizes
  // would be unchanged by a same-length edit to any staged file, which is
  // exactly the edit a review of "this digest was approved" must catch.
  const contentDigest = createHash('sha256')
    .update(staged.map((s) => `${s.path}:${s.sha256}`).join('\n'))
    .digest('hex');
  const manifest = {
    generatedBy: 'packages/cloudflare-sandbox/container/stage-build-context.mjs',
    // No `repoRoot`. It was the absolute path of whoever ran the build, it
    // answered no question a reviewer of "which tree was this" actually has --
    // the file list and digest do that -- and while the manifest was written
    // inside the context it travelled into a published layer.
    fileCount: staged.length,
    totalBytes: staged.reduce((sum, s) => sum + s.bytes, 0),
    // Identifies the staged tree by content, with no timestamp: an unchanged
    // checkout stages to the same digest, and a changed byte anywhere changes it.
    contentDigest,
    files: staged.map((s) => ({ path: s.path, bytes: s.bytes, sha256: s.sha256 })),
  };
  writeFileSync(manifestPathFor(outDir), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = stageBuildContext({ outDir: args.out });

  process.stdout.write(
    `[stage] ${manifest.fileCount} files, ${(manifest.totalBytes / 1e6).toFixed(1)} MB -> ${args.out}\n`
    + `[stage] content digest ${manifest.contentDigest}\n`
    + `[stage] manifest ${manifestPathFor(args.out)}\n`,
  );
  if (args.printManifest) {
    process.stdout.write(`${manifest.files.map((f) => `${f.sha256}  ${f.path}`).join('\n')}\n`);
  }
}

// Importable for tests; only stages when run as a script.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
