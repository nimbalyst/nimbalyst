// Native diagnostic only: node codex-windows-filesystem.mjs <packaged-codex.exe>
// Exercises the host filesystem RPC's no-follow path, not model apply_patch or sandbox execution.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

assert.equal(process.platform, 'win32', 'Run this fixture on native Windows.');
const binary = process.argv[2];
assert.ok(binary, 'Supply the packaged Codex executable path.');
const root = await mkdtemp(path.join(os.tmpdir(), 'nimbalyst-codex-1544-'));
const physical = path.join(root, 'physical');
const repo = path.join(physical, 'repo');
const worktree = path.join(physical, 'worktree');
const codexHome = path.join(root, 'codex-home');
await Promise.all([physical, codexHome].map(p => mkdir(p)));
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', repo);
assert.equal((await realpath(git('-C', repo, 'rev-parse', '--show-toplevel').trim())).toLowerCase(), (await realpath(repo)).toLowerCase());
git('-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'Fixture');
git('-C', repo, 'worktree', 'add', '-b', 'fixture', worktree);
await symlink(physical, path.join(root, 'alias'), 'junction');
await symlink(repo, path.join(worktree, 'inner'), 'junction');
const child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd: repo, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.resume();
let nextId = 1;
const pending = new Map();
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  let response;
  try { response = JSON.parse(line); } catch { return; }
  const waiter = pending.get(response.id);
  if (!waiter) return;
  pending.delete(response.id);
  clearTimeout(waiter.timer);
  if (response.error) waiter.reject(new Error(response.error.message));
  else waiter.resolve(response.result);
});
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timed out: ' + method)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
try {
  console.log(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim());
  await request('initialize', { clientInfo: { name: 'nimbalyst-windows-fixture', version: '1' } });
  child.stdin.write('{"method":"initialized"}\n');
  const thread = await request('thread/start', { cwd: worktree, sandbox: 'workspace-write', approvalPolicy: 'never', ephemeral: true });
  console.log(JSON.stringify({ requested: 'workspace-write', effective: thread.sandbox, cwd: worktree }));
  for (const [label, directory, junction] of [
    ['ordinary checkout', repo, false], ['ordinary worktree', worktree, false],
    ['junction ancestor', path.join(root, 'alias', 'worktree'), true], ['junction inside worktree', path.join(worktree, 'inner'), true],
  ]) {
    const target = path.join(directory, 'native-fixture.txt');
    const write = () => request('fs/writeFile', { path: target, dataBase64: Buffer.from('fixture').toString('base64') });
    let result = 'create/read/delete passed';
    try {
      await write();
      assert.equal(Buffer.from((await request('fs/readFile', { path: target })).dataBase64, 'base64').toString(), 'fixture');
      await request('fs/remove', { path: target });
    } catch (error) {
      if (!junction || !/reparse point/i.test(String(error))) throw error;
      result = 'reparse point rejected';
    }
    console.log(JSON.stringify({ label, target, result }));
  }
} finally {
  lines.close();
  const exited = new Promise(resolve => child.once('close', resolve));
  child.kill();
  await exited;
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  await rm(root, { recursive: true, force: true });
}
