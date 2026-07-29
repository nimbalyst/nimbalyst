/**
 * Regression coverage for NIM-479's batched untracked expansion. The fixture
 * intentionally uses real Git: only Git can authoritatively apply ignore and
 * nested-repository semantics.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GitStatusService } from '../GitStatusService';
import { getUntrackedFilesInDirectories } from '../../utils/gitUtils';
import { assertGitSandbox, gitSandboxEnv } from '../testSupport/gitTestSandbox';

vi.mock('../analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

let repo: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: gitSandboxEnv() });
}

function createService(expandUntrackedFiles = getUntrackedFilesInDirectories): GitStatusService {
  return new GitStatusService({
    expandUntrackedFiles,
    analytics: { sendEvent: vi.fn() },
  });
}

function relativePaths(statuses: Record<string, unknown>): string[] {
  return Object.keys(statuses)
    .map(filePath => path.relative(repo, filePath).split(path.sep).join('/'))
    .sort();
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-untracked-expand-'));
  git(['init'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  assertGitSandbox(repo);

  await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  git(['add', '.gitignore'], repo);
  git(['commit', '-m', 'init'], repo);

  // One hundred collapsed `?? dir/` entries exercise the single batched
  // pathspec call. Each directory has one visible source file.
  await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    const directory = path.join(repo, `newpkg-${String(index).padStart(3, '0')}`);
    await fs.mkdir(path.join(directory, 'src'), { recursive: true });
    await fs.writeFile(path.join(directory, 'src', 'index.ts'), `export const value = ${index};\n`);
  }));

  // NUL-separated output keeps whitespace-containing filenames intact.
  await fs.mkdir(path.join(repo, 'newpkg-000', 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'newpkg-000', 'src', 'with spaces.ts'), 'export {};\n');

  const ignored = path.join(repo, 'newpkg-000', 'node_modules', 'left-pad');
  await fs.mkdir(ignored, { recursive: true });
  await fs.writeFile(path.join(ignored, 'index.js'), 'module.exports = () => {};\n');
  await fs.mkdir(path.join(repo, 'newpkg-001', 'dist'), { recursive: true });
  await fs.writeFile(path.join(repo, 'newpkg-001', 'dist', 'bundle.js'), 'ignored\n');

  // A nested repository must retain Git's boundary semantics. Its untracked
  // file belongs to the nested repository, not the outer expansion.
  const nested = path.join(repo, 'nested-repo');
  await fs.mkdir(nested);
  git(['init'], nested);
  git(['config', 'user.email', 'test@example.com'], nested);
  git(['config', 'user.name', 'Test'], nested);
  await fs.writeFile(path.join(nested, 'tracked.ts'), 'export const tracked = true;\n');
  git(['add', 'tracked.ts'], nested);
  git(['commit', '-m', 'nested init'], nested);
  await fs.writeFile(path.join(nested, 'nested-change.ts'), 'export const nested = true;\n');
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('GitStatusService untracked-directory expansion (NIM-479)', () => {
  it('uses one async batched Git expansion while concurrent callers share it without blocking the event loop', async () => {
    const expansion = vi.fn(async (...args: Parameters<typeof getUntrackedFilesInDirectories>) => {
      // Keep the expansion pending long enough for the sentinel to prove that
      // the main thread is free to service timer callbacks.
      await new Promise(resolve => setTimeout(resolve, 75));
      return getUntrackedFilesInDirectories(...args);
    });
    const service = createService(expansion);
    let ticks = 0;
    const sentinel = setInterval(() => { ticks += 1; }, 5);

    try {
      const [statuses, uncommittedFiles] = await Promise.all([
        service.getAllFileStatuses(repo),
        service.getUncommittedFiles(repo, 'worktree_session'),
      ]);
      const rel = relativePaths(statuses);

      expect(expansion).toHaveBeenCalledTimes(1);
      expect(ticks).toBeGreaterThan(3);
      expect(uncommittedFiles).toHaveLength(Object.keys(statuses).length);
      expect(rel).toContain('newpkg-000/src/index.ts');
      expect(rel).toContain('newpkg-000/src/with spaces.ts');
      expect(rel).toContain('newpkg-099/src/index.ts');
      expect(rel).not.toContain('newpkg-000/node_modules/left-pad/index.js');
      expect(rel).not.toContain('newpkg-001/dist/bundle.js');
      expect(rel).not.toContain('nested-repo/nested-change.ts');

      const nested = await service.getFileStatus(repo, [path.join('nested-repo', 'nested-change.ts')]);
      expect(nested[path.join('nested-repo', 'nested-change.ts')]).toMatchObject({ status: 'untracked' });
    } finally {
      clearInterval(sentinel);
    }
  });

  it('invalidates an active generation without publishing it and permits one shared successor', async () => {
    let releaseFirstExpansion!: () => void;
    let firstExpansionStarted!: () => void;
    const firstRelease = new Promise<void>(resolve => { releaseFirstExpansion = resolve; });
    const firstStarted = new Promise<void>(resolve => { firstExpansionStarted = resolve; });
    let calls = 0;
    const expansion = vi.fn(async (...args: Parameters<typeof getUntrackedFilesInDirectories>) => {
      calls += 1;
      if (calls === 1) {
        firstExpansionStarted();
        await firstRelease;
      }
      return getUntrackedFilesInDirectories(...args);
    });
    const service = createService(expansion);

    const staleRequest = service.getAllFileStatuses(repo);
    await firstStarted;
    service.clearCache(repo);
    const successorRequest = service.getUncommittedFiles(repo, 'worktree_session');
    releaseFirstExpansion();

    const [stale, successor] = await Promise.all([staleRequest, successorRequest]);
    expect(stale).toEqual({});
    expect(successor).toContain(path.join(repo, 'newpkg-099', 'src', 'index.ts'));
    expect(calls).toBe(2);

    const cachedSuccessor = await service.getAllFileStatuses(repo);
    expect(relativePaths(cachedSuccessor)).toContain('newpkg-000/src/index.ts');
    expect(calls).toBe(2);
  });
});
