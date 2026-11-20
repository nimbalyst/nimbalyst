import { afterEach, describe, expect, it, vi } from 'vitest';

const { matchWorkspaceFileEdit, addFileLink, debug, getGitFactsForFile, getRunningSessionIds } = vi.hoisted(() => ({
  matchWorkspaceFileEdit: vi.fn(),
  addFileLink: vi.fn(),
  debug: vi.fn(),
  getGitFactsForFile: vi.fn(),
  getRunningSessionIds: vi.fn((): string[] => []),
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ getRunningSessionIds }),
}));

vi.mock('../../history/fileGitFacts', () => ({
  getGitFactsForFile,
  UNKNOWN_GIT_FACTS: { isTracked: null, isUncommitted: null },
}));

vi.mock('@nimbalyst/runtime', () => ({
  SessionFilesRepository: { addFileLink },
}));

vi.mock('../../HistoryManager', () => ({
  historyManager: { createTag: vi.fn() },
}));

vi.mock('../../file/WorkspaceEventBus', () => ({
  getSubscriberIds: vi.fn(() => ['legacy-session']),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('../../utils/fileFilters', () => ({
  shouldExcludePath: vi.fn(() => false),
}));

vi.mock('../SessionEditQuota', () => ({
  sessionEditQuota: { tryReserve: vi.fn(() => Promise.resolve(true)) },
}));

const throttle = vi.hoisted(() => ({ tryAcquire: vi.fn(() => true), msUntilToken: vi.fn(() => 0) }));
vi.mock('../WorkspaceAttributionThrottle', () => ({
  workspaceAttributionThrottle: throttle,
}));

vi.mock('../ToolCallMatcher', () => ({
  toolCallMatcher: { matchWorkspaceFileEdit },
}));

vi.mock('../CodexEditWindowRegistry', () => ({
  codexEditWindowRegistry: {
    findWindowForEdit: vi.fn(() => null),
    recordObservation: vi.fn(),
  },
}));

vi.mock('../sessionFilesNotify', () => ({
  notifySessionFilesUpdated: vi.fn(),
}));

import { workspaceFileAttributionPolicy } from '../WorkspaceFileAttributionPolicy';
import { workspaceFileEditAttributionService } from '../WorkspaceFileEditAttributionService';

describe('WorkspaceFileEditAttributionService', () => {
  afterEach(() => {
    workspaceFileAttributionPolicy.__resetForTests();
    throttle.tryAcquire.mockReset();
    throttle.tryAcquire.mockReturnValue(true);
    matchWorkspaceFileEdit.mockReset();
    addFileLink.mockReset();
    debug.mockReset();
    getRunningSessionIds.mockReset();
    getRunningSessionIds.mockReturnValue([]);
  });

  it('drops pooled listener events workspace-wide while app-server attribution is disabled', async () => {
    workspaceFileAttributionPolicy.set('app-server-session', '/workspace', 'disabled');
    getRunningSessionIds.mockReturnValue(['app-server-session']);

    workspaceFileEditAttributionService.ingestWatcherEvent({
      workspacePath: '/workspace',
      filePath: '/workspace/src/app.ts',
      timestamp: Date.now(),
      beforeContent: 'before',
    });

    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith(
        '[WorkspaceFileEditAttributionService] Listener attribution disabled for workspace:',
        expect.objectContaining({ filePath: '/workspace/src/app.ts' }),
      );
    });
    expect(matchWorkspaceFileEdit).not.toHaveBeenCalled();
    expect(addFileLink).not.toHaveBeenCalled();
  });

  // A disabled policy is only released by HooklessAgentFileWatcher.stopForSession,
  // and some turn exits never reach it. A policy left behind by a finished Codex
  // turn silenced Bash-edit attribution for every other session in the project
  // until restart.
  it('ignores a disabled policy whose session is no longer running', async () => {
    workspaceFileAttributionPolicy.set('finished-app-server-session', '/workspace', 'disabled');
    matchWorkspaceFileEdit.mockResolvedValue({ winner: null, candidates: [], reason: 'no-candidates' });

    workspaceFileEditAttributionService.ingestWatcherEvent({
      workspacePath: '/workspace',
      filePath: '/workspace/src/other.ts',
      timestamp: Date.now(),
      beforeContent: 'before',
    });

    await vi.waitFor(() => {
      expect(matchWorkspaceFileEdit).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: '/workspace/src/other.ts' }),
      );
    });
  });

  // Claude Code Bash edits are linked by hook windows. Its sessions remain
  // rivals for the matcher, but a fuzzy row for them would be a second guess.
  it('marks hook-window sessions ineligible to win and is not blanked by them', async () => {
    workspaceFileAttributionPolicy.set('legacy-session', '/workspace', 'shell-window');
    getRunningSessionIds.mockReturnValue(['legacy-session']);
    matchWorkspaceFileEdit.mockResolvedValue({ winner: null, candidates: [], reason: 'shell_window_owner' });

    workspaceFileEditAttributionService.ingestWatcherEvent({
      workspacePath: '/workspace', filePath: '/workspace/src/shell.ts', timestamp: Date.now(), beforeContent: 'before',
    });

    await vi.waitFor(() => {
      expect(matchWorkspaceFileEdit).toHaveBeenCalledWith(expect.objectContaining({
        filePath: '/workspace/src/shell.ts',
        ineligibleSessionIds: ['legacy-session'],
      }));
    });
  });

  // A real edit in the same second as a build's output used to vanish with it.
  it('defers an over-budget event and processes it once tokens refill', async () => {
    matchWorkspaceFileEdit.mockResolvedValue({ winner: null, candidates: [], reason: 'no-candidates' });
    throttle.tryAcquire.mockReturnValueOnce(false);

    workspaceFileEditAttributionService.ingestWatcherEvent({
      workspacePath: '/workspace', filePath: '/workspace/src/deferred.ts', timestamp: Date.now(), beforeContent: 'before',
    });
    expect(matchWorkspaceFileEdit).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(matchWorkspaceFileEdit).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/workspace/src/deferred.ts' }));
    });
  });
});

/**
 * The already-landed guard suppresses a pending tag for content a merge or
 * checkout has already written. It has to ask git about the repo that owns the
 * file: a project can span several folders, and a root can be a container of
 * checkouts rather than a repo itself, so relativizing against the workspace
 * path answers about the wrong repo — or, when the root has no `.git` at all,
 * answers nothing and turns the guard into a permanent no-op.
 */
describe('WorkspaceFileEditAttributionService.alreadyLandedInGit', () => {
  afterEach(() => {
    getGitFactsForFile.mockReset();
  });

  it('asks git about the file, not the workspace root', async () => {
    getGitFactsForFile.mockResolvedValue({ isTracked: true, isUncommitted: false });

    const landed = await (workspaceFileEditAttributionService as any).alreadyLandedInGit({
      workspacePath: '/proj/primary',
      filePath: '/elsewhere/attached-repo/src/a.ts',
      timestamp: Date.now(),
    });

    expect(getGitFactsForFile).toHaveBeenCalledWith('/elsewhere/attached-repo/src/a.ts');
    expect(landed).toBe(true);
  });

  it('does not claim a tracked-but-modified file has landed', async () => {
    getGitFactsForFile.mockResolvedValue({ isTracked: true, isUncommitted: true });

    await expect(
      (workspaceFileEditAttributionService as any).alreadyLandedInGit({
        workspacePath: '/proj/primary',
        filePath: '/proj/primary/src/a.ts',
        timestamp: Date.now(),
      }),
    ).resolves.toBe(false);
  });

  it('answers false when git could not answer, so a live diff is never suppressed', async () => {
    getGitFactsForFile.mockResolvedValue({ isTracked: null, isUncommitted: null });

    await expect(
      (workspaceFileEditAttributionService as any).alreadyLandedInGit({
        workspacePath: '/proj/primary',
        filePath: '/proj/primary/src/a.ts',
        timestamp: Date.now(),
      }),
    ).resolves.toBe(false);
  });
});
