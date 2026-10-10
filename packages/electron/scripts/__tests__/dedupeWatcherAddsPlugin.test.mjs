import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { dedupeWatcherAdds } from '../dedupeWatcherAddsPlugin.mjs';

function fakeWatcher() {
  const watcher = new EventEmitter();
  watcher.added = [];
  watcher.add = (paths) => {
    watcher.added.push(...[paths].flat());
    return watcher;
  };
  watcher.unwatch = () => watcher;
  return dedupeWatcherAdds(watcher);
}

test('only the first add of a path reaches the watcher, and a dropped path can be re-added', () => {
  const watcher = fakeWatcher();
  watcher.add('/repo/runtime/src/a.ts');
  watcher.add(['/repo/runtime/src/a.ts', '/repo/runtime/src/b.ts']);
  watcher.add('!**/ignored/**');
  watcher.add('!**/ignored/**');
  assert.deepEqual(watcher.added, [
    '/repo/runtime/src/a.ts',
    '/repo/runtime/src/b.ts',
    '!**/ignored/**',
    '!**/ignored/**',
  ]);

  watcher.emit('unlink', '/repo/runtime/src/a.ts');
  watcher.emit('unlinkDir', '/repo/runtime');
  watcher.unwatch('/repo/other.ts');
  watcher.added.length = 0;
  watcher.add(['/repo/runtime/src/a.ts', '/repo/runtime/src/b.ts']);
  assert.deepEqual(watcher.added, ['/repo/runtime/src/a.ts', '/repo/runtime/src/b.ts']);
});
