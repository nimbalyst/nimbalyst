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
        'status --porcelain': ' M src/modified.ts\nA  src/staged.ts\n?? src/new.ts\n',
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

    it('should skip binary files when caching dirty files', async () => {
      setupGitMocks({
        'status --porcelain': ' M image.png\n M src/code.ts\n',
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
        'status --porcelain': ' M dirty.ts\n',
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
      let gitShowCallCount = 0;

      mockExecFile.mockImplementation(
        (cmd: string, args: string[], opts: any, callback: Function) => {
          const argStr = args.join(' ');
          if (argStr.includes('rev-parse --git-dir')) {
            callback(null, '.git\n', '');
          } else if (argStr.includes('rev-parse HEAD')) {
            callback(null, 'abc123\n', '');
          } else if (argStr.includes('status --porcelain')) {
            callback(null, '', '');
          } else if (argStr.includes('show abc123:src/file.ts')) {
            gitShowCallCount++;
            callback(null, 'file content', '');
          } else {
            callback(null, '', '');
          }
        }
      );

      const cache = new FileSnapshotCache();
      await cache.startSession(workspacePath, 'session-1');

      const content1 = await cache.getBeforeState(path.resolve(workspacePath, 'src/file.ts'));
      expect(content1).toBe('file content');
      expect(gitShowCallCount).toBe(1);

      const content2 = await cache.getBeforeState(path.resolve(workspacePath, 'src/file.ts'));
      expect(content2).toBe('file content');
      expect(gitShowCallCount).toBe(1); // No additional git call
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
  });

  describe('hasSnapshot', () => {
    it('returns true only for files in tier-1 in-memory cache, never via tier-2 git fallback', async () => {
      setupGitMocks({
        'status --porcelain': ' M src/dirty.ts\n',
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
      const lines = Array.from({ length: 300 }, (_, i) => `?? file${i}.ts`).join('\n');
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
