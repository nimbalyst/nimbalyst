import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { findForbiddenAuthors, parseGitLog } from '../check-push-authors.mjs';

const CHECK_SCRIPT = fileURLToPath(new URL('../check-push-authors.mjs', import.meta.url));

// Fixtures NEVER borrow a real contributor's identity. A commit that escapes
// the sandbox carrying a maintainer's name/email is invisible to this very
// guard (the denylist has to let real authors through) and lands on GitHub as
// an unverified commit attributed to a person who never wrote it — which is
// what happened to PR #973 on 2026-07-24.
const VALID_AUTHOR = { name: 'Ada Contributor', email: 'ada@nimbalyst.dev' };

// Git hooks export GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE pointing at the
// REAL checkout, and those override `cwd`. A pre-push hook running this suite
// would otherwise commit its fixtures straight onto the developer's live
// branch. Strip every GIT_* var, pin config resolution to a file that does not
// exist, and stop repo discovery from walking above the temp dir.
function sandboxEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  const missingConfig = path.join(tmpdir(), 'nim-check-push-authors-absent-gitconfig');
  env.GIT_CONFIG_GLOBAL = missingConfig;
  env.GIT_CONFIG_SYSTEM = missingConfig;
  env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
  return env;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: sandboxEnv() });
}

// Re-checked before EVERY mutating call, not just at init: the point of failure
// is a hijacked repo resolution, and that can only be observed at the moment
// git actually runs.
function assertInSandbox(repo) {
  assert.equal(
    realpathSync(git(repo, 'rev-parse', '--show-toplevel').trim()),
    realpathSync(repo),
    'git resolved a repository outside the scratch sandbox — refusing to commit',
  );
}

function commitAs(cwd, { name, email }, message) {
  assertInSandbox(cwd);
  writeFileSync(path.join(cwd, `${message.replace(/\W+/g, '-')}.txt`), `${message}\n`);
  git(cwd, 'add', '-A');
  git(
    cwd,
    '-c', `user.name=${name}`,
    '-c', `user.email=${email}`,
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', message,
  );
}

// Scratch repos live under os.tmpdir() ONLY, and every run asserts git actually
// resolved the sandbox — never the enclosing checkout — before mutating anything.
function makeScratchRepo(t) {
  const repo = mkdtempSync(path.join(tmpdir(), 'nim-check-push-authors-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q');
  assertInSandbox(repo);
  return repo;
}

test('flags the fixture identities from the 2026-07-22 incident', () => {
  const commits = parseGitLog(
    [
      'aaa\x1fTest User\x1ftest@example.com\x1fseed',
      'bbb\x1fTest\x1ftest@test\x1finit',
      'ccc\x1fNIM-367 Gate Author\x1fnimbalyst@example.com\x1fgate fixture',
      'ddd\x1fAda Contributor\x1fada@nimbalyst.dev\x1fRelease v0.70.3',
    ].join('\n'),
  );
  const offenders = findForbiddenAuthors(commits);
  assert.deepEqual(
    offenders.map((c) => c.sha),
    ['aaa', 'bbb', 'ccc'],
  );
});

test('flags synthetic fixture domains that are not example.com', () => {
  const commits = parseGitLog(
    [
      'aaa\x1fSome Fixture\x1fsomeone@nimbalyst.test\x1fseed',
      'bbb\x1fSome Fixture\x1fsomeone@nimbalyst.invalid\x1fseed',
      'ccc\x1fFixture Bot\x1ffixture-valid@nimbalyst.dev\x1fseed',
    ].join('\n'),
  );
  assert.deepEqual(
    findForbiddenAuthors(commits).map((c) => c.sha),
    ['aaa', 'bbb', 'ccc'],
  );
});

test('CLI rejects a range containing a fixture-authored commit', (t) => {
  const repo = makeScratchRepo(t);
  commitAs(repo, VALID_AUTHOR, 'real work');
  commitAs(repo, { name: 'Test User', email: 'test@example.com' }, 'seed');
  assert.throws(
    () => execFileSync('node', [CHECK_SCRIPT, 'HEAD~1..HEAD'], {
      cwd: repo,
      encoding: 'utf8',
      env: sandboxEnv(),
    }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /test-fixture authors/);
      assert.match(error.stderr, /Test User <test@example\.com> seed/);
      return true;
    },
  );
});

test('CLI passes a range of real commits', (t) => {
  const repo = makeScratchRepo(t);
  commitAs(repo, VALID_AUTHOR, 'first');
  commitAs(repo, VALID_AUTHOR, 'second');
  const stdout = execFileSync('node', [CHECK_SCRIPT, 'HEAD~1..HEAD'], {
    cwd: repo,
    encoding: 'utf8',
    env: sandboxEnv(),
  });
  assert.match(stdout, /OK: no test-fixture authors/);
});

// Regression test for the 2026-07-24 escape: with GIT_DIR inherited from a
// pre-push hook, fixture commits landed in the hook's repository instead of
// the scratch sandbox. Stand in a decoy repo for "the developer's checkout"
// and prove the fixture cannot reach it.
test('fixture commits ignore an inherited GIT_DIR and stay in the sandbox', (t) => {
  const sandbox = makeScratchRepo(t);
  const decoy = makeScratchRepo(t);
  commitAs(decoy, VALID_AUTHOR, 'decoy baseline');

  const previousGitDir = process.env.GIT_DIR;
  const previousIndex = process.env.GIT_INDEX_FILE;
  process.env.GIT_DIR = path.join(decoy, '.git');
  process.env.GIT_INDEX_FILE = path.join(decoy, '.git', 'index');
  t.after(() => {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
  });

  commitAs(sandbox, { name: 'Test User', email: 'test@example.com' }, 'seed');

  assert.match(git(sandbox, 'log', '--format=%s').trim(), /^seed$/);
  assert.equal(git(decoy, 'log', '--format=%s').trim(), 'decoy baseline');
});
