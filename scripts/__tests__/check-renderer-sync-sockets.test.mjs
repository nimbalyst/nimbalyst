import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findUnproxiedSyncSockets } from '../check-renderer-sync-sockets.mjs';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-renderer-sync-sockets.mjs',
);

function fixture(name, source) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-socket-gate-'));
  const file = path.join(dir, name);
  writeFileSync(file, source, 'utf8');
  return file;
}

/**
 * The shape that actually shipped and broke Shared Docs: a config object built
 * inline with every callback wired, and no createWebSocket anywhere.
 */
test('flags a provider whose config omits createWebSocket', () => {
  const file = fixture('DataSource.ts', `
    const config: TeamSyncConfig = {
      serverUrl: scope.serverUrl,
      orgId: scope.orgId,
      getJwt: options.getJwt,
      onStatusChange: (status) => this.emit(status),
      ...providerEvents,
    };
    this.provider = new TeamSyncProvider(config);
  `);
  const violations = findUnproxiedSyncSockets([file]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].provider, 'TeamSyncProvider');
});

test('accepts a config that wires the proxy, including behind a conditional spread', () => {
  const file = fixture('DataSource.ts', `
    const config: TeamSyncConfig = {
      serverUrl: scope.serverUrl,
      ...(hasWebSocketProxy() ? { createWebSocket: createProxiedWebSocket } : {}),
    };
    this.provider = new TeamSyncProvider(config);
  `);
  assert.deepEqual(findUnproxiedSyncSockets([file]), []);
});

test('follows a spread of another local config', () => {
  const file = fixture('Cache.ts', `
    const base = { serverUrl, createWebSocket: createProxiedWebSocket };
    const cacheConfig = { ...base, onStatusChange };
    new DocumentSyncProvider(cacheConfig);
  `);
  assert.deepEqual(findUnproxiedSyncSockets([file]), []);
});

// A config handed in as a parameter cannot be followed, so the file-level
// fallback decides. Without any mention of the proxy the file still fails.
test('flags an unfollowable config in a file that never wires the proxy', () => {
  const file = fixture('Seam.ts', `
    this.provider = (options.createProvider ?? ((cfg) => new TeamSyncProvider(cfg)))(config);
  `);
  assert.equal(findUnproxiedSyncSockets([file]).length, 1);
});

test('passes over the real renderer tree and exits zero', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
