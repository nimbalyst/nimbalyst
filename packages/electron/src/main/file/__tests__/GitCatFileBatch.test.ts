// @vitest-environment node
/**
 * `getBeforeState` spawned one `git show` per file to rebuild a session's
 * baseline. Process creation dominated three CPU profiles on a swapping
 * machine -- 22.4s of a single 23s freeze sat inside `spawn` for twelve calls,
 * roughly 1.9s each. This replaces N spawns with one long-lived
 * `git cat-file --batch` process fed over stdin.
 *
 * The protocol is the risk, not the idea: responses are binary, arrive in
 * request order on one stream, and a missing object gets a different line
 * shape. These run against real git in a temp repo, because a hand-rolled fake
 * would only prove the parser agrees with my own assumptions.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCatFileBatch } from '../GitCatFileBatch';

let repo: string;
let sha: string;
const open: GitCatFileBatch[] = [];

const make = (opts?: ConstructorParameters<typeof GitCatFileBatch>[1]) => {
  const b = new GitCatFileBatch(repo, opts);
  open.push(b);
  return b;
};

beforeAll(() => {
  // Sandboxed under tmpdir so a stray commit can never land on the real repo.
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-catfile-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'beta content here\n');
  fs.mkdirSync(path.join(repo, 'nested'));
  fs.writeFileSync(path.join(repo, 'nested', 'c.txt'), 'gamma\n');
  // A file with a newline-heavy body: the batch protocol is length-prefixed,
  // so a parser that scanned for newlines would corrupt this one.
  fs.writeFileSync(path.join(repo, 'multi.txt'), 'l1\nl2\nl3\n\n\nl6\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, stdio: 'pipe' }).toString().trim();
});

afterEach(() => {
  while (open.length) open.pop()!.dispose();
  vi.useRealTimers();
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('GitCatFileBatch', () => {
  it('reads a file at a commit', async () => {
    expect(await make().read(sha, 'a.txt')).toBe('alpha\n');
  });

  it('preserves a body with blank lines exactly', async () => {
    expect(await make().read(sha, 'multi.txt')).toBe('l1\nl2\nl3\n\n\nl6\n');
  });

  it('returns null for a path not in the commit', async () => {
    expect(await make().read(sha, 'does-not-exist.txt')).toBeNull();
  });

  it('serves many reads from one process, in the right order', async () => {
    const batch = make();
    const results = await Promise.all([
      batch.read(sha, 'a.txt'),
      batch.read(sha, 'missing-1.txt'),
      batch.read(sha, 'b.txt'),
      batch.read(sha, 'nested/c.txt'),
      batch.read(sha, 'missing-2.txt'),
      batch.read(sha, 'multi.txt'),
    ]);

    expect(results).toEqual([
      'alpha\n',
      null,
      'beta content here\n',
      'gamma\n',
      null,
      'l1\nl2\nl3\n\n\nl6\n',
    ]);
    expect(batch.spawnCount).toBe(1);
  });

  it('skips an object larger than the cap without killing the stream', async () => {
    const batch = make({ maxObjectBytes: 4 });

    expect(await batch.read(sha, 'b.txt')).toBeNull();
    // The oversized body still has to be consumed, or the next read desyncs.
    expect(await batch.read(sha, 'a.txt')).toBeNull();
    expect(batch.spawnCount).toBe(1);
  });

  it('respawns after the process is disposed mid-life', async () => {
    const batch = make();
    expect(await batch.read(sha, 'a.txt')).toBe('alpha\n');
    batch.dispose();
    expect(await batch.read(sha, 'a.txt')).toBe('alpha\n');
    expect(batch.spawnCount).toBe(2);
  });

  it('shuts the process down when idle and reopens on demand', async () => {
    const batch = make({ idleTimeoutMs: 50 });
    expect(await batch.read(sha, 'a.txt')).toBe('alpha\n');

    // Observe the idle callback rather than assuming it has run within a fixed
    // sleep under full-suite load.
    await vi.waitFor(() => expect(batch.isRunning).toBe(false));

    expect(await batch.read(sha, 'b.txt')).toBe('beta content here\n');
    expect(batch.spawnCount).toBe(2);
  });

  it.each([
    ['a.txt', undefined, 'alpha\n'],
    ['missing.txt', undefined, null],
    ['a.txt', 1, null],
  ] as const)('retires after a slow read of %s even when the first idle timer expires', async (file, maxObjectBytes, expected) => {
    vi.useFakeTimers();
    const batch = make({ idleTimeoutMs: 50, maxObjectBytes });
    const response = batch.read(sha, file);
    // Advance synchronously before the real child's I/O can complete: the
    // timeout must leave the pending read alive, then restart when it drains.
    vi.advanceTimersByTime(50);
    expect(batch.isRunning).toBe(true);
    expect(await response).toBe(expected);
    vi.advanceTimersByTime(49);
    expect(batch.isRunning).toBe(true);
    vi.advanceTimersByTime(1);
    expect(batch.isRunning).toBe(false);
  });

  it('reports a non-git directory as missing rather than hanging', async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-notrepo-'));
    try {
      const batch = new GitCatFileBatch(notARepo);
      open.push(batch);
      expect(await batch.read(sha, 'a.txt')).toBeNull();
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
