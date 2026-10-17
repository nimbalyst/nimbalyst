// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ handles: new Set<fs.StatWatcher>() }));
vi.mock('fs', async () => {
  const native = await vi.importActual<typeof import('fs')>('fs');
  return { ...native, watchFile: (...args: Parameters<typeof native.watchFile>) => {
    const handle = native.watchFile(...args);
    observed.handles.add(handle);
    return handle;
  } };
});

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../utils/logger', () => ({ logger: { main: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../../ipc/GitStatusHandlers', () => ({ clearGitStatusCache: vi.fn() }));
vi.mock('../../utils/gitUncommittedFiles', () => ({ clearGitFactsCache: vi.fn() }));
import { GitRefWatcher } from '../GitRefWatcher';
import { createScratchRepo, type ScratchRepo } from '../../services/testSupport/gitTestSandbox';

const watcher = new GitRefWatcher();
let scratch: ScratchRepo | undefined;
afterEach(async () => {
  await watcher.stopAll();
  vi.restoreAllMocks();
  if (scratch) {
    for (const file of ['index', 'HEAD', 'refs/heads/main']) fs.unwatchFile(path.join(scratch.path, '.git', file));
    scratch.cleanup();
  }
});

it('releases native polling listeners after overlapping starts and cancellation', async () => {
  scratch = createScratchRepo();
  const fixture = scratch.path;
  fs.writeFileSync(path.join(fixture, 'file.txt'), 'Synthetic lifecycle test\n');
  scratch.git('add', '.');
  scratch.git('commit', '-qm', 'Create test fixture');

  const handles = observed.handles;

  await Promise.all([watcher.start(fixture), watcher.start(fixture), watcher.start(fixture)]);
  expect(watcher.getStats().activeWatchers).toBe(1);
  expect([...handles].some(handle => handle.listenerCount('change') > 0)).toBe(true);
  await watcher.stop(fixture);
  expect([...handles].every(handle => handle.listenerCount('change') === 0)).toBe(true);

  const starting = watcher.start(fixture);
  await watcher.stop(fixture);
  await starting;
  expect(watcher.getStats().activeWatchers).toBe(0);
  expect([...handles].every(handle => handle.listenerCount('change') === 0)).toBe(true);
});

it('reads HEAD changes without rewriting the index another git command may need', async () => {
  // A rebase moves HEAD on every step. If the watcher's status refreshes and
  // locks .git/index at the wrong moment, `git pull --rebase` fails to reapply
  // its autostash and leaves the user's dirty edits parked in the stash.
  scratch = createScratchRepo();
  const fixture = scratch.path;
  fs.writeFileSync(path.join(fixture, 'file.txt'), 'Synthetic lock test\n');
  scratch.git('add', '.');
  scratch.git('commit', '-qm', 'Create test fixture');
  await watcher.start(fixture);

  // Make the index's cached stat data stale so a locking status would rewrite it.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(fixture, 'file.txt'), later, later);
  const indexPath = path.join(fixture, '.git', 'index');
  const before = fs.statSync(indexPath).mtimeMs;

  await (watcher as unknown as { handleHeadChange(p: string): Promise<void> }).handleHeadChange(fixture);

  expect(fs.statSync(indexPath).mtimeMs).toBe(before);
});
