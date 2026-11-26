// @vitest-environment node
// Real chokidar on a real tree: the other bus tests mock chokidar, which hides
// its `ready` counting. On Linux the bus adds expanded and bypassed paths to a
// handle whose initial scan may still be running, and `watching` must still
// mean the scan covered the tree (#2014).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const recorded = vi.hoisted(() => ({ handles: [] as any[] }));

vi.mock('chokidar', async (importOriginal) => {
  const actual: any = await importOriginal();
  const real = actual.default ?? actual;
  return {
    ...actual,
    default: {
      ...real,
      watch: (...args: any[]) => {
        const watcher = real.watch(...args);
        recorded.handles.push(watcher);
        return watcher;
      },
    },
  };
});
vi.mock('../../utils/logger', () => ({
  logger: {
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    workspaceWatcher: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('../../utils/workspaceDetection', () => ({
  isPathInWorkspace: (filePath: string, workspacePath: string) =>
    !!filePath && !!workspacePath && (filePath === workspacePath || filePath.startsWith(workspacePath + '/')),
}));

import { subscribe, addGitignoreBypass, addWatchedPath, resetBus } from '../WorkspaceEventBus';
import { logger } from '../../utils/logger';
import type { FileWatchHealth } from '../../../shared/fileWatchHealth';

const DIRS = 400;
// The root plus d<i> and d<i>/inner.
const FULL = 1 + DIRS * 2;
let root: string;

const enospc = () => Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
const noEvents = { onAdd() {}, onChange() {}, onUnlink() {} };

function watchedDirs(handle: any): number {
  return Object.keys(handle.getWatched()).filter((dir) => dir === root || dir.startsWith(root + '/')).length;
}

describe.skipIf(process.platform !== 'linux')('WorkspaceEventBus on Linux: watching means the scan finished', () => {
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/var/tmp', 'bus-linux-scan-'));
    for (let d = 0; d < DIRS; d++) {
      const dir = path.join(root, `d${d}`, 'inner');
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 10; f++) fs.writeFileSync(path.join(dir, `f${f}.md`), 'x');
    }
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  afterEach(async () => {
    resetBus();
    vi.useRealTimers();
    recorded.handles.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it.each([
    ['a file an agent is about to create', (p: string) => addGitignoreBypass(root, p), 'agent-will-create.md'],
    ['an expanded folder that no longer exists', (p: string) => addWatchedPath(root, p), 'removed-folder'],
  ])('stays starting when %s is registered during the first scan', async (_label, register, name) => {
    let dirsAtWatching: number | undefined;
    await subscribe(root, 'scan', {
      ...noEvents,
      onHealthChanged: (health) => {
        if (health.state === 'watching' && dirsAtWatching === undefined) dirsAtWatching = watchedDirs(recorded.handles.at(-1));
      },
    });
    // subscribe() has returned, so the handle is installed and its scan is running.
    register(path.join(root, name));
    await vi.waitFor(() => expect(dirsAtWatching).toBeDefined(), { timeout: 10_000, interval: 20 });
    expect(dirsAtWatching).toBe(FULL);
  });

  it('C5: keeps an overflowed first scan until it finishes when a path it cannot stat is registered during the episode', async () => {
    const states: FileWatchHealth[] = [];
    let dirsAtWatching: number | undefined;
    await subscribe(root, 'scan', {
      ...noEvents,
      onHealthChanged: (health) => {
        states.push(health);
        if (health.state === 'watching' && dirsAtWatching === undefined) dirsAtWatching = watchedDirs(recorded.handles.at(-1));
      },
    });
    // The scan is running; a storm overflows the event backlog before it finishes.
    for (let i = 0; i < 16_600; i++) recorded.handles[0].emit('change', path.join(root, `storm-${i}.md`));
    expect(states.at(-1)).toMatchObject({ state: 'recovering', reason: 'event_queue_overflow' });
    addGitignoreBypass(root, path.join(root, 'agent-will-create.md'));
    await vi.waitFor(() => expect(dirsAtWatching).toBeDefined(), { timeout: 10_000, interval: 20 });
    expect(dirsAtWatching).toBe(FULL);
    expect(recorded.handles).toHaveLength(1);
  });

  it('keeps a retry with a stale bypass path starting until its scan finishes, so ENOSPC keeps escalating', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const states: FileWatchHealth[] = [];
    const capacityDelays: number[] = [];
    await subscribe(root, 'scan', {
      ...noEvents,
      onHealthChanged: (health) => {
        states.push(health);
        if (health.state === 'recovering' && health.reason === 'ENOSPC') capacityDelays.push(health.nextRetryAt! - Date.now());
      },
    });
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe('watching'), { timeout: 10_000, interval: 20 });
    expect(watchedDirs(recorded.handles[0])).toBe(FULL);

    // An agent edited a file that was later deleted; its bypass stays registered.
    addGitignoreBypass(root, path.join(root, 'deleted-by-agent.md'));
    vi.mocked(logger.main.warn).mockClear();
    recorded.handles[0].emit('error', enospc());
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(60_000);

    // Fail the retry 75 s into its scan, while the scan is still running.
    await new Promise<void>((resolve, reject) => {
      const probe = () => {
        const retry = recorded.handles[1];
        const dirs = retry ? watchedDirs(retry) : 0;
        if (dirs >= FULL) return reject(new Error('the retry scan finished before the probe saw it running'));
        if (dirs > 1) {
          vi.setSystemTime(Date.now() + 75_000);
          retry.emit('error', enospc());
          return resolve();
        }
        setImmediate(probe);
      };
      probe();
    });

    expect(states.filter((health) => health.state === 'watching' && health.generation > 1)).toEqual([]);
    expect(capacityDelays).toEqual([60_000, 300_000]);
    const limitWarnings = vi.mocked(logger.main.warn).mock.calls.filter(([message]) => String(message).includes('watch limit'));
    expect(limitWarnings).toHaveLength(1);
  });
});
