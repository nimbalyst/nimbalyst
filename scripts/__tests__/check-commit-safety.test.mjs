import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateStagedCommit, parseNameStatus } from '../check-commit-safety.mjs';
import { LARGE_COMMIT_FILE_LIMIT, SIZE_LIMIT_CONFIG_KEY } from '../commit-safety-policy.mjs';
import { assertInSandbox, commitFiles, makeScratchRepo, sandboxEnv, writeFile } from './helpers/gitSandbox.mjs';

const CHECK_SCRIPT = fileURLToPath(new URL('../check-commit-safety.mjs', import.meta.url));
const HOOKS_DIR = fileURLToPath(new URL('../../.githooks', import.meta.url));

function runCheck(repo, extraEnv = {}) {
  return execFileSync(process.execPath, [CHECK_SCRIPT], { cwd: repo, encoding: 'utf8', env: sandboxEnv(extraEnv) });
}

function expectRefusal(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, pattern);
    return true;
  });
}

// Seed a repo whose .gitignore mirrors the real one for the paths under test
// and whose hooks are the REAL .githooks directory, so the test exercises the
// shell wrapper and its `$(dirname "$0")` resolution, not just the script.
function seedRepo(t) {
  const { repo, git } = makeScratchRepo(t, 'nim-commit-safety-');
  writeFile(repo, '.gitignore', 'agent-mistakes.md\nnimbalyst-local/\n*.log\n');
  commitFiles(repo, git, 'seed', ['.gitignore', 'src/app.ts']);
  git(['config', 'core.hooksPath', HOOKS_DIR]);
  git(['config', SIZE_LIMIT_CONFIG_KEY, 'true']);
  return { repo, git };
}

function wideFiles(prefix) {
  return Array.from({ length: LARGE_COMMIT_FILE_LIMIT + 1 }, (_, i) => `${prefix}/f${i}.ts`);
}

test('parseNameStatus handles renames and plain entries', () => {
  const entries = parseNameStatus('A\0new.ts\0R100\0old.ts\0moved.ts\0M\0dir/x.ts\0');
  assert.deepEqual(entries, [
    { status: 'A', path: 'new.ts' },
    { status: 'R', path: 'moved.ts', from: 'old.ts' },
    { status: 'M', path: 'dir/x.ts' },
  ]);
});

test('evaluateStagedCommit flags forbidden paths, force-added ignored paths, and oversized commits', () => {
  const entries = [
    { status: 'A', path: 'nimbalyst-local/plans/x.md' },
    { status: 'M', path: '.claude/agent-mistakes.md' },
    { status: 'A', path: 'debug.log' },
    { status: 'M', path: 'tracked-fixture.log' },
    { status: 'D', path: 'nimbalyst-local/old.md' },
  ];
  const result = evaluateStagedCommit({ entries, ignoredAdded: ['debug.log'], env: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.forbidden.map(({ path }) => path), ['nimbalyst-local/plans/x.md', '.claude/agent-mistakes.md', 'debug.log']);

  const many = Array.from({ length: LARGE_COMMIT_FILE_LIMIT + 1 }, (_, i) => ({ status: 'A', path: `f${i}.ts` }));
  assert.equal(evaluateStagedCommit({ entries: many, ignoredAdded: [], env: {} }).tooLarge, true);
  assert.equal(evaluateStagedCommit({ entries: many, ignoredAdded: [], env: { NIMBALYST_LARGE_COMMIT: '1' } }).ok, true);
  assert.equal(evaluateStagedCommit({ entries: many, ignoredAdded: [], env: {}, sizeLimitEnforced: false }).ok, true);
  assert.equal(evaluateStagedCommit({ entries: many.slice(1), ignoredAdded: [], env: {} }).ok, true);
});

test('a contributor clone without the opt-in can merge a wide main into its branch but still cannot commit local-only paths', (t) => {
  const { repo, git } = seedRepo(t);
  git(['config', '--unset', SIZE_LIMIT_CONFIG_KEY]);
  git(['checkout', '-q', '-b', 'feat/thing']);
  commitFiles(repo, git, 'feature', ['src/feature.ts']);
  git(['checkout', '-q', 'main']);
  commitFiles(repo, git, 'main moved a lot', wideFiles('gen'));
  git(['checkout', '-q', 'feat/thing']);
  git(['merge', '-q', '--no-ff', '-m', 'Merge main into feat/thing', 'main']);
  assert.equal(git(['log', '-1', '--format=%s']).trim(), 'Merge main into feat/thing');

  writeFile(repo, 'nimbalyst-local/x.md');
  git(['add', '-f', 'nimbalyst-local/x.md']);
  expectRefusal(() => git(['commit', '-q', '-m', 'leak']), /nimbalyst-local\/x\.md/);
});

test('refuses force-added nimbalyst-local, agent-mistakes.md, and gitignored paths with a restore command', (t) => {
  const { repo, git } = seedRepo(t);
  writeFile(repo, 'nimbalyst-local/plans/secret plan.md');
  writeFile(repo, 'docs/agent-mistakes.md');
  writeFile(repo, 'build.log');
  writeFile(repo, 'src/ok.ts');
  git(['add', '-f', '--', 'nimbalyst-local/plans/secret plan.md', 'docs/agent-mistakes.md', 'build.log', 'src/ok.ts']);

  expectRefusal(() => runCheck(repo), /nimbalyst-local\/plans\/secret plan\.md/);
  expectRefusal(() => runCheck(repo), /docs\/agent-mistakes\.md/);
  expectRefusal(() => runCheck(repo), /build\.log {2}\(matches a \.gitignore rule/);
  expectRefusal(() => runCheck(repo), /git restore --staged -- docs\/agent-mistakes\.md 'nimbalyst-local\/plans\/secret plan\.md' build\.log/);
  expectRefusal(() => git(['commit', '-q', '-m', 'leak']), /refusing to commit/);

  git(['restore', '--staged', '--', 'nimbalyst-local/plans/secret plan.md', 'docs/agent-mistakes.md', 'build.log']);
  assert.equal(runCheck(repo), '');
  git(['commit', '-q', '-m', 'clean']);
  assert.equal(git(['log', '--format=%s', '-1']).trim(), 'clean');
});

test('unstaging a tracked agent-mistakes.md (a deletion) is allowed', (t) => {
  const { repo, git } = seedRepo(t);
  git(['config', 'core.hooksPath', '/nonexistent-hooks']);
  writeFile(repo, '.claude/agent-mistakes.md');
  git(['add', '-f', '--', '.claude/agent-mistakes.md']);
  git(['commit', '-q', '-m', 'legacy tracked log']);
  git(['config', 'core.hooksPath', HOOKS_DIR]);
  git(['rm', '-q', '--cached', '.claude/agent-mistakes.md']);
  assert.equal(runCheck(repo), '');
  git(['commit', '-q', '-m', 'stop tracking the log']);
});

test('an opted-in clone refuses a commit over the file limit unless NIMBALYST_LARGE_COMMIT=1', (t) => {
  const { repo, git } = seedRepo(t);
  const files = wideFiles('gen').map((file) => writeFile(repo, file));
  git(['add', '--', ...files]);
  expectRefusal(() => runCheck(repo), new RegExp(`touches ${LARGE_COMMIT_FILE_LIMIT + 1} files; the limit is ${LARGE_COMMIT_FILE_LIMIT}`));
  expectRefusal(() => git(['commit', '-q', '-m', 'huge']), /NIMBALYST_LARGE_COMMIT=1/);
  assert.equal(runCheck(repo, { NIMBALYST_LARGE_COMMIT: '1' }), '');
  git(['commit', '-q', '-m', 'huge but intended'], { env: sandboxEnv({ NIMBALYST_LARGE_COMMIT: '1' }) });
  assert.equal(git(['log', '--format=%s', '-1']).trim(), 'huge but intended');
});

test('a normal --no-ff merge passes while a merge that drags in nimbalyst-local or 2,800 files is refused', (t) => {
  const { repo, git } = seedRepo(t);
  assertInSandbox(repo, git);
  const mainTip = git(['rev-parse', 'HEAD']).trim();

  // A legitimate three-file PR branch merges cleanly through pre-merge-commit.
  git(['checkout', '-q', '-b', 'feature']);
  commitFiles(repo, git, 'feature work', ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  const featureTip = git(['rev-parse', 'HEAD']).trim();
  git(['checkout', '-q', 'main']);
  git(['merge', '--no-ff', '-q', '-m', 'Merge pull request #1 from ada/feature', featureTip]);
  assert.deepEqual(git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1), [mainTip, featureTip]);

  // The 2026-10-10 shape: a branch whose history force-added local files and a
  // wide sweep of generated files. The automatic merge commit is refused via
  // pre-merge-commit, and committing it by hand after --no-commit is refused
  // via pre-commit; both read the same index.
  git(['checkout', '-q', '-b', 'poisoned']);
  git(['config', 'core.hooksPath', '/nonexistent-hooks']);
  commitFiles(repo, git, 'leak local files', ['nimbalyst-local/CURRENT_FOCUS.md'], { force: true });
  git(['config', 'core.hooksPath', HOOKS_DIR]);
  git(['checkout', '-q', 'main']);
  const cleanTip = git(['rev-parse', 'HEAD']).trim();
  expectRefusal(() => git(['merge', '--no-ff', '-q', '-m', 'bad merge', 'poisoned']), /nimbalyst-local\/CURRENT_FOCUS\.md/);
  // Git leaves the refused merge in progress for inspection; main must not have moved.
  assert.equal(git(['rev-parse', 'HEAD']).trim(), cleanTip);
  git(['merge', '--abort']);

  git(['merge', '--no-ff', '--no-commit', '-q', 'poisoned'], { stdio: 'ignore' });
  expectRefusal(() => git(['commit', '-q', '-m', 'bad merge by hand']), /This is a merge/);
  git(['merge', '--abort']);
  assert.equal(git(['log', '--format=%s', '-1']).trim(), 'Merge pull request #1 from ada/feature');
});

test('the commit hooks run the shared script and let a commit through when node is missing', { skip: process.platform === 'win32' }, (t) => {
  for (const hook of ['pre-commit', 'pre-merge-commit']) {
    assert.match(readFileSync(path.join(HOOKS_DIR, hook), 'utf8'), /scripts\/check-commit-safety\.mjs/);
  }
  // A GUI git client without node on PATH must still be able to commit;
  // pre-push re-applies the policy before anything leaves the machine.
  const { repo, git } = seedRepo(t);
  writeFile(repo, 'nimbalyst-local/x.md');
  git(['add', '-f', 'nimbalyst-local/x.md']);
  for (const hook of ['pre-commit', 'pre-merge-commit']) {
    const output = execFileSync('/bin/sh', [path.join(HOOKS_DIR, hook)], { cwd: repo, encoding: 'utf8', env: sandboxEnv({ PATH: '/nonexistent-bin' }) });
    assert.match(output, /WARNING: node is not on PATH/);
  }
});
