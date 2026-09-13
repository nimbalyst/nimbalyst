/**
 * Gate: the Dockerfile's pins agree with image.config.json, and staging refuses
 * symlinks against a real filesystem.
 *
 *   node --test packages/cloudflare-sandbox/container/checks/*.test.mjs
 *
 * Deliberately `node --test` and not vitest. These are text assertions over a
 * config file plus a filesystem fixture -- a gate, not a unit test -- and the
 * repo's unit suite is a shared cost every later session pays to load.
 *
 * The pin that matters most: the @cloudflare/sandbox SDK in the Worker and the
 * container server inside the base image speak a versioned protocol. A drift
 * between the two shows up at run time as an opaque exec failure, in
 * production, rather than as a build error here.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { CONTEXT_ONLY_PATHS, isSecretFileName } from '../buildContextAllowlist.mjs';
import { manifestPathFor, stageBuildContext } from '../stage-build-context.mjs';

const CONTAINER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(path.join(CONTAINER_DIR, 'Dockerfile'), 'utf8');
const imageConfig = JSON.parse(readFileSync(path.join(CONTAINER_DIR, 'image.config.json'), 'utf8'));

test('preview control probe bundles for the image without host npm dependencies', async () => {
  const result = await build({ entryPoints: [path.join(CONTAINER_DIR, 'checks/preview-control-probe.mjs')], bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false, metafile: true });
  const output = Object.values(result.metafile.outputs)[0];
  assert.ok(output.imports.every(entry => entry.path.startsWith('node:')));
});

test('the Dockerfile builds the sandbox version image.config.json declares', () => {
  const { sdkVersion, imageRef } = imageConfig.sandbox;
  assert.equal(imageRef, `docker.io/cloudflare/sandbox:${sdkVersion}`);
  const workerPackage = JSON.parse(readFileSync(path.join(CONTAINER_DIR, '../package.json'), 'utf8'));
  const release = JSON.parse(readFileSync(path.join(CONTAINER_DIR, '../release.json'), 'utf8'));
  assert.equal(sdkVersion, workerPackage.dependencies['@cloudflare/sandbox']);
  assert.equal(sdkVersion, release.sdkVersion);
  const desktop = readFileSync(path.join(CONTAINER_DIR, '../../electron/src/main/services/cloudflareSandbox/artifactProvider.ts'), 'utf8');
  assert.equal(/SANDBOX_SDK_VERSION = ["']([^"']+)["']/.exec(desktop)?.[1], sdkVersion, 'desktop artifact parser must accept the pinned Worker SDK');
  assert.match(sdkVersion, /^0\.13\.0-next\./);
  assert.deepEqual(imageConfig.sandbox.entrypoint, ['/usr/bin/tini', '--', '/container-server/sandbox']);
  assert.match(dockerfile, new RegExp(`^ARG SANDBOX_VERSION=${sdkVersion}$`, 'm'));
});

test('the base image default is pinned by digest, not by a mutable tag', () => {
  // A tag can be repushed. If the default were `…:0.12.9`, the image under a
  // deployed Worker could change with nothing in this repository changing, and
  // no review would ever see it.
  const { imageDigest, imageRef } = imageConfig.sandbox;
  assert.match(imageDigest, /^sha256:[0-9a-f]{64}$/);
  const defaultLine = /^ARG SANDBOX_BASE_IMAGE=(.+)$/m.exec(dockerfile);
  assert.ok(defaultLine, 'SANDBOX_BASE_IMAGE must have a default');
  assert.ok(
    defaultLine[1].endsWith(`@${imageDigest}`),
    `SANDBOX_BASE_IMAGE default must end with @${imageDigest}, got ${defaultLine[1]}`,
  );
  assert.ok(defaultLine[1].startsWith(imageRef), 'the digest must be pinned on the declared repository');
});

test('the Dockerfile installs the checksum-pinned Node the repo requires', () => {
  assert.ok(Number(imageConfig.node.version.split('.')[0]) >= 24, 'Node major must be >= 24');
  assert.match(dockerfile, new RegExp(`^ARG NODE_VERSION=${imageConfig.node.version}$`, 'm'));
  assert.match(dockerfile, new RegExp(`^ARG NODE_SHA256=${imageConfig.node.tarballSha256}$`, 'm'));
  assert.ok(dockerfile.includes('sha256sum -c -'), 'the tarball must be checksum-verified');
});

test('the Dockerfile leaves the base entrypoint alone and never copies the checkout', () => {
  // The inherited tini and control server cannot provide a root execution path.
  assert.doesNotMatch(dockerfile, /^\s*(ENTRYPOINT|CMD)\s/m);
  assert.match(dockerfile, /^USER 10001:10001$/m);
  const finalStage = dockerfile.slice(dockerfile.indexOf('FROM ${SANDBOX_BASE_IMAGE}'));
  for (const line of finalStage.split('\n').filter((l) => l.startsWith('COPY '))) {
    assert.match(line, /^COPY (--from=\S+ |bin\/)/, `final-stage COPY reads the host context: ${line}`);
  }
});

test('the Worker readiness command is the launcher this image installs', () => {
  // The parent Worker execs exactly this. If the launcher moves, that call
  // fails at run time with a bare "no such file".
  assert.ok(dockerfile.includes('COPY bin/nimbalyst-node /opt/nimbalyst/bin/nimbalyst-node'));
  assert.ok(dockerfile.includes('RUN nimbalyst-node --smoke'), 'the build must run the smoke check');
  const launcher = readFileSync(path.join(CONTAINER_DIR, 'bin/nimbalyst-node'), 'utf8');
  assert.ok(launcher.includes('--smoke'), 'the launcher must accept --smoke');
  // Dropping to uid 10001 leaves the capability bounding set untouched, so a
  // later setuid binary could hand capabilities back to the very process tree
  // that just gave up root.
  assert.ok(launcher.includes('--bounding-set -all'), 'the launcher must empty the bounding set');
  // The root branch is not the one the image takes -- USER 10001 means the
  // non-root path is the normal path, and it went from uid 0 handling to no
  // handling at all. Both branches must exec through setpriv.
  const execs = launcher.split('\n').filter((l) => /^\s*exec\b/.test(l));
  assert.equal(execs.length, 2, 'the launcher should have exactly a root and a non-root exec');
  for (const line of execs) {
    assert.match(line, /\bsetpriv\b/, `every exec must go through setpriv: ${line.trim()}`);
  }
  assert.equal(
    launcher.match(/--no-new-privs/g)?.length, 2,
    'both branches must set no_new_privs; the unprivileged one cannot drop capabilities instead',
  );
  // The bits the bounding set was meant to neutralise, removed at the source.
  assert.match(dockerfile, /find\s+\/\s+-xdev\s+-perm\s+\/6000\s+-type\s+f\s+-exec\s+chmod\s+a-s/,
    'the image must strip setuid/setgid bits');
});

/**
 * Build a fixture repository the stager will accept: enough of the allowlist
 * present that it reaches the interesting directory, and nothing real.
 *
 * It is a real git repository, with its index populated, because the stager
 * asks git which files are tracked and a fixture that stubbed that question out
 * would be testing the stub. `git add` only -- no commit, so no author config
 * and no hooks are involved. Anything written to the fixture AFTER this
 * function returns is untracked, which several tests below rely on.
 */
function makeFixtureRepo(root) {
  const write = (rel, contents) => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  };
  write('package.json', JSON.stringify({ name: 'fixture', workspaces: ['packages/node', 'packages/collab-protocol'] }));
  write('package-lock.json', '{}');
  // `packages/tracker-core/tsconfig.json` extends this. Its absence is what
  // broke the first real image build.
  write('tsconfig.json', '{"compilerOptions":{"target":"ES2020"}}');
  write('scripts/install-git-hooks.mjs', '// noop\n');
  write('patches/example.patch', 'diff\n');
  for (const pkg of ['node', 'runtime', 'extension-sdk', 'tracker-core', 'collab-protocol', 'collab-adapters']) {
    write(`packages/${pkg}/package.json`, JSON.stringify({ name: `@fixture/${pkg}` }));
    write(`packages/${pkg}/tsconfig.json`, '{}');
    write(`packages/${pkg}/src/index.ts`, 'export const ok = true;\n');
  }
  write('packages/runtime/tsconfig.node.json', '{}');
  write('packages/collab-protocol/tsconfig.build.json', '{"extends":"./tsconfig.json","compilerOptions":{"outDir":"dist"}}');
  write('packages/runtime/scripts/add-node-extensions.mjs', '// noop\n');
  write('packages/node/nimbalyst-node.config.example.json', '{}');
  write('packages/electron/src/main/database/sqlite/schemas/0001_initial.sql', 'select 1;\n');
  write('packages/cloudflare-sandbox/container/bin/nimbalyst-node', '#!/bin/sh\n');
  // Refuse to run git anywhere but the throwaway tree this function just built.
  // `git init` inside the real checkout would be a nested repository nobody
  // asked for; the assertion costs one syscall.
  assert.ok(realpathSync(root).startsWith(realpathSync(os.tmpdir())), 'fixture must live under the temp dir');
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['add', '--all', '.'], { cwd: root, stdio: 'pipe' });
}

test('staging a clean fixture succeeds and hashes file contents', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-stage-'));
  try {
    const repo = path.join(tmp, 'repo');
    makeFixtureRepo(repo);
    const first = stageBuildContext({ repoRoot: repo, outDir: path.join(tmp, 'out') });
    assert.ok(first.fileCount > 0);
    assert.ok(first.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
    for (const rel of ['packages/collab-protocol/tsconfig.build.json', 'packages/collab-protocol/package.json']) {
      assert.ok(first.files.some(file => file.path === rel), `missing protocol build input: ${rel}`);
      assert.equal(readFileSync(path.join(tmp, 'out', rel), 'utf8'), readFileSync(path.join(repo, rel), 'utf8'));
    }

    // A same-length edit: a size-keyed digest would not notice this.
    const target = path.join(repo, 'packages/node/src/index.ts');
    const before = readFileSync(target, 'utf8');
    writeFileSync(target, before.replace('true', 'fals'));
    assert.equal(readFileSync(target, 'utf8').length, before.length, 'fixture edit must be same-length');

    const second = stageBuildContext({ repoRoot: repo, outDir: path.join(tmp, 'out') });
    assert.notEqual(second.contentDigest, first.contentDigest, 'digest must track content, not size');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('staging refuses a symlink rather than following it out of the allowlist', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-stage-'));
  try {
    const repo = path.join(tmp, 'repo');
    makeFixtureRepo(repo);
    // A file the allowlist never named, reachable only through a link inside a
    // directory it did name. Dereferencing copies it into a shipped layer, and
    // the link's own name ("index.ts") says nothing about that.
    const secret = path.join(tmp, 'outside-secret.txt');
    writeFileSync(secret, 'private');
    symlinkSync(secret, path.join(repo, 'packages/node/src/linked.ts'));

    assert.throws(
      () => stageBuildContext({ repoRoot: repo, outDir: path.join(tmp, 'out') }),
      /refusing to stage a symlink/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('staging refuses a symlinked ancestor directory, not just a symlinked file', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-stage-'));
  try {
    const repo = path.join(tmp, 'repo');
    makeFixtureRepo(repo);
    // The subtle case: `packages/runtime` is the link, `packages/runtime/src`
    // is an ordinary directory. Every lstat on the child reports a real
    // directory, so a final-component check passes and the entire linked tree
    // is staged.
    const outside = path.join(tmp, 'elsewhere/runtime');
    mkdirSync(path.join(outside, 'src'), { recursive: true });
    writeFileSync(path.join(outside, 'src/index.ts'), 'export const smuggled = true;\n');
    writeFileSync(path.join(outside, 'tsconfig.json'), '{}');
    writeFileSync(path.join(outside, 'tsconfig.node.json'), '{}');
    mkdirSync(path.join(outside, 'scripts'), { recursive: true });
    writeFileSync(path.join(outside, 'scripts/add-node-extensions.mjs'), '// noop\n');
    writeFileSync(path.join(outside, 'package.json'), '{"name":"@fixture/runtime"}');
    rmSync(path.join(repo, 'packages/runtime'), { recursive: true, force: true });
    symlinkSync(outside, path.join(repo, 'packages/runtime'));

    assert.throws(
      () => stageBuildContext({ repoRoot: repo, outDir: path.join(tmp, 'out') }),
      /refusing to stage a symlink: packages\/runtime .*an ancestor of/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('staging refuses a credential-shaped file inside an allowlisted directory', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-stage-'));
  try {
    const repo = path.join(tmp, 'repo');
    makeFixtureRepo(repo);
    writeFileSync(path.join(repo, 'packages/node/src/.env'), 'API_KEY=live\n');

    assert.throws(
      () => stageBuildContext({ repoRoot: repo, outDir: path.join(tmp, 'out') }),
      /credential-shaped file/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the credential filter does not depend on a file having an extension', () => {
  // Every name here is a real-world credential shape that the extension-anchored
  // patterns let through: the cloud CLIs write `credentials` with no suffix,
  // Wrangler moved from TOML to JSON, and `local.env` is not `.env`.
  for (const name of [
    'credentials',
    '.credentials',
    'wrangler.json',
    'wrangler.jsonc',
    'wrangler.toml',
    'ci.token',
    'service-account-prod.json',
    'local.env',
    '.env.production',
    'id_ed25519',
  ]) {
    assert.equal(isSecretFileName(name), true, `${name} must be treated as a credential`);
  }
  // The counterweight: source files whose names merely mention the subject.
  for (const name of ['credentials.ts', 'useCredentials.tsx', 'tokenizer.ts', 'environment.ts']) {
    assert.equal(isSecretFileName(name), false, `${name} is source, not a credential`);
  }
});

test('staging refuses a gitignored scratch file inside an allowlisted directory', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-stage-'));
  try {
    const repo = path.join(tmp, 'repo');
    makeFixtureRepo(repo);
    // The name filter cannot help here: this is an ordinary `.ts` name. What
    // makes it dangerous is that nobody has ever reviewed it -- it is ignored,
    // so it appears in no diff, and a key pasted into it would ship silently.
    writeFileSync(path.join(repo, '.gitignore'), 'packages/node/src/scratch.ts\n');
    writeFileSync(path.join(repo, 'packages/node/src/scratch.ts'), 'const key = "sk-live";\n');

    assert.throws(
      () => stageBuildContext({ repoRoot: repo, outDir: path.join(tmp, 'out') }),
      /git does not track.*packages\/node\/src\/scratch\.ts/s,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('staging refuses an untracked scratch file even when nothing ignores it', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-stage-'));
  try {
    const repo = path.join(tmp, 'repo');
    makeFixtureRepo(repo);
    // No .gitignore anywhere. This is the ordinary case -- a file someone
    // created and has not added yet -- and it is the one a gate keyed on "not
    // ignored" waves through, because being unignored is not evidence of
    // having been looked at by anybody.
    writeFileSync(path.join(repo, 'packages/node/src/scratch.ts'), 'const key = "sk-live";\n');

    assert.throws(
      () => stageBuildContext({ repoRoot: repo, outDir: path.join(tmp, 'out') }),
      /git does not track.*packages\/node\/src\/scratch\.ts/s,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a tracked file stages its working-tree bytes, not the indexed blob', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-stage-'));
  try {
    const repo = path.join(tmp, 'repo');
    makeFixtureRepo(repo);
    // Tracking is the admission check, not the source of the content. The image
    // must contain the tree that was built; silently substituting the indexed
    // blob would build something nobody asked for and pass every test.
    const rel = 'packages/node/src/index.ts';
    const edited = 'export const ok = "edited in the working tree";\n';
    writeFileSync(path.join(repo, rel), edited);

    const outDir = path.join(tmp, 'out');
    stageBuildContext({ repoRoot: repo, outDir });
    assert.equal(readFileSync(path.join(outDir, rel), 'utf8'), edited);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('staging refuses a repository root git cannot answer for', () => {
  // Fail closed. If the visibility gate cannot run, staging must stop rather
  // than fall back to copying whatever is on disk.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-stage-'));
  try {
    const repo = path.join(tmp, 'repo');
    makeFixtureRepo(repo);
    rmSync(path.join(repo, '.git'), { recursive: true, force: true });

    assert.throws(
      () => stageBuildContext({ repoRoot: repo, outDir: path.join(tmp, 'out') }),
      /not a git repository/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the manifest is written beside the context, never inside it, and names no host path', () => {
  // `COPY . /build` takes the whole context, so anything the stager leaves in
  // there ships. The manifest is the reviewer's record of what was built; it is
  // not an input to the build, and it used to carry the absolute path of the
  // maintainer's checkout straight into a published layer.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-stage-'));
  try {
    const repo = path.join(tmp, 'repo');
    makeFixtureRepo(repo);
    const outDir = path.join(tmp, 'out');
    const manifest = stageBuildContext({ repoRoot: repo, outDir });

    assert.equal(existsSync(path.join(outDir, 'build-context-manifest.json')), false,
      'the manifest must not be inside the directory docker build copies');
    const beside = manifestPathFor(outDir);
    assert.equal(path.dirname(beside), path.dirname(outDir), 'the manifest belongs beside the context');
    assert.ok(existsSync(beside), `the manifest must still be written, at ${beside}`);

    const text = readFileSync(beside, 'utf8');
    assert.ok(!text.includes(repo), 'the manifest must not record the absolute repository path');
    assert.equal(manifest.contentDigest, JSON.parse(text).contentDigest);
    assert.ok(!Object.keys(manifest).includes('repoRoot'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * Dockerfile instructions, with line continuations joined and comments dropped.
 *
 * Needed because the interesting instruction spans eight lines. Matching the
 * raw text for a path is not the same as checking what happens to it: an
 * earlier version of the gate below asserted only that `/build/bin` appeared on
 * a line, and replacing `RUN rm -rf` with `RUN printf` left all 14 tests green
 * while shipping the scaffolding.
 */
function dockerfileInstructions(text) {
  return text
    .replace(/\\\r?\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

test('the builder deletes context-only scaffolding before the final stage copies it', () => {
  // `bin/` and the marker have to be in the context -- the Dockerfile copies the
  // launcher from it, and the stager refuses to delete a directory it cannot
  // identify as its own -- but neither has any business in the shipped app
  // directory, where a second copy of the launcher makes it ambiguous which one
  // runs.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-stage-'));
  try {
    const repo = path.join(tmp, 'repo');
    makeFixtureRepo(repo);
    const outDir = path.join(tmp, 'out');
    stageBuildContext({ repoRoot: repo, outDir });
    for (const rel of CONTEXT_ONLY_PATHS) {
      assert.ok(existsSync(path.join(outDir, rel)), `the build still needs ${rel} in the context`);
    }

    const instructions = dockerfileInstructions(dockerfile);
    const builderAt = instructions.findIndex((i) => /^FROM\s+\S+\s+AS\s+builder$/i.test(i));
    assert.ok(builderAt >= 0, 'the builder stage must exist');
    const nextStageAt = instructions.findIndex((i, at) => at > builderAt && /^FROM\s/i.test(i));
    const builderStage = instructions.slice(builderAt, nextStageAt < 0 ? undefined : nextStageAt);

    // The instruction must actually delete. `RUN printf …` mentioning the same
    // paths must not satisfy this.
    const removals = builderStage.filter((i) => /^RUN\b/.test(i) && /\brm\s+-rf\b/.test(i));
    assert.ok(removals.length > 0, 'the builder stage must contain a `rm -rf` instruction');
    for (const rel of CONTEXT_ONLY_PATHS) {
      const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.ok(
        removals.some((i) => new RegExp(`\\brm\\s+-rf\\b[^\\n]*\\s/build/${escaped}(?=\\s|$)`).test(i)),
        `a builder-stage \`rm -rf\` must name /build/${rel} so it cannot reach /opt/nimbalyst/app`,
      );
    }

    // …and it must happen before the whole tree is carried into the image.
    const copyAt = instructions.findIndex((i) => /^COPY\s+--from=builder\b/i.test(i));
    assert.ok(copyAt >= 0, 'the final stage must copy the builder tree');
    assert.ok(
      instructions.indexOf(removals[removals.length - 1]) < copyAt,
      'the removal must precede COPY --from=builder, or the scaffolding ships anyway',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
