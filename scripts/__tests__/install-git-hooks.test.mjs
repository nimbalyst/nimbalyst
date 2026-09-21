import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = fileURLToPath(new URL('../install-git-hooks.mjs', import.meta.url));

test('installs SSH keepalives for long hooks without replacing a custom transport', (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), 'nim-hook-install-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.GIT_CONFIG_GLOBAL = path.join(repo, 'global-config');
  env.GIT_CONFIG_SYSTEM = path.join(repo, 'missing-system-config');
  env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  assert.equal(realpathSync(git('rev-parse', '--show-toplevel')), realpathSync(repo));
  mkdirSync(path.join(repo, '.githooks'));
  const install = (extraEnv = {}) => execFileSync(process.execPath, [installer], { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  install();
  assert.equal(git('config', '--get', 'core.hooksPath'), '.githooks');
  const keepaliveCommand = git('config', '--get', 'core.sshCommand');
  assert.match(keepaliveCommand, /ServerAliveInterval=30/);
  install();
  assert.equal(git('config', '--get', 'core.sshCommand'), keepaliveCommand);

  git('config', 'core.sshCommand', 'custom-ssh --identity key');
  install();
  assert.equal(git('config', '--get', 'core.sshCommand'), 'custom-ssh --identity key');
  git('config', '--unset', 'core.sshCommand');
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[core]\n\tsshCommand = global-ssh\n');
  install();
  assert.equal(git('config', '--get', 'core.sshCommand'), 'global-ssh');
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');

  for (const extraEnv of [{ GIT_SSH: 'plink' }, { GIT_SSH_COMMAND: 'ssh -i key' }, { GIT_SSH_VARIANT: 'plink' }]) {
    install(extraEnv);
    assert.throws(() => git('config', '--local', '--get', 'core.sshCommand'));
  }
  git('config', 'ssh.variant', 'plink');
  install();
  assert.throws(() => git('config', '--local', '--get', 'core.sshCommand'));
});
