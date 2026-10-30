import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';

// Track mock calls through a stable reference
const mockExecFile = vi.fn();
const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();
const mockRealpath = vi.fn();

// Mock the logger module (avoids electron-log/electron-store initialization)
vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

// Mock child_process.execFile
vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
  default: {
    execFile: (...args: any[]) => mockExecFile(...args),
  },
}));

// Baseline reads go through a long-lived `git cat-file --batch` process rather
// than a `git show` spawn, so the execFile mock above no longer intercepts
// them. Serve them from the same fixture map, keyed exactly as before
// (`show <sha>:<path>`), so the cases below read unchanged. The batch
// protocol itself is covered against real git in GitCatFileBatch.test.ts.
const gitFixtures = vi.hoisted(() => ({
  current: {} as Record<string, string | Error>,
  /** Baseline lookups that actually reached git, for cache-hit assertions. */
  reads: 0,
}));

vi.mock('../GitCatFileBatch', () => ({
  GitCatFileBatch: class {
    spawnCount = 0;
    constructor(_workspacePath: string, _options?: unknown) {}
    async read(sha: string, relativePath: string): Promise<string | null> {
      gitFixtures.reads++;
      const hit = gitFixtures.current[`show ${sha}:${relativePath}`];
      return typeof hit === 'string' ? hit : null;
    }
    dispose(): void {}
  },
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readdir: (...args: any[]) => mockReaddir(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  stat: (...args: any[]) => mockStat(...args),
  realpath: (...args: any[]) => mockRealpath(...args),
}));

import { FileSnapshotCache } from '../FileSnapshotCache';
import { logger } from '../../utils/logger';

describe('FileSnapshotCache', () => {
  const workspacePath = '/test/workspace';

  beforeEach(() => {
    vi.clearAllMocks();
    mockStat.mockResolvedValue({ size: 500 });
    mockRealpath.mockImplementation(async (targetPath: string) => targetPath);
  });

  function setupGitMocks(overrides: Record<string, string | Error> = {}) {
    const defaults: Record<string, string | Error> = {
      'rev-parse --git-dir': '.git\n',
      'rev-parse HEAD': 'abc123\n',
      'status --porcelain': '',
      ...overrides,
    };
    gitFixtures.current = defaults;

    mockExecFile.mockImplementation(
      (cmd: string, args: string[], opts: any, callback: Function) => {
        const argStr = args.join(' ');

        // Sort by specificity (longer matches first)
        const sortedKeys = Object.keys(defaults).sort((a, b) => b.length - a.length);

        for (const key of sortedKeys) {
          if (argStr.includes(key)) {
            const result = defaults[key];
            if (result instanceof Error) {
              callback(result, '', '');
            } else {
              callback(null, result, '');
            }
            return;
          }
        }

        callback(null, '', '');
      }
    );
  }

  describe('startSession - git repo', () => {
    it('should detect a git repo and capture startSha', async () => {
      setupGitMocks();

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const stats = cache.getStats();
      expect(stats.sessionId).toBe('session-1');
      expect(stats.isGitRepo).toBe(true);
      expect(stats.fileCount).toBe(0);
    });

    it('should cache dirty files from git status', async () => {
      setupGitMocks({
        'status --porcelain': ' M src/modified.ts\0A  src/staged.ts\0?? src/new.ts\0',
      });

      mockReadFile.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('src/modified.ts')) return 'working modified content';
        if (filePath.endsWith('src/staged.ts')) return 'working staged content';
        if (filePath.endsWith('src/new.ts')) return 'working new content';
        throw new Error('not found');
      });

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const stats = cache.getStats();
      expect(stats.fileCount).toBe(3);
      expect(stats.isGitRepo).toBe(true);

      const modifiedContent = await cache.getBeforeState(path.resolve(workspacePath, 'src/modified.ts'));
      expect(modifiedContent).toBe('working modified content');

      const stagedContent = await cache.getBeforeState(path.resolve(workspacePath, 'src/staged.ts'));
      expect(stagedContent).toBe('working staged content');

      const newContent = await cache.getBeforeState(path.resolve(workspacePath, 'src/new.ts'));
      expect(newContent).toBe('working new content');
    });

    // `-z` output is NUL-separated and unquoted. Without it git quotes names with
    // spaces or non-ASCII characters ("my file.md", "caf\303\251.md"), and those
    // dirty files were never cached, so their baseline fell back to HEAD.
    it('caches dirty files whose names have spaces, non-ASCII, or were renamed', async () => {
      setupGitMocks({
        'status --porcelain': '?? my file.md\0 M café.md\0R  docs/new name.md\0docs/old name.md\0',
      });

      mockReadFile.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('my file.md')) return 'untracked with space';
        if (filePath.endsWith('café.md')) return 'modified unicode';
        if (filePath.endsWith('new name.md')) return 'renamed content';
        throw new Error('not found');
      });

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      expect(cache.getStats().fileCount).toBe(3);
      expect(await cache.getBeforeState(path.resolve(workspacePath, 'my file.md'))).toBe('untracked with space');
      expect(await cache.getBeforeState(path.resolve(workspacePath, 'café.md'))).toBe('modified unicode');
      expect(await cache.getBeforeState(path.resolve(workspacePath, 'docs/new name.md'))).toBe('renamed content');
      expect(cache.hasSnapshot(path.resolve(workspacePath, 'docs/old name.md'))).toBe(false);
    });

    it('should skip binary files when caching dirty files', async () => {
      setupGitMocks({
        'status --porcelain': ' M image.png\0 M src/code.ts\0',
      });

      mockReadFile.mockResolvedValue('code content');

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const stats = cache.getStats();
      expect(stats.fileCount).toBe(1); // Only code.ts, not image.png
    });
  });

  describe('startSession - non-git repo', () => {
    it('should fall back to full scan for non-git repos', async () => {
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], opts: any, callback: Function) => {
          callback(new Error('not a git repo'), '', '');
        }
      );

      mockReaddir.mockImplementation(async (dir: string, opts: any) => {
        if (dir === workspacePath) {
          return [
            { name: 'file1.ts', isDirectory: () => false, isFile: () => true },
            { name: 'file2.ts', isDirectory: () => false, isFile: () => true },
            { name: 'node_modules', isDirectory: () => true, isFile: () => false },
            { name: 'image.png', isDirectory: () => false, isFile: () => true },
          ];
        }
        return [];
      });

      mockStat.mockResolvedValue({ size: 500 });
      mockReadFile.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('file1.ts')) return 'content of file1';
        if (filePath.endsWith('file2.ts')) return 'content of file2';
        throw new Error('not found');
      });

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const stats = cache.getStats();
      expect(stats.isGitRepo).toBe(false);
      expect(stats.fileCount).toBe(2);
    });
  });

  describe('getBeforeState', () => {
    it('should return cached content for files in cache (tier 1)', async () => {
      setupGitMocks({
        'status --porcelain': ' M dirty.ts\0',
      });

      mockReadFile.mockResolvedValue('working dirty content');

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const content = await cache.getBeforeState(path.resolve(workspacePath, 'dirty.ts'));
      expect(content).toBe('working dirty content');
    });

    it('should use git show for clean tracked files not in cache (tier 2)', async () => {
      setupGitMocks({
        'show abc123:src/clean.ts': 'clean tracked content',
      });

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const content = await cache.getBeforeState(path.resolve(workspacePath, 'src/clean.ts'));
      expect(content).toBe('clean tracked content');
    });

    it('should return null for untracked files', async () => {
      setupGitMocks({
        'show abc123:new-file.ts': new Error('path not found'),
      });

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const content = await cache.getBeforeState(path.resolve(workspacePath, 'new-file.ts'));
      expect(content).toBeNull();
    });

    it('should return null for files outside workspace', async () => {
      setupGitMocks();

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const content = await cache.getBeforeState('/outside/workspace/file.ts');
      expect(content).toBeNull();
    });

    it('should resolve baseline through realpath when workspace path differs (symlink/casing)', async () => {
      setupGitMocks({
        'show abc123:src/clean.ts': 'clean tracked content',
      });

      const symlinkWorkspacePath = '/workspace-link';
      const canonicalWorkspacePath = '/workspace-real';
      const canonicalFilePath = '/workspace-real/src/clean.ts';

      mockRealpath.mockImplementation(async (targetPath: string) => {
        if (targetPath === symlinkWorkspacePath) return canonicalWorkspacePath;
        if (targetPath === canonicalFilePath) return canonicalFilePath;
        return targetPath;
      });

      const cache = new FileSnapshotCache();
      await cache.startSession(symlinkWorkspacePath, 'session-1');

      const content = await cache.getBeforeState(canonicalFilePath);
      expect(content).toBe('clean tracked content');
    });

    it('should cache git show results for subsequent lookups', async () => {
      setupGitMocks({ 'show abc123:src/file.ts': 'file content' });
      gitFixtures.reads = 0;

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const content1 = await cache.getBeforeState(path.resolve(workspacePath, 'src/file.ts'));
      expect(content1).toBe('file content');
      expect(gitFixtures.reads).toBe(1);

      const content2 = await cache.getBeforeState(path.resolve(workspacePath, 'src/file.ts'));
      expect(content2).toBe('file content');
      expect(gitFixtures.reads).toBe(1); // Served from the in-memory cache
    });
  });

  describe('updateSnapshot', () => {
    it('should update cached content for a file', async () => {
      setupGitMocks();

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const filePath = path.resolve(workspacePath, 'src/file.ts');
      cache.updateSnapshot(filePath, 'updated content');

      const content = await cache.getBeforeState(filePath);
      expect(content).toBe('updated content');
    });

    it('warns once per session when the memory cap is reached, not once per file', async () => {
      setupGitMocks();

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      cache.updateSnapshot(path.resolve(workspacePath, 'big.txt'), 'a'.repeat(99_999_990));
      for (let i = 0; i < 5; i++) {
        cache.updateSnapshot(path.resolve(workspacePath, `overflow-${i}.txt`), 'overflow content');
      }

      const capWarnings = vi.mocked(logger.main.warn).mock.calls
        .filter(([message]) => String(message).includes('Memory cap reached'));
      expect(capWarnings).toHaveLength(1);
      expect(cache.hasSnapshot(path.resolve(workspacePath, 'overflow-0.txt'))).toBe(false);
    });
  });

  describe('hasSnapshot', () => {
    it('returns true only for files in tier-1 in-memory cache, never via tier-2 git fallback', async () => {
      setupGitMocks({
        'status --porcelain': ' M src/dirty.ts\0',
        'show abc123:src/clean.ts': 'committed clean content',
      });
      mockReadFile.mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('src/dirty.ts')) return 'working dirty content';
        throw new Error('not found');
      });

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const dirty = path.resolve(workspacePath, 'src/dirty.ts');
      const clean = path.resolve(workspacePath, 'src/clean.ts');

      // Dirty file is in cache from initGitCache.
      expect(cache.hasSnapshot(dirty)).toBe(true);
      // Clean file is NOT in cache, even though `getBeforeState` would fall
      // back to git startSha for it. `hasSnapshot` deliberately ignores that
      // tier so callers can distinguish "real session-lifetime baseline" from
      // "fabricated from committed state".
      expect(cache.hasSnapshot(clean)).toBe(false);
    });

    it('returns true after updateSnapshot seeds disk content for a file not previously cached', async () => {
      setupGitMocks();

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const filePath = path.resolve(workspacePath, 'src/seeded.ts');
      expect(cache.hasSnapshot(filePath)).toBe(false);

      cache.updateSnapshot(filePath, 'seeded content');
      expect(cache.hasSnapshot(filePath)).toBe(true);
    });
  });

  describe('removeSnapshot', () => {
    it('should remove cached content and update byte count', async () => {
      setupGitMocks();

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const filePath = path.resolve(workspacePath, 'src/file.ts');
      cache.updateSnapshot(filePath, 'some content');
      expect(cache.getStats().fileCount).toBe(1);

      cache.removeSnapshot(filePath);
      expect(cache.getStats().fileCount).toBe(0);
      expect(cache.getStats().totalBytes).toBe(0);
    });
  });

  describe('stopSession', () => {
    it('should clear all state', async () => {
      setupGitMocks();

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');
      cache.updateSnapshot('/test/file.ts', 'content');

      cache.stopSession();

      const stats = cache.getStats();
      expect(stats.fileCount).toBe(0);
      expect(stats.totalBytes).toBe(0);
      expect(stats.sessionId).toBeNull();
      expect(stats.isGitRepo).toBe(false);
    });
  });

  describe('dirty file rate limiting', () => {
    it('should cap cached dirty files at MAX_DIRTY_FILES (200)', async () => {
      // Generate 300 dirty files in git status output
      const lines = Array.from({ length: 300 }, (_, i) => `?? file${i}.ts\0`).join('');
      setupGitMocks({
        'status --porcelain': lines,
      });

      mockReadFile.mockImplementation(async (filePath: string) => `content of ${path.basename(filePath)}`);

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const stats = cache.getStats();
      expect(stats.fileCount).toBe(200);
      expect(logger.main.warn).toHaveBeenCalledWith(
        expect.stringContaining('300 dirty files exceeds limit of 200')
      );
    });

    it('should cap walkAndCache files at MAX_FULL_SCAN_FILES (500) for non-git repos', async () => {
      // Non-git repo
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], opts: any, callback: Function) => {
          callback(new Error('not a git repo'), '', '');
        }
      );

      // Generate 600 files in a flat directory
      const fileEntries = Array.from({ length: 600 }, (_, i) => ({
        name: `file${i}.ts`,
        isDirectory: () => false,
        isFile: () => true,
      }));

      mockReaddir.mockImplementation(async (dir: string) => {
        if (dir === workspacePath) return fileEntries;
        return [];
      });

      mockStat.mockResolvedValue({ size: 500 });
      mockReadFile.mockImplementation(async (filePath: string) => `content of ${path.basename(filePath)}`);

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const stats = cache.getStats();
      expect(stats.fileCount).toBe(500);
    });
  });
});
