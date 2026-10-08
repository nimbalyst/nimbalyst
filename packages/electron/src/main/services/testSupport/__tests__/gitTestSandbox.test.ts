// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import simpleGit from 'simple-git';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createScratchRepo, FIXTURE_AUTHOR, gitSandboxEnv, type ScratchRepo } from '../gitTestSandbox';

describe('gitSandboxEnv', () => {
  it('strips IDE-provided SSH_ASKPASS before simple-git runs a fixture command', async () => {
    const previousAskPass = process.env.SSH_ASKPASS;
    process.env.SSH_ASKPASS = '/mock/ide/askpass';
    try {
      const sandboxEnv = gitSandboxEnv(undefined, { pinConfigPaths: false });
      expect(sandboxEnv.SSH_ASKPASS).toBeUndefined();
      await expect(simpleGit(os.tmpdir()).env(sandboxEnv).raw(['--version'])).resolves.toMatch(/^git version /);
    } finally {
      if (previousAskPass === undefined) delete process.env.SSH_ASKPASS;
      else process.env.SSH_ASKPASS = previousAskPass;
    }
  });
});

describe('createScratchRepo', () => {
  let repo: ScratchRepo | undefined;
  let hostileDir: string | undefined;

  afterEach(() => {
    repo?.cleanup();
    if (hostileDir) fs.rmSync(hostileDir, { recursive: true, force: true });
    repo = undefined;
    hostileDir = undefined;
  });

  // The code under test inherits process.env, so it reads the developer's
  // global config. Only repo-local config can outrank it.
  it('overrides a hostile global config for git calls that do not use the sandbox env', () => {
    hostileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-hostile-gitconfig-'));
    const hooksDir = path.join(hostileDir, 'hooks');
    fs.mkdirSync(hooksDir);
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const excludesFile = path.join(hostileDir, 'ignore');
    fs.writeFileSync(excludesFile, 'hidden.txt\n');
    const hostileConfig = path.join(hostileDir, 'gitconfig');
    fs.writeFileSync(hostileConfig, [
      '[user]', '\tname = Hostile Person', '\temail = hostile@person.invalid',
      '[core]', `\thooksPath = ${hooksDir}`, `\texcludesFile = ${excludesFile}`,
      '[commit]', '\tgpgsign = true',
      '[tag]', '\tgpgsign = true',
      '[gpg]', '\tprogram = false',
      '',
    ].join('\n'));

    repo = createScratchRepo();
    const hostileEnv = { ...repo.env, GIT_CONFIG_GLOBAL: hostileConfig };
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo!.path, env: hostileEnv, encoding: 'utf8' });

    fs.writeFileSync(path.join(repo.path, 'hidden.txt'), 'x');
    expect(git('status', '--porcelain')).toContain('hidden.txt');

    git('add', 'hidden.txt');
    git('commit', '-q', '-m', 'first');
    expect(git('log', '-1', '--format=%an <%ae>').trim()).toBe(`${FIXTURE_AUTHOR.name} <${FIXTURE_AUTHOR.email}>`);

    git('tag', '-a', 'v1', '-m', 'v1');
    expect(git('tag', '--list').trim()).toBe('v1');
  });

  it('honors initialBranch and leaves an `at` folder for its owner to delete', () => {
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-scratch-at-'));
    try {
      repo = createScratchRepo({ at: owned, initialBranch: 'master' });
      expect(repo.git('symbolic-ref', '--short', 'HEAD').trim()).toBe('master');
      repo.cleanup();
      expect(fs.existsSync(path.join(owned, '.git'))).toBe(true);
    } finally {
      fs.rmSync(owned, { recursive: true, force: true });
    }
  });
});
