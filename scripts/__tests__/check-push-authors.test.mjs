import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { findForbiddenAuthors, parseGitLog } from '../check-push-authors.mjs';

const CHECK_SCRIPT = fileURLToPath(new URL('../check-push-authors.mjs', import.meta.url));

// Git exports repository-local GIT_* variables to hooks. If this test runs
// inside pre-push and inherits those variables, `cwd` alone is not an isolation
// boundary: scratch commits can mutate the repository that invoked the hook.
const SCRATCH_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: SCRATCH_ENV });
}

function commitAs(cwd, name, email, message) {
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
  assert.equal(realpathSync(git(repo, 'rev-parse', '--show-toplevel').trim()), realpathSync(repo));
  return repo;
}

test('flags the fixture identities from the 2026-07-22 incident', () => {
  const commits = parseGitLog(
    [
      'aaa\x1fTest User\x1ftest@example.com\x1fseed',
      'bbb\x1fTest\x1ftest@test\x1finit',
      'ccc\x1fGreg Hinkle\x1fgreghinkle@gmail.com\x1fRelease v0.70.3',
    ].join('\n'),
  );
  const offenders = findForbiddenAuthors(commits);
  assert.deepEqual(
    offenders.map((c) => c.sha),
    ['aaa', 'bbb'],
  );
});

test('CLI rejects a range containing a fixture-authored commit', (t) => {
  const repo = makeScratchRepo(t);
  commitAs(repo, 'Greg Hinkle', 'greghinkle@gmail.com', 'real work');
  commitAs(repo, 'Test User', 'test@example.com', 'seed');
  assert.throws(
    () => execFileSync(
      'node',
      [CHECK_SCRIPT, 'HEAD~1..HEAD'],
      { cwd: repo, encoding: 'utf8', env: SCRATCH_ENV },
    ),
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
  commitAs(repo, 'Greg Hinkle', 'greghinkle@gmail.com', 'first');
  commitAs(repo, 'Greg Hinkle', 'greghinkle@gmail.com', 'second');
  const stdout = execFileSync(
    'node',
    [CHECK_SCRIPT, 'HEAD~1..HEAD'],
    { cwd: repo, encoding: 'utf8', env: SCRATCH_ENV },
  );
  assert.match(stdout, /OK: no test-fixture authors/);
});
