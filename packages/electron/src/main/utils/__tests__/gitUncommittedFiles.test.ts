import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// git.status() is controlled per-test via this ref so we can simulate a hung
// git subprocess (issue #929: an un-timed `git status` froze sessions:list).
let statusImpl: () => Promise<unknown>;

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    status: () => statusImpl(),
  })),
}));

import { getCachedUncommittedFiles, withTimeout } from '../gitUncommittedFiles';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-git-timeout-test-'));
  await fs.mkdir(path.join(tmpRoot, '.git'), { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('getCachedUncommittedFiles git-status timeout (#929)', () => {
  it('rejects instead of hanging when git status never settles', async () => {
    vi.useFakeTimers();
    // Simulate a hung git subprocess: status() never resolves or rejects.
    statusImpl = () => new Promise(() => {});

    const pending = getCachedUncommittedFiles(tmpRoot);
    // Surface the rejection assertion before advancing the clock so the
    // rejection is observed rather than becoming unhandled.
    const assertion = expect(pending).rejects.toThrow(/git status timed out/);

    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
  });

  it('resolves normally when git status returns quickly', async () => {
    statusImpl = async () => ({
      modified: ['a.ts'],
      created: [],
      not_added: ['b.ts'],
      deleted: [],
      renamed: [],
      staged: [],
    });

    await expect(getCachedUncommittedFiles(tmpRoot)).resolves.toEqual(
      new Set(['a.ts', 'b.ts']),
    );
  });
});

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'nope')).resolves.toBe(42);
  });

  it('rejects with the message when the promise never settles', async () => {
    vi.useFakeTimers();
    const assertion = expect(
      withTimeout(new Promise(() => {}), 5000, 'timed out'),
    ).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});
