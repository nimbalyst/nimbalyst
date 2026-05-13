import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../utils/logger', () => ({
  logger: {
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('../../../HistoryManager', () => ({
  historyManager: {
    listSnapshots: vi.fn().mockResolvedValue([]),
    getLastReviewedTimestamp: vi.fn().mockResolvedValue(null),
    getPendingTags: vi.fn().mockResolvedValue([]),
    getTaggedFilesForSession: vi.fn().mockResolvedValue([]),
    createTag: vi.fn(),
  },
}));

vi.mock('@nimbalyst/runtime', () => ({
  SessionFilesRepository: { addFileLink: vi.fn() },
}));

vi.mock('../../WorkspaceFileEditAttributionService', () => ({
  workspaceFileEditAttributionService: { ingestWatcherEvent: vi.fn() },
}));

vi.mock('../../../file/WorkspaceEventBus', () => ({
  addGitignoreBypass: vi.fn(),
}));

import { extractFilePathsFromCommand, HooklessAgentFileWatcher } from '../HooklessAgentFileWatcher';
import { FileSnapshotCache } from '../../../file/FileSnapshotCache';

describe('extractFilePathsFromCommand', () => {
  let workspaceRoot: string;
  let nestedDir: string;
  let realFile: string;
  let realFileRel: string;

  beforeAll(async () => {
    // Realpath the workspace root so the boundary check (which compares
    // against `workspaceRoot` after symlink resolution) doesn't reject
    // candidates resolved through /private/var on macOS.
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hookless-watcher-'));
    workspaceRoot = await fs.promises.realpath(tmp);
    nestedDir = path.join(workspaceRoot, 'packages', 'electron', 'src');
    await fs.promises.mkdir(nestedDir, { recursive: true });
    realFile = path.join(nestedDir, 'file.ts');
    await fs.promises.writeFile(realFile, 'export const a = 1;\n');
    realFileRel = path.relative(workspaceRoot, realFile);
  });

  afterAll(async () => {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('returns the file when a real file is referenced as an absolute path', async () => {
    const result = await extractFilePathsFromCommand(
      `cat ${realFile}`,
      workspaceRoot,
      workspaceRoot,
    );
    expect(result).toEqual([realFile]);
  });

  it('skips directory candidates so they do not later cause EISDIR reads', async () => {
    // Pre-fix behavior: nestedDir would be returned and downstream readFile
    // would fail with EISDIR, producing a noisy WARN log line.
    const result = await extractFilePathsFromCommand(
      `find ${nestedDir} -name '*.ts'`,
      workspaceRoot,
      workspaceRoot,
    );
    expect(result).toEqual([]);
  });

  it('also skips the workspace root itself when used as a positional arg', async () => {
    const result = await extractFilePathsFromCommand(
      `ls -la ${workspaceRoot}`,
      workspaceRoot,
      workspaceRoot,
    );
    expect(result).toEqual([]);
  });

  it('returns the file when both a directory and a file are referenced together', async () => {
    const result = await extractFilePathsFromCommand(
      `grep -l "x" ${nestedDir} ${realFile}`,
      workspaceRoot,
      workspaceRoot,
    );
    expect(result).toEqual([realFile]);
  });

  it('resolves relative-path tokens against cwd', async () => {
    const result = await extractFilePathsFromCommand(
      `cat ${realFileRel}`,
      workspaceRoot,
      workspaceRoot,
    );
    expect(result).toEqual([realFile]);
  });

  it('ignores tokens that do not contain a path separator', async () => {
    // `head` and `-2` should not be treated as relative paths.
    const result = await extractFilePathsFromCommand(
      `head -2 ${realFile}`,
      workspaceRoot,
      workspaceRoot,
    );
    expect(result).toEqual([realFile]);
  });

  it('rejects absolute paths outside the workspace', async () => {
    const outsideTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hookless-outside-'));
    try {
      const outsideFile = path.join(await fs.promises.realpath(outsideTmp), 'leak.txt');
      await fs.promises.writeFile(outsideFile, 'nope');
      const result = await extractFilePathsFromCommand(
        `cat ${outsideFile}`,
        workspaceRoot,
        workspaceRoot,
      );
      expect(result).toEqual([]);
    } finally {
      await fs.promises.rm(outsideTmp, { recursive: true, force: true });
    }
  });

  it('returns nothing when the referenced path does not exist on disk', async () => {
    const ghost = path.join(workspaceRoot, 'does', 'not', 'exist.ts');
    const result = await extractFilePathsFromCommand(
      `cat ${ghost}`,
      workspaceRoot,
      workspaceRoot,
    );
    expect(result).toEqual([]);
  });

  it('strips trailing punctuation from absolute path matches', async () => {
    // The extractor strips trailing );:, so a command like
    // `(cat /path/file);` still resolves to /path/file.
    const result = await extractFilePathsFromCommand(
      `(cat ${realFile});`,
      workspaceRoot,
      workspaceRoot,
    );
    expect(result).toEqual([realFile]);
  });
});

describe('HooklessAgentFileWatcher.captureBashPreEditSnapshots', () => {
  let workspaceRoot: string;
  let modifiedFile: string;
  let modifiedFileRel: string;

  beforeAll(async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hookless-seed-'));
    workspaceRoot = await fs.promises.realpath(tmp);
    const dir = path.join(workspaceRoot, 'packages', 'runtime', 'src');
    await fs.promises.mkdir(dir, { recursive: true });
    modifiedFile = path.join(dir, 'sdkOptionsBuilder.ts');
    await fs.promises.writeFile(modifiedFile, 'working tree (modified) content\n');
    modifiedFileRel = path.relative(workspaceRoot, modifiedFile);
  });

  afterAll(async () => {
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  });

  // Repro: a read-only `sed -n` against a file whose working-tree content
  // differs from its baseline must NOT mark the file as edited. Before the
  // fix, the cache miss tier-2 git-`startSha` fallback would supply the
  // committed (pre-modification) content, currentContent would differ, and
  // a session_files row would be inserted — even though the bash command
  // never wrote anything.
  it('seeds current disk content into the cache for files referenced by a Bash command', async () => {
    const watcher = new HooklessAgentFileWatcher();
    const cache = new FileSnapshotCache();
    // Skip startSession (no need to scan a real git repo for this test);
    // captureBashPreEditSnapshots does not require it.

    // Inject a watcher entry directly so we don't have to spin up chokidar.
    (watcher as any).watchers.set('session-1', {
      cache,
      watcher: { stop: vi.fn() },
      workspacePath: workspaceRoot,
    });

    const command = `/bin/zsh -lc "sed -n '1,5p' ${modifiedFileRel}"`;
    expect(cache.hasSnapshot(modifiedFile)).toBe(false);

    await watcher.captureBashPreEditSnapshots('session-1', workspaceRoot, command);

    expect(cache.hasSnapshot(modifiedFile)).toBe(true);
    expect(await cache.getBeforeState(modifiedFile)).toBe('working tree (modified) content\n');
  });

  it('preserves an existing cache entry rather than overwriting (seed-if-missing)', async () => {
    const watcher = new HooklessAgentFileWatcher();
    const cache = new FileSnapshotCache();

    // Pre-populate the cache as if an earlier write in this turn had set a
    // pre-edit baseline. The seed must not clobber it — that would erase the
    // baseline an in-flight write needs for its own attribution.
    cache.updateSnapshot(modifiedFile, 'pre-edit-baseline-from-earlier-write');

    (watcher as any).watchers.set('session-2', {
      cache,
      watcher: { stop: vi.fn() },
      workspacePath: workspaceRoot,
    });

    const command = `/bin/zsh -lc "cat ${modifiedFileRel}"`;
    await watcher.captureBashPreEditSnapshots('session-2', workspaceRoot, command);

    expect(await cache.getBeforeState(modifiedFile)).toBe('pre-edit-baseline-from-earlier-write');
  });

  it('is a no-op when no watcher entry exists for the session', async () => {
    const watcher = new HooklessAgentFileWatcher();
    // Should not throw, even though `watchers` has no entry for the session.
    await expect(
      watcher.captureBashPreEditSnapshots('unknown-session', workspaceRoot, `cat ${modifiedFile}`),
    ).resolves.toBeUndefined();
  });
});
