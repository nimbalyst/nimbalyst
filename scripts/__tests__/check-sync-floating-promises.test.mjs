import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkSyncFloatingPromises, findFloatingSyncPromises, SYNC_METHODS, SYNC_SCOPE } from '../check-sync-floating-promises.mjs';

test('every scope entry exists and the real production tree passes', () => {
  for (const entry of SYNC_SCOPE) assert.ok(existsSync(new URL(`../../${entry}`, import.meta.url)), entry);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../check-sync-floating-promises.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('missing file and directory scope entries produce explicit diagnostics', (t) => {
  const messages = [];
  t.mock.method(console, 'error', (message) => messages.push(message));
  assert.equal(checkSyncFloatingPromises(['missing-sync-scope.ts', 'missing-sync-directory']), 0);
  assert.deepEqual(messages, [
    '[sync-floating-promises] skipped missing scope entry: missing-sync-scope.ts',
    '[sync-floating-promises] skipped missing scope entry: missing-sync-directory',
  ]);
});

test('skips test paths while checking similarly named production files', () => {
  const snippet = 'provider.pushChange();';
  for (const file of [
    'packages/runtime/src/sync/__tests__/concurrent.ts',
    'packages/runtime/src/sync/__tests__/nested/concurrent.ts',
    'packages\\runtime\\src\\sync\\__tests__\\concurrent.ts',
    'packages/runtime/src/sync/concurrent.test.ts',
    'packages/runtime/src/sync/concurrent.spec.ts',
  ]) assert.deepEqual(findFloatingSyncPromises(snippet, file), [], file);
  for (const file of ['sync/__tests__helper/concurrent.ts', 'sync/concurrent.testHelper.ts']) {
    assert.equal(findFloatingSyncPromises(snippet, file).length, 1, file);
  }
});

test('rejects every named API, provider send/publish, optional calls and discarded chains', () => {
  const snippets = [
    ...[...SYNC_METHODS].map((name) => `this.${name}();`),
    'pushChange();', 'syncProvider.sendNewMessage();', 'this.provider.publishNewState();',
    'provider?.sendEvent?.();', 'provider["publishEvent"]();',
    '(provider.pushChange() as Promise<void>);', 'provider.pushChange().catch(log);',
    'ready && provider.pushChange();', 'void provider.pushChange();',
    'const reason = "// not a comment"; void provider.pushChange();',
    'register(() => { provider.pushChange(); });',
    'setTimeout(() => provider.pushChange(), 0);',
    'setTimeout(async () => provider.pushChange(), 0);',
    'setInterval(() => provider.pushChange(), 0);',
    'setImmediate(() => provider.pushChange());',
    'process.nextTick(() => provider.pushChange());',
    "emitter.once('change', () => provider.pushChange());",
    "target.addEventListener('change', () => provider.pushChange());",
    'ids.forEach((id) => provider.pushChange(id));',
    'queueMicrotask(() => this.syncSettingsToMobile());',
    "emitter.on('change', () => this.syncSettings());",
  ];
  for (const snippet of snippets) assert.equal(findFloatingSyncPromises(snippet).length, 1, snippet);
  assert.deepEqual(findFloatingSyncPromises('\nprovider.sendEvent();', 'example.ts'),
    [{ file: 'example.ts', line: 2, method: 'sendEvent' }]);
});

test('accepts ownership transfer and void with actual adjacent comments', () => {
  for (const snippet of [
    'await provider.pushChange();', 'return provider.pushChange();',
    'const pending = provider.pushChange();', 'pending = provider.pushChange();',
    'register(() => provider.pushChange());',
    'setTimeout(async () => { await provider.pushChange(); }, 0);',
    'return (async () => provider.pushChange());',
    'return (() => provider.pushChange());', 'async function transfer() { await (() => provider.pushChange()); }',
    'other.sendEvent();', 'provider.read();',
    '// best effort\nvoid provider.pushChange();',
    'void provider.pushChange(); // best effort',
    '/* best effort */ void (provider.pushChange());',
    'void provider.pushChange(/* best effort */);',
    'void provider.pushChange().catch(log); // best effort',
    '// provider.pushChange();\nconst text = "provider.sendEvent()";',
  ]) assert.deepEqual(findFloatingSyncPromises(snippet), [], snippet);
});

test('concise arrows propagate through collectors, promise chains, helpers and assignments', () => {
  for (const snippet of [
    'await Promise.allSettled(ids.map((id) => this.syncProjectConfig(id)));',
    'await Promise.all(ids.map((id) => provider.pushChange(id)));',
    'await ready.then(() => provider.pushChange());',
    'await withRetry(() => provider.pushChange());',
    'const publish = () => provider.pushChange();',
    'this.onFlush = () => this.syncSettingsToMobile();',
    'export const publish = () => provider.pushChange();',
  ]) assert.deepEqual(findFloatingSyncPromises(snippet), [], snippet);
});

test('void comments must touch the void line or the preceding line', () => {
  assert.deepEqual(findFloatingSyncPromises('// reason\nvoid provider.pushChange();'), []);
  assert.deepEqual(findFloatingSyncPromises('// reason\n\nvoid provider.pushChange();'),
    [{ file: 'snippet.ts', line: 3, method: 'pushChange' }]);
  assert.deepEqual(findFloatingSyncPromises('void provider.pushChange(\n  payload // unrelated argument comment\n);'),
    [{ file: 'snippet.ts', line: 1, method: 'pushChange' }]);
  assert.deepEqual(findFloatingSyncPromises('void provider.pushChange(\n  payload\n); // too late'),
    [{ file: 'snippet.ts', line: 1, method: 'pushChange' }]);
});
