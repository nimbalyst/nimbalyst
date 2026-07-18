import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  shouldExcludeKnownFailingSuites,
  buildVitestArgs,
  buildVitestEnv,
  sanitizeGitLocalEnv,
} from '../prepush-test-gate.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function gitLocalEnvVars() {
  return execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

function gitIndependentEnv(env = process.env) {
  const independent = { ...env };
  for (const name of gitLocalEnvVars()) delete independent[name];
  for (const name of Object.keys(independent)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete independent[name];
  }
  return independent;
}

function git(args, cwd, env) {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function snapshotRepository(cwd, env) {
  return {
    head: git(['rev-parse', 'HEAD'], cwd, env),
    tree: git(['rev-parse', 'HEAD^{tree}'], cwd, env),
    index: git(['ls-files', '--stage', '-z'], cwd, env),
    status: git(['status', '--porcelain=v2', '--untracked-files=all', '-z'], cwd, env),
    diff: git(['diff', '--binary'], cwd, env),
    refs: git(
      ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/fixture/isolation', 'refs/heads/fixture/worktree'],
      cwd,
      env,
    ),
    config: git(['config', '--local', '--null', '--list'], cwd, env),
    worktrees: git(['worktree', 'list', '--porcelain'], cwd, env),
  };
}

test('runs the full suite (no exclusions) outside local Windows', () => {
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'linux' }), false);
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'darwin' }), false);
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'win32', ci: 'true' }), false);
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'win32', ci: '1' }), false);
});

test('excludes only the known-failing suites on local Windows', () => {
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'win32' }), true);
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'win32', ci: 'false' }), true);
});

test('buildVitestArgs adds no --exclude flags outside local Windows', () => {
  const args = buildVitestArgs({ platform: 'linux' });
  assert.deepEqual(args, ['vitest', '--run']);
});

test('buildVitestArgs caps worker concurrency on local Windows', () => {
  const args = buildVitestArgs({ platform: 'win32' });
  const idx = args.indexOf('--maxWorkers');
  assert.ok(idx >= 0, 'missing --maxWorkers flag');
  assert.equal(args[idx + 1], '4');
});

test('buildVitestArgs adds no --maxWorkers flag outside local Windows', () => {
  const args = buildVitestArgs({ platform: 'linux' });
  assert.equal(args.includes('--maxWorkers'), false);
});

test('buildVitestArgs never uses --exclude (vitest CLI --exclude does not reach test.projects file discovery)', () => {
  assert.equal(buildVitestArgs({ platform: 'win32' }).includes('--exclude'), false);
  assert.equal(buildVitestArgs({ platform: 'linux' }).includes('--exclude'), false);
});

test('buildVitestEnv sets NIMBALYST_PREPUSH_GATE on local Windows', () => {
  assert.equal(buildVitestEnv({ platform: 'win32' }).NIMBALYST_PREPUSH_GATE, '1');
});

test('buildVitestEnv sets nothing outside local Windows', () => {
  assert.deepEqual(buildVitestEnv({ platform: 'linux' }), {});
  assert.deepEqual(buildVitestEnv({ platform: 'win32', ci: 'true' }), {});
});

test('sanitizeGitLocalEnv removes every Git-local key and numbered config companion', () => {
  const poisoned = {
    PATH: process.env.PATH,
    HOME: 'keep-home',
    CUSTOM_VALUE: 'keep-custom',
    GIT_AUTHOR_NAME: 'Keep Author',
    GIT_SSH_COMMAND: 'keep-ssh-command',
    GIT_CONFIG_GLOBAL: 'keep-global-config',
    NIMBALYST_PREPUSH_GATE: '1',
  };
  for (const name of gitLocalEnvVars()) poisoned[name] = `poisoned-${name}`;
  poisoned.GIT_CONFIG_COUNT = '2';
  poisoned.GIT_CONFIG_KEY_0 = 'user.name';
  poisoned.GIT_CONFIG_VALUE_0 = 'Poisoned User';
  poisoned.GIT_CONFIG_KEY_1 = 'user.email';
  poisoned.GIT_CONFIG_VALUE_1 = 'poisoned@example.com';
  poisoned.GIT_CONFIG_KEY_999 = 'stale.key';
  poisoned.GIT_CONFIG_VALUE_999 = 'stale-value';
  const original = { ...poisoned };

  const sanitized = sanitizeGitLocalEnv(poisoned);

  for (const name of gitLocalEnvVars()) {
    assert.equal(Object.hasOwn(sanitized, name), false, `Git-local key leaked: ${name}`);
  }
  for (const name of Object.keys(sanitized)) {
    assert.equal(
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name),
      false,
      `numbered Git config companion leaked: ${name}`,
    );
  }
  assert.equal(sanitized.HOME, 'keep-home');
  assert.equal(sanitized.CUSTOM_VALUE, 'keep-custom');
  assert.equal(sanitized.GIT_AUTHOR_NAME, 'Keep Author');
  assert.equal(sanitized.GIT_SSH_COMMAND, 'keep-ssh-command');
  assert.equal(sanitized.GIT_CONFIG_GLOBAL, 'keep-global-config');
  assert.equal(sanitized.NIMBALYST_PREPUSH_GATE, '1');
  assert.deepEqual(poisoned, original, 'sanitizer mutated its input');
});

test('sanitized child Git actions cannot corrupt a poisoned parent repository', async () => {
  const tempBase = path.join(repoRoot, '.tmp');
  await fs.mkdir(tempBase, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(tempBase, 'prepush-git-env-'));
  assert.equal(path.parse(tempRoot).root.toLowerCase(), path.parse(repoRoot).root.toLowerCase());

  const parentRepo = path.join(tempRoot, 'parent-audit-repo');
  const fixtureRepo = path.join(tempRoot, 'fixture-repo');
  const fixtureWorktree = path.join(tempRoot, 'fixture-worktree');
  const cleanEnv = gitIndependentEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0' });

  try {
    await fs.mkdir(parentRepo);
    await fs.mkdir(fixtureRepo);
    for (const repo of [parentRepo, fixtureRepo]) {
      git(['init', '-q'], repo, cleanEnv);
      git(['config', 'user.name', 'Prepush Isolation Test'], repo, cleanEnv);
      git(['config', 'user.email', 'prepush-isolation@example.com'], repo, cleanEnv);
      git(['config', 'commit.gpgsign', 'false'], repo, cleanEnv);
      await fs.writeFile(path.join(repo, 'fixture.txt'), `${path.basename(repo)} baseline\n`);
      git(['add', '--', 'fixture.txt'], repo, cleanEnv);
      git(['commit', '-q', '-m', 'seed'], repo, cleanEnv);
    }

    await fs.writeFile(path.join(parentRepo, 'fixture.txt'), 'parent pending change\n');
    await fs.writeFile(path.join(fixtureRepo, 'fixture.txt'), 'fixture committed change\n');
    const parentBefore = snapshotRepository(parentRepo, cleanEnv);
    const fixtureHeadBefore = git(['rev-parse', 'HEAD'], fixtureRepo, cleanEnv);

    const poisonedEnv = {
      ...cleanEnv,
      GIT_DIR: path.join(parentRepo, '.git'),
      GIT_COMMON_DIR: path.join(parentRepo, '.git'),
      GIT_WORK_TREE: parentRepo,
      GIT_INDEX_FILE: path.join(parentRepo, '.git', 'index'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'prepush.poisoned',
      GIT_CONFIG_VALUE_0: 'true',
      NIMBALYST_PREPUSH_GATE: '1',
    };
    const childEnv = sanitizeGitLocalEnv(poisonedEnv);

    git(['add', '--', 'fixture.txt'], fixtureRepo, childEnv);
    git(['commit', '-q', '-m', 'fixture commit'], fixtureRepo, childEnv);
    git(['branch', 'fixture/isolation'], fixtureRepo, childEnv);
    git(['config', 'prepush.fixture', 'isolated'], fixtureRepo, childEnv);
    git(['worktree', 'add', '-q', '-b', 'fixture/worktree', fixtureWorktree], fixtureRepo, childEnv);

    const parentAfter = snapshotRepository(parentRepo, cleanEnv);
    assert.deepEqual(parentAfter, parentBefore, 'poisoned child action changed the parent audit repository');

    const fixtureHeadAfter = git(['rev-parse', 'HEAD'], fixtureRepo, cleanEnv);
    assert.notEqual(fixtureHeadAfter, fixtureHeadBefore);
    assert.equal(git(['log', '-1', '--format=%s'], fixtureRepo, cleanEnv), 'fixture commit\n');
    assert.equal(git(['show', 'HEAD:fixture.txt'], fixtureRepo, cleanEnv), 'fixture committed change\n');
    assert.match(
      git(
        ['for-each-ref', '--format=%(refname)', 'refs/heads/fixture/isolation', 'refs/heads/fixture/worktree'],
        fixtureRepo,
        cleanEnv,
      ),
      /refs\/heads\/fixture\/isolation[\s\S]*refs\/heads\/fixture\/worktree/,
    );
    assert.match(git(['config', '--local', '--list'], fixtureRepo, cleanEnv), /prepush\.fixture=isolated/);
    assert.match(git(['worktree', 'list', '--porcelain'], fixtureRepo, cleanEnv), /fixture-worktree/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
