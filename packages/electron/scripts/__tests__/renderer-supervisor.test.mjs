import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { RendererSupervisor, probeRenderer } from '../renderer-supervisor.mjs';

function harness(t, probe = async () => true) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const children = [];
  const logs = [];
  const supervisor = new RendererSupervisor({
    spawnRenderer: () => {
      const child = new EventEmitter();
      child.pid = children.length + 100;
      child.signals = [];
      child.kill = (signal) => child.signals.push(signal);
      children.push(child);
      return child;
    },
    probe,
    log: (message) => logs.push(message),
    intervalMs: 100,
    startupMs: 500,
    killGraceMs: 50,
    stableMs: 1000,
    retryMs: 10,
    maxRetryMs: 40,
  });
  supervisor.start();
  t.after(() => { supervisor.stop(); });
  return { supervisor, children, logs, tick: async (ms) => {
    t.mock.timers.tick(ms);
    await Promise.resolve();
    await Promise.resolve();
  } };
}

test('restarts a crashed renderer without needing an Electron exit', async (t) => {
  const h = harness(t);
  h.children[0].emit('exit', null, 'SIGABRT');
  await h.tick(10);
  assert.equal(h.children.length, 2);
  assert.match(h.logs.join('\n'), /SIGABRT/);
});

test('backs off repeated crashes with a cap, resets after sustained health', async (t) => {
  const h = harness(t);
  for (const delay of [10, 20, 40, 40]) {
    h.children.at(-1).emit('exit', 1, null);
    const count = h.children.length;
    await h.tick(delay - 1);
    assert.equal(h.children.length, count);
    await h.tick(1);
    assert.equal(h.children.length, count + 1);
  }
  h.children.at(-1).emit('message', { type: 'ready' });
  for (let i = 0; i < 11; i++) await h.tick(100);
  h.children.at(-1).emit('exit', 1, null);
  const count = h.children.length;
  await h.tick(10);
  assert.equal(h.children.length, count + 1);
});

test('requires consecutive failed probes and waits for exit before replacing a hang', async (t) => {
  let healthy = false;
  const h = harness(t, async () => healthy);
  const child = h.children[0];
  child.emit('message', { type: 'ready' });
  await h.tick(100);
  await h.tick(100);
  healthy = true;
  await h.tick(100);
  healthy = false;
  await h.tick(100);
  await h.tick(100);
  assert.deepEqual(child.signals, []);
  await h.tick(100);
  assert.deepEqual(child.signals, ['SIGTERM']);
  await h.tick(50);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(h.children.length, 1);
  child.emit('exit', null, 'SIGKILL');
  await h.tick(10);
  assert.equal(h.children.length, 2);
});

test('bounds startup even when the renderer never reports ready', async (t) => {
  const h = harness(t);
  await h.tick(499);
  assert.deepEqual(h.children[0].signals, []);
  await h.tick(1);
  assert.deepEqual(h.children[0].signals, ['SIGTERM']);
});

test('ignores late health results from an exited renderer', async (t) => {
  let finish;
  const h = harness(t, () => new Promise((resolve) => { finish = resolve; }));
  h.children[0].emit('message', { type: 'ready' });
  await h.tick(100);
  h.children[0].emit('exit', 1, null);
  await h.tick(10);
  finish(false);
  await h.tick(0);
  assert.deepEqual(h.children[1].signals, []);
});

test('shutdown cancels retries and kills an unresponsive child without respawning', async (t) => {
  const h = harness(t);
  const stopped = h.supervisor.stop();
  assert.deepEqual(h.children[0].signals, ['SIGTERM']);
  await h.tick(50);
  assert.deepEqual(h.children[0].signals, ['SIGTERM', 'SIGKILL']);
  h.children[0].emit('exit', null, 'SIGKILL');
  await stopped;
  await h.tick(1000);
  assert.equal(h.children.length, 1);
});

test('shutdown during backoff prevents another spawn', async (t) => {
  const h = harness(t);
  h.children[0].emit('exit', 1, null);
  await h.supervisor.stop();
  await h.tick(1000);
  assert.equal(h.children.length, 1);
});

test('spawn errors retry rather than leaving the supervisor idle', async (t) => {
  const h = harness(t);
  h.children[0].pid = undefined;
  h.children[0].emit('error', new Error('spawn failed'));
  await h.tick(10);
  assert.equal(h.children.length, 2);
});

test('a live child error does not release its PID or start a second server', async (t) => {
  const h = harness(t);
  h.children[0].emit('error', new Error('kill failed'));
  await h.tick(10);
  assert.equal(h.children.length, 1);
});

test('HTTP probes reject error responses and time out stalled requests', async (t) => {
  let mode = 'healthy';
  const server = createServer((_request, response) => {
    if (mode === 'hang') return;
    response.writeHead(mode === 'healthy' ? 200 : 503).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  assert.equal(await probeRenderer(url), true);
  mode = 'error';
  assert.equal(await probeRenderer(url), false);
  mode = 'hang';
  assert.equal(await probeRenderer(url, 50), false);
});

test('real child crash recovers HTTP on the same port and shutdown releases it', async (t) => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const children = [];
  const messages = [];
  let readyCount = 0;
  const supervisor = new RendererSupervisor({
    spawnRenderer: () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { createServer } from 'node:http';
        createServer((_req, res) => res.end('ok')).listen(${port}, '127.0.0.1', () => {
          process.send({ type: 'ready' });
        });
      `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      children.push(child);
      return child;
    },
    probe: () => probeRenderer(`http://127.0.0.1:${port}/`, 100),
    onReady: (ready) => { if (ready) readyCount++; },
    log: (message) => messages.push(message),
    retryMs: 10,
    killGraceMs: 100,
  });
  t.after(() => supervisor.stop());
  const waitUntil = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, messages.join('\n'));
      await delay(10);
    }
  };
  supervisor.start();
  await waitUntil(() => readyCount === 1);
  assert.equal(await probeRenderer(`http://127.0.0.1:${port}/`), true);
  children[0].kill('SIGKILL');
  await waitUntil(() => readyCount === 2);
  assert.notEqual(children[0].pid, children[1].pid);
  assert.equal(await probeRenderer(`http://127.0.0.1:${port}/`), true);
  await supervisor.stop();
  assert.equal(await probeRenderer(`http://127.0.0.1:${port}/`, 100), false);
  assert.equal(children.length, 2);
});

test('dev loop recovers Vite while app runs, keeps Vite across app restarts, and cleans up', {
  skip: process.platform === 'win32', // Windows uses dev-user2.mjs, not the Bash dev loop.
}, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'renderer-supervisor-test-'));
  const scripts = path.join(dir, 'scripts');
  await mkdir(scripts);
  for (const name of ['dev-loop.sh', 'renderer-supervisor.mjs']) {
    await copyFile(new URL(`../${name}`, import.meta.url), path.join(scripts, name));
  }
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  await writeFile(path.join(scripts, 'renderer-dev-server.mjs'), `
    import { createServer } from 'node:http';
    import { writeFileSync } from 'node:fs';
    const server = createServer((_req, res) => res.end('ok'));
    server.listen(Number(process.env.VITE_PORT), () => {
      writeFileSync('renderer.pid', String(process.pid));
      process.send?.({ type: 'ready' });
    });
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    process.on('disconnect', () => process.exit(0));
  `);
  await writeFile(path.join(scripts, 'dev.sh'), `#!/bin/bash
echo run >> app-runs
while [ ! -f app-exit ]; do sleep 0.05; done
rm app-exit
`);
  await chmod(path.join(scripts, 'dev.sh'), 0o755);
  const child = spawn('bash', [path.join(scripts, 'dev-loop.sh')], {
    env: { ...process.env, VITE_PORT: String(port), NIMBALYST_USER_DATA_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const contents = async (name) => readFile(path.join(dir, name), 'utf8').catch(() => '');
  const waitUntil = async (predicate) => {
    const deadline = Date.now() + 10_000;
    while (!await predicate()) {
      assert.ok(Date.now() < deadline, output);
      await delay(25);
    }
  };
  t.after(async () => {
    if (child.exitCode === null) {
      await rm(path.join(dir, '.restart-requested'), { force: true });
      await writeFile(path.join(dir, 'app-exit'), '');
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  });
  await waitUntil(async () => (await contents('app-runs')) === 'run\n');
  const firstPid = Number(await contents('renderer.pid'));
  process.kill(firstPid, 'SIGKILL');
  await waitUntil(async () => Number(await contents('renderer.pid')) !== firstPid);
  const recoveredPid = Number(await contents('renderer.pid'));
  assert.equal(await contents('app-runs'), 'run\n');
  assert.equal(await probeRenderer(`http://localhost:${port}/`), true);
  await writeFile(path.join(dir, '.restart-requested'), '');
  await writeFile(path.join(dir, 'app-exit'), '');
  await waitUntil(async () => (await contents('app-runs')) === 'run\nrun\n');
  assert.equal(Number(await contents('renderer.pid')), recoveredPid);
  await writeFile(path.join(dir, 'app-exit'), '');
  assert.equal(await exited, 0);
  assert.equal(await probeRenderer(`http://localhost:${port}/`, 100), false);
});
