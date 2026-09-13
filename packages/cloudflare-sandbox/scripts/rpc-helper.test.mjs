import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runManagerRPC, controlFailure } from './rpc-helper.mjs';

test('private control uses explicit config, confirms stop, and disposes after RPC failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nimbalyst-rpc-helper-'));
  const configPath = join(dir, 'wrangler.json');
  let opened = 0;
  let disposed = 0;
  const calls = [];
  try {
    await writeFile(configPath, JSON.stringify({
      account_id: 'a'.repeat(32), compatibility_date: '2026-09-09',
      services: [{ binding: 'Manager', service: 'nimbalyst-sandbox-test', entrypoint: 'SandboxManager', remote: true }],
    }));
    const createProxy = async options => {
      opened++;
      assert.deepEqual(options, { configPath, persist: false, envFiles: [], remoteBindings: true });
      // With remote bindings, Wrangler returns RPC results as Miniflare stubs
      // that are poisoned once the proxy is disposed. Model that: any property
      // read after dispose throws, exactly as the real stub does.
      let poisoned = false;
      const stub = data => new Proxy(data, {
        get(target, key) {
          if (poisoned) throw new Error('Attempted to use poisoned stub.');
          return target[key];
        },
        ownKeys(target) {
          if (poisoned) throw new Error('Attempted to use poisoned stub.');
          return Reflect.ownKeys(target);
        },
      });
      return {
        env: { Manager: {
          status: async () => stub({ state: 'stopped', lastChangedAt: 1 }),
          provision: async request => { calls.push(request); return stub({ node: { running: false } }); },
          startNode: async request => { calls.push(request); return stub({ node: { running: true } }); },
          nodeStatus: async () => stub({ node: { running: true } }),
          stopNode: async request => { calls.push(request); return stub({ node: { running: false } }); },
          stop: async request => { calls.push(request); throw new Error('RPC failed'); },
        } },
        dispose: async () => { disposed++; poisoned = true; },
      };
    };
    await assert.rejects(runManagerRPC({ configPath, operation: 'stop' }, createProxy), /confirmation/);
    assert.equal(opened, 0);
    // deepEqual reads the fields after the helper has disposed the proxy.
    assert.deepEqual(await runManagerRPC({ configPath, operation: 'status' }, createProxy), { state: 'stopped', lastChangedAt: 1 });
    await assert.rejects(runManagerRPC({ configPath, operation: 'stop', discardEphemeralData: true }, createProxy), /RPC failed/);
    assert.deepEqual(calls, [{ discardEphemeralData: true }]);
    assert.equal(disposed, 2);
    const provision = { files: [{ path: '/home/nimbalyst/config', content: 'secret' }], allowedHosts: ['github.com'] };
    for (const [operation, request, running] of [
      ['provision', provision, false],
      ['startNode', { configPath: '/home/nimbalyst/config' }, true],
      ['nodeStatus', undefined, true],
      ['stopNode', { discardEphemeralData: true }, false],
    ]) {
      assert.deepEqual(await runManagerRPC({ configPath, operation, request }, createProxy), { node: { running } });
    }
    assert.deepEqual(calls.slice(1), [provision, { configPath: '/home/nimbalyst/config' }, { discardEphemeralData: true }]);
    await assert.rejects(runManagerRPC({ configPath, operation: 'stopNode', request: {} }, createProxy), /confirmation/);
    assert.equal(disposed, 6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('child protocol suppresses Wrangler diagnostics without breaking write callbacks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nimbalyst-rpc-protocol-'));
  try {
    const configPath = join(dir, 'wrangler.json');
    const wranglerModulePath = join(dir, 'wrangler-fixture.mjs');
    await writeFile(configPath, JSON.stringify({
      account_id: 'a'.repeat(32), compatibility_date: '2026-09-09',
      services: [{ binding: 'Manager', service: 'nimbalyst-sandbox-test', entrypoint: 'SandboxManager', remote: true }],
    }));
    await writeFile(wranglerModulePath, `
      await new Promise(resolve => process.stdout.write('synthetic-auth-secret', resolve));
      console.error('synthetic-diagnostic-secret');
      export async function getPlatformProxy() {
        return { env: { Manager: { provision: async request => {
          if (request.files[0].content.length !== 100000) throw new Error('wrong input');
          console.log(request.files[0].content);
          return { state: 'stopped' };
        } } }, dispose: async () => {} };
      }
    `);
    const child = execFile(process.execPath, [fileURLToPath(new URL('./rpc-helper.mjs', import.meta.url))], { timeout: 5000 });
    const result = new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    child.stdin.end(JSON.stringify({ configPath, wranglerModulePath, operation: 'provision', request: { files: [{ path: '/home/nimbalyst/config', content: 's'.repeat(100000) }], allowedHosts: [] } }));
    const output = await result;
    assert.equal(output.code, 0);
    assert.deepEqual(JSON.parse(output.stdout), { success: true, data: { state: 'stopped' } });
    assert.equal(output.stderr, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('node failure frames retain only fixed reasons', () => {
  for (const reason of ['invalid-path', 'node-start-failed', 'node-not-provisioned', 'grant-failed']) {
    assert.deepEqual(controlFailure(new Error(reason)), { success: false, error: reason === 'invalid-path' ? 'unknown' : reason, reason });
  }
  assert.deepEqual(controlFailure(new Error('credentials: synthetic-secret')), { success: false, error: 'container-unavailable', reason: 'rpc-failed' });
});

test('child failures distinguish expired SSO, missing consent, and invalid config without diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nimbalyst-rpc-failures-'));
  try {
    const configPath = join(dir, 'wrangler.json');
    const wranglerModulePath = join(dir, 'wrangler-fixture.mjs');
    const config = {
      account_id: 'a'.repeat(32), compatibility_date: '2026-09-09',
      services: [{ binding: 'Manager', service: 'nimbalyst-sandbox-test', entrypoint: 'SandboxManager', remote: true }],
    };
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(wranglerModulePath, `
      console.error('synthetic-auth-secret');
      export async function getPlatformProxy() {
        throw new Error('Authentication error: synthetic-auth-secret');
      }
    `);
    const callRaw = body => new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [fileURLToPath(new URL('./rpc-helper.mjs', import.meta.url))], { timeout: 5000 });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(body);
    });
    const call = request => callRaw(JSON.stringify({ configPath, wranglerModulePath, ...request }));
    const expectFailure = (output, error, reason) => {
      assert.equal(output.code, 1);
      assert.deepEqual(JSON.parse(output.stdout), { success: false, error, reason });
      assert.equal(output.stderr, '');
    };
    for (const [request, error, reason] of [
      [{ operation: 'status' }, 'not-authenticated', 'authentication'],
      [{ operation: 'stop' }, 'confirmation-required', 'confirmation-required'],
      [{ operation: 'eval' }, 'unknown', 'invalid-operation'],
    ]) {
      expectFailure(await call(request), error, reason);
    }
    // A body that parses to something other than an object reached a property
    // access and reported `container-unavailable`, blaming the sandbox for our
    // own malformed input.
    for (const body of ['null', '"status"', '{']) {
      expectFailure(await callRaw(body), 'unknown', 'invalid-request');
    }
    // Only unexpected top-level keys were rejected, so a malformed value threw
    // out of validation and was misreported the same way.
    for (const malformed of [
      { ...config, main: 'unreviewed-worker.js' },
      { ...config, services: [null] },
      { ...config, services: 'nimbalyst-sandbox-test' },
      null,
    ]) {
      await writeFile(configPath, JSON.stringify(malformed));
      expectFailure(await call({ operation: 'status' }), 'unknown', 'invalid-config');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
