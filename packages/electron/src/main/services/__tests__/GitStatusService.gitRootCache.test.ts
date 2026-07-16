/**
 * Tests for the per-directory `.git` existence cache added to
 * `findGitRootForFile` (nimbalyst#868). The uncached walker re-`existsSync`-ed
 * the same directory chains on every call, which under multi-session editing of
 * a large repo turned into a synchronous FS storm that blocked the main thread.
 *
 * Uses the real filesystem (matching GitStatusService.findGitRoot.test.ts) and
 * verifies the result is memoized: once a root is resolved, a later call returns
 * it without re-reading the filesystem, and clearing the cache re-reads.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { findGitRootForFile, __resetGitRootCache } from '../GitStatusService';

let tmpRoot: string;

beforeEach(async () => {
  __resetGitRootCache();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-gitroot-cache-'));
});

afterEach(async () => {
  __resetGitRootCache();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('findGitRootForFile caching (#868)', () => {
  it('memoizes the resolved root and only re-reads after the cache is cleared', async () => {
    const repo = path.join(tmpRoot, 'repo');
    const file = path.join(repo, 'src', 'deep', 'a.ts');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '');

    // First resolve finds the repo root.
    expect(findGitRootForFile(file, tmpRoot)).toBe(repo);

    // Remove the .git marker; a cached lookup must still return the root
    // (proving the second call did not touch the filesystem).
    await fs.rm(path.join(repo, '.git'), { recursive: true, force: true });
    expect(findGitRootForFile(file, tmpRoot)).toBe(repo);

    // After clearing the cache the filesystem is read again -> no root now.
    __resetGitRootCache();
    expect(findGitRootForFile(file, tmpRoot)).toBeNull();
  });

  it('still resolves correct roots for unrelated files (no cross-contamination)', async () => {
    const repoA = path.join(tmpRoot, 'a');
    const repoB = path.join(tmpRoot, 'b');
    for (const r of [repoA, repoB]) {
      await fs.mkdir(path.join(r, '.git'), { recursive: true });
      await fs.writeFile(path.join(r, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await fs.mkdir(path.join(r, 'src'), { recursive: true });
      await fs.writeFile(path.join(r, 'src', 'x.ts'), '');
    }
    expect(findGitRootForFile(path.join(repoA, 'src', 'x.ts'), tmpRoot)).toBe(repoA);
    expect(findGitRootForFile(path.join(repoB, 'src', 'x.ts'), tmpRoot)).toBe(repoB);
  });
});
