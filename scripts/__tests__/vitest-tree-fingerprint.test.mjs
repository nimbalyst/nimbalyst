import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareTreeFingerprint, computeTreeFingerprint } from '../vitest-tree-fingerprint.mjs';

// Every git call here must land in the scratch repo. A pre-push hook exports
// GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE pointing at the REAL checkout and
// those beat `cwd`, so the sandbox is only a sandbox once they are gone.
function sandboxEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  const missingConfig = path.join(tmpdir(), 'nim-fingerprint-absent-gitconfig');
  env.GIT_CONFIG_GLOBAL = missingConfig;
  env.GIT_CONFIG_SYSTEM = missingConfig;
  env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
  return env;
}

const ENV = sandboxEnv();

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV });
}

function makeRepo() {
  const repo = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), 'nim-fingerprint-')));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture Author');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(repo, 'src.ts'), 'export const a = 1;\n');
  git(repo, 'add', 'src.ts');
  git(repo, 'commit', '-qm', 'initial');
  assert.equal(
    realpathSync(git(repo, 'rev-parse', '--show-toplevel').trim()),
    repo,
    'git resolved outside the scratch sandbox',
  );
  return repo;
}

test('a recorded run reads CURRENT until a real source edit, then STALE naming the file', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const recorded = computeTreeFingerprint(repo, ENV);
  assert.ok(recorded, 'expected a fingerprint for a real repository');

  // The whole point: an unchanged tree must prove itself unchanged, so the
  // reader never re-runs a multi-minute suite to learn what it already has.
  assert.equal(compareTreeFingerprint(recorded, repo, ENV).verdict, 'current');

  // The reporter's own output must not invalidate the run that produced it —
  // including in a monorepo, where the log lands under packages/<pkg>/ and a
  // root-anchored ignore rule would miss it entirely.
  for (const dir of ['.vitest', path.join('packages', 'collabv3', '.vitest')]) {
    mkdirSync(path.join(repo, dir), { recursive: true });
    writeFileSync(path.join(repo, dir, 'last-run.log'), 'result: FAIL\n');
    assert.equal(
      compareTreeFingerprint(recorded, repo, ENV).verdict,
      'current',
      `${dir} is the run log itself — it cannot count as a source change`,
    );
  }

  // A zipped-up local-only directory at the root is not a test input either,
  // and hashing one costs a full read of the archive on every fingerprint.
  writeFileSync(path.join(repo, 'nimbalyst-local.zip'), 'PK');
  assert.equal(compareTreeFingerprint(recorded, repo, ENV).verdict, 'current');

  writeFileSync(path.join(repo, 'src.ts'), 'export const a = 2;\n');
  const afterEdit = compareTreeFingerprint(recorded, repo, ENV);
  assert.equal(afterEdit.verdict, 'stale');
  assert.deepEqual(
    afterEdit.changed.map((c) => c.path),
    ['src.ts'],
  );

  // A committed edit moves HEAD and leaves the tree clean: the digest still has
  // to diverge, or committing would silently launder a stale run back to CURRENT.
  git(repo, 'commit', '-qam', 'change a');
  assert.equal(compareTreeFingerprint(recorded, repo, ENV).verdict, 'stale');

  // No fingerprint recorded is never "unchanged" — it is "cannot prove it".
  assert.equal(compareTreeFingerprint(null, repo, ENV).verdict, 'unknown');
});

test('an edit in a sibling checkout the suite tests reads as STALE', (t) => {
  // collabv3's integration tests alias `../../runtime/...` into the
  // stravu-editor checkout. If that source can change without moving the
  // digest, CURRENT becomes a lie in exactly the repo this was built for.
  const repo = makeRepo();
  const sibling = makeRepo();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  });

  const recorded = computeTreeFingerprint(repo, ENV, [sibling]);

  // The reader takes the sibling roots from the RECORD, not its own env. A
  // plain `test:last` process inherits nothing from the vitest config, so any
  // env dependency here would make every collabv3 run read STALE.
  assert.equal(compareTreeFingerprint(recorded, repo, ENV).verdict, 'current');

  writeFileSync(path.join(sibling, 'src.ts'), 'export const a = 99;\n');
  const afterSiblingEdit = compareTreeFingerprint(recorded, repo, ENV);
  assert.equal(afterSiblingEdit.verdict, 'stale');
  assert.deepEqual(
    afterSiblingEdit.changed.map((c) => c.change),
    ['sibling checkout changed since run'],
  );
});

test('toolchain changes invalidate the fingerprint and missing external inputs fail closed', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const current = computeTreeFingerprint(repo, ENV);
  for (const change of [{ nodeMajor: '999' }, { platform: 'other' }, { arch: 'other' }]) {
    const old = computeTreeFingerprint(repo, ENV, [], { ...current.toolchain, ...change });
    assert.equal(compareTreeFingerprint(old, repo, ENV).verdict, 'stale');
  }
  assert.equal(computeTreeFingerprint(repo, ENV, [path.join(repo, 'missing')]), null);
});

import { fullSuiteReuseDecision } from '../prepush-test-gate.mjs';
import { fullSuiteInvocation } from '../validation-inventory.mjs';

test('a real checkout reuses a full pass; source and lock edits made after it cannot reuse it', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const fingerprint = computeTreeFingerprint(repo, ENV);
  const record = { invocation: fullSuiteInvocation, complete: true, result: 'PASS', fingerprint };
  const decide = (value = record) => fullSuiteReuseDecision({ record: value, comparison: compareTreeFingerprint(value.fingerprint, repo, ENV),
    stdin: `refs/heads/main ${fingerprint.head} refs/heads/main ${'0'.repeat(40)}`, git: (...args) => git(repo, ...args), ci: 'false' });
  assert.equal(decide().reuse, true);
  writeFileSync(path.join(repo, 'package-lock.json'), '{}');
  assert.equal(decide().reuse, false);
  // A run that fingerprinted the dirty lockfile tested exactly this tree.
  assert.equal(decide({ ...record, fingerprint: computeTreeFingerprint(repo, ENV) }).reuse, true);
  rmSync(path.join(repo, 'package-lock.json'));
  writeFileSync(path.join(repo, 'src.ts'), 'changed');
  assert.equal(decide().reuse, false);
});
