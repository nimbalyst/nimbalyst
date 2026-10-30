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
import { execFileSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCatFileBatch, toGitObjectPath } from '../GitCatFileBatch';
import { parseDirtyPathsPorcelainZ } from '../FileSnapshotCache';

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

  it('settles broken-pipe reads and ignores late errors from a replaced child', async () => {
    const batch = make();
    const pending = [batch.read(sha, 'a.txt'), batch.read(sha, 'b.txt')];
    const child = (batch as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    // Emit the stream event directly: a real non-repo exit races the stdin write.
    expect(() => child.stdin.emit('error', brokenPipe)).not.toThrow();
    expect(await Promise.all(pending)).toEqual([null, null]);
    expect(batch.isRunning).toBe(false);
    const replacementRead = batch.read(sha, 'a.txt');
    expect(() => child.stdin.emit('error', brokenPipe)).not.toThrow();
    // Output the dead child had already written must not answer the replacement's read.
    child.stdout.emit('data', Buffer.from('0000000000000000000000000000000000000000 blob 6\n4a5800\n'));
    expect(await replacementRead).toBe('alpha\n');
  });
});

describe('toGitObjectPath', () => {
  // GitHub #1889: Windows hands `path.relative` output with backslashes to the
  // `<rev>:<path>` lookup, which git reports as missing for any nested file.
  it('converts a native Windows relative path into one git resolves', async () => {
    expect(await make().read(sha, 'nested\\c.txt')).toBeNull();
    expect(await make().read(sha, toGitObjectPath('nested\\c.txt', '\\'))).toBe('gamma\n');
  });

  it('keeps a literal backslash in a POSIX filename', () => {
    expect(toGitObjectPath('dir/odd\\name.txt', '/')).toBe('dir/odd\\name.txt');
  });
});

describe('parseDirtyPathsPorcelainZ', () => {
  // Checked against real `git status -z` output rather than a hand-written
  // string, so the parser cannot just agree with my reading of the format.
  it('returns unquoted paths and skips the source of a rename', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-status-z-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      fs.writeFileSync(path.join(dir, 'old name.md'), 'x\n');
      fs.writeFileSync(path.join(dir, 'tracked.md'), 'x\n');
      git('add', '-A');
      git('commit', '-qm', 'init');
      git('mv', 'old name.md', 'new name.md');
      fs.writeFileSync(path.join(dir, 'tracked.md'), 'changed\n');
      fs.writeFileSync(path.join(dir, 'café.md'), 'new\n');

      const stdout = git('--no-optional-locks', 'status', '--porcelain', '-z');
      expect(parseDirtyPathsPorcelainZ(stdout).sort()).toEqual(['café.md', 'new name.md', 'tracked.md']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
