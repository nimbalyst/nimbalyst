import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import simpleGit, { SimpleGit } from 'simple-git';
import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { clearGitStatusCache } from '../ipc/GitStatusHandlers';

interface WatcherEntry {
  refWatcher: FSWatcher;
  indexWatcher: FSWatcher;
  lastCommitHash: string;
  currentBranch: string;
  git: SimpleGit;
}

/**
 * Payload emitted when a new commit is detected on the current branch.
 * Available to both main-process subscribers (via onCommitDetected) and
 * renderer windows (via IPC 'git:commit-detected').
 */
export interface CommitDetectedEvent {
  workspacePath: string;
  commitHash: string;
  commitMessage: string;
  committedFiles: string[];
}

export type CommitDetectedListener = (event: CommitDetectedEvent) => void | Promise<void>;

interface GitDirInfo {
  /** The git directory for this workspace (worktree-specific for worktrees) */
  gitDir: string;
  /** The common git directory where refs/heads are stored (same as gitDir for regular repos) */
  commonDir: string;
}

/**
 * Resolve the git directories for a workspace.
 * In regular repos, both gitDir and commonDir are workspacePath/.git
 * In worktrees, gitDir is the worktree-specific dir, commonDir is the shared parent
 *
 * @param workspacePath - The workspace path to check
 * @returns GitDirInfo with both directories, or null if not a git repo
 */
async function resolveGitDirs(workspacePath: string): Promise<GitDirInfo | null> {
  const gitPath = path.join(workspacePath, '.git');

  try {
    const stat = await fs.promises.stat(gitPath);

    if (stat.isDirectory()) {
      // Regular git repository - gitDir and commonDir are the same
      return { gitDir: gitPath, commonDir: gitPath };
    }

    if (stat.isFile()) {
      // Worktree - .git is a file containing the gitdir path
      const content = await fs.promises.readFile(gitPath, 'utf-8');
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        let gitDir = match[1].trim();
        // The gitdir path may be relative or absolute
        if (!path.isAbsolute(gitDir)) {
          gitDir = path.resolve(workspacePath, gitDir);
        }

        // For worktrees, the commondir is in the gitDir/commondir file
        // This points to the shared .git directory where refs/heads are stored
        const commonDirFile = path.join(gitDir, 'commondir');
        try {
          const commonDirContent = await fs.promises.readFile(commonDirFile, 'utf-8');
          let commonDir = commonDirContent.trim();
          if (!path.isAbsolute(commonDir)) {
            commonDir = path.resolve(gitDir, commonDir);
          }
          return { gitDir, commonDir };
        } catch {
          // No commondir file - fall back to gitDir
          return { gitDir, commonDir: gitDir };
        }
      }
    }
  } catch {
    // Not a git repository or file doesn't exist
  }

  return null;
}

/**
 * GitRefWatcher watches .git/refs/heads/<branch> and .git/index to detect all git operations.
 *
 * This provides real-time git status updates by detecting:
 * - Commits (via .git/refs/heads/<branch> changes)
 * - Staging changes (via .git/index changes)
 *
 * When commits are detected, it auto-approves pending reviews for committed files.
 */
export class GitRefWatcher {
  // Map<workspacePath, WatcherEntry>
  private watchers = new Map<string, WatcherEntry>();

  // Debounce index changes to avoid rapid fire during staging operations
  private indexDebounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly INDEX_DEBOUNCE_MS = 100;

  // Main-process commit event listeners
  private commitListeners = new Set<CommitDetectedListener>();

  /**
   * Subscribe to commit events from the main process.
   * Use this instead of IPC when you need to react to commits
   * in a main-process service (e.g., CommitTrackerLinker).
   */
  onCommitDetected(listener: CommitDetectedListener): void {
    this.commitListeners.add(listener);
  }

  /**
   * Unsubscribe from commit events.
   */
  offCommitDetected(listener: CommitDetectedListener): void {
    this.commitListeners.delete(listener);
  }

  /**
   * Start watching a workspace for git state changes
   */
  async start(workspacePath: string): Promise<void> {
    // Already watching this workspace
    if (this.watchers.has(workspacePath)) {
      logger.main.debug('[GitRefWatcher] Already watching workspace:', path.basename(workspacePath));
      return;
    }

    try {
      // Resolve the git directories (handles worktrees where .git is a file)
      const gitDirs = await resolveGitDirs(workspacePath);

      if (!gitDirs) {
        // Not a git repository
        logger.main.debug('[GitRefWatcher] Not a git repository:', path.basename(workspacePath));
        return;
      }

      const { gitDir, commonDir } = gitDirs;

      const git: SimpleGit = simpleGit(workspacePath);

      // Pre-flight: get current branch + HEAD hash. Both can fail on a
      // fresh-init repo with zero commits ("fatal: your current branch X
      // does not have any commits yet"). Treat that as a known no-op rather
      // than logging the full stack trace, mirroring the detached-HEAD
      // short-circuit below.
      let currentBranch: string;
      let lastCommitHash: string;
      try {
        const status = await git.status();
        if (!status.current) {
          // Not on a branch (detached HEAD) - skip watching
          logger.main.info('[GitRefWatcher] Skipping detached HEAD workspace:', workspacePath);
          return;
        }
        currentBranch = status.current;

        const log = await git.log({ maxCount: 1 });
        lastCommitHash = log.latest?.hash || '';
      } catch (preflightError) {
        const msg = preflightError instanceof Error
          ? preflightError.message
          : String(preflightError);
        if (/does not have any commits yet/i.test(msg)) {
          logger.main.info(
            '[GitRefWatcher] Skipping workspace with no commits yet:',
            path.basename(workspacePath),
          );
          return;
        }
        throw preflightError;
      }

      // Watch refs/heads/<current-branch> for commit detection
      // Use commonDir for refs (in worktrees, refs are in the shared parent .git dir)
      const branchRefPath = path.join(commonDir, 'refs/heads', currentBranch);
      const refWatcher = chokidar.watch(branchRefPath, {
        ignoreInitial: true,
        persistent: true,
        usePolling: false,
        awaitWriteFinish: {
          stabilityThreshold: 50,
          pollInterval: 10,
        },
      });

      refWatcher.on('change', async () => {
        logger.main.info('[GitRefWatcher] Ref file changed:', {
          workspace: path.basename(workspacePath),
          branch: currentBranch,
        });
        await this.handleRefChange(workspacePath);
      });

      refWatcher.on('add', async () => {
        // Handle case where ref file is recreated (e.g., after branch switch)
        logger.main.info('[GitRefWatcher] Ref file added:', {
          workspace: path.basename(workspacePath),
          branch: currentBranch,
        });
        await this.handleRefChange(workspacePath);
      });

      refWatcher.on('error', (error) => {
        logger.main.error('[GitRefWatcher] Ref watcher error:', error);
      });

      // Watch index for staging changes
      // Use the resolved gitDir for the actual index file location
      const indexPath = path.join(gitDir, 'index');
      const indexWatcher = chokidar.watch(indexPath, {
        ignoreInitial: true,
        persistent: true,
        usePolling: false,
        awaitWriteFinish: {
          stabilityThreshold: 50,
          pollInterval: 10,
        },
      });

      indexWatcher.on('change', () => {
        this.handleIndexChangeDebounced(workspacePath);
      });

      indexWatcher.on('error', (error) => {
        logger.main.error('[GitRefWatcher] Index watcher error:', error);
      });

      this.watchers.set(workspacePath, {
        refWatcher,
        indexWatcher,
        lastCommitHash,
        currentBranch,
        git,
      });

      logger.main.info('[GitRefWatcher] Started watching:', {
        workspace: path.basename(workspacePath),
        branch: currentBranch,
        // Log if using worktree (gitDir != commonDir means refs are in a different location)
        isWorktree: gitDir !== commonDir ? true : undefined,
      });
    } catch (error) {
      logger.main.error('[GitRefWatcher] Failed to start watching:', error);
    }
  }

  /**
   * Stop watching a workspace
   */
  async stop(workspacePath: string): Promise<void> {
    const entry = this.watchers.get(workspacePath);
    if (entry) {
      await entry.refWatcher.close();
      await entry.indexWatcher.close();
      this.watchers.delete(workspacePath);

      // Clear any pending debounce timer
      const timer = this.indexDebounceTimers.get(workspacePath);
      if (timer) {
        clearTimeout(timer);
        this.indexDebounceTimers.delete(workspacePath);
      }

      logger.main.info('[GitRefWatcher] Stopped watching:', path.basename(workspacePath));
    }
  }

  /**
   * Stop watching all workspaces
   */
  async stopAll(): Promise<void> {
    logger.main.info(`[GitRefWatcher] Stopping all watchers (${this.watchers.size} active)`);

    const promises: Promise<void>[] = [];
    for (const workspacePath of this.watchers.keys()) {
      promises.push(this.stop(workspacePath));
    }
    await Promise.all(promises);

    logger.main.info('[GitRefWatcher] All watchers stopped');
  }

  /**
   * Handle .git/refs/heads/<branch> file changes (new commits)
   */
  private async handleRefChange(workspacePath: string): Promise<void> {
    try {
      const entry = this.watchers.get(workspacePath);
      if (!entry) return;

      // Get the latest commit
      const log = await entry.git.log({ maxCount: 1 });
      if (!log.latest) return;

      const newCommitHash = log.latest.hash;

      // If this is the same commit we already processed, skip
      if (entry.lastCommitHash === newCommitHash) {
        return;
      }

      logger.main.info('[GitRefWatcher] New commit detected:', {
        workspace: path.basename(workspacePath),
        hash: newCommitHash.slice(0, 7),
        message: log.latest.message?.substring(0, 50),
      });

      // Update our tracking
      const oldCommitHash = entry.lastCommitHash;
      entry.lastCommitHash = newCommitHash;

      // Get the files that were changed in this commit
      let committedFiles: string[] = [];
      try {
        // Handle initial commit case (no parent)
        const diffRef = oldCommitHash ? `${oldCommitHash}..${newCommitHash}` : newCommitHash;
        const diffSummary = await entry.git.diffSummary([diffRef]);
        committedFiles = diffSummary.files.map((file) =>
          path.join(workspacePath, file.file)
        );
      } catch (diffError) {
        // Fallback: just get the files from the latest commit
        try {
          const diffSummary = await entry.git.diffSummary([`${newCommitHash}~1`, newCommitHash]);
          committedFiles = diffSummary.files.map((file) =>
            path.join(workspacePath, file.file)
          );
        } catch {
          // Initial commit or other edge case - get files from show
          logger.main.warn('[GitRefWatcher] Could not get diff summary, skipping auto-approve');
        }
      }

      // logger.main.info('[GitRefWatcher] Committed files:', committedFiles.length);

      // Auto-approve pending reviews for committed files
      if (committedFiles.length > 0) {
        await this.autoApprovePendingReviews(workspacePath, committedFiles);
      }

      // Clear git status cache so next query gets fresh data
      clearGitStatusCache(workspacePath);

      // Notify main-process listeners (e.g., CommitTrackerLinker)
      const commitEvent: CommitDetectedEvent = {
        workspacePath,
        commitHash: newCommitHash,
        commitMessage: log.latest.message,
        committedFiles,
      };
      for (const listener of this.commitListeners) {
        try {
          Promise.resolve(listener(commitEvent)).catch((err) => {
            logger.main.error('[GitRefWatcher] Commit listener error:', err);
          });
        } catch (err) {
          logger.main.error('[GitRefWatcher] Commit listener error:', err);
        }
      }

      // Emit events to renderer windows for UI updates
      this.emitToAllWindows('git:commit-detected', commitEvent);

      this.emitToAllWindows('git:status-changed', {
        workspacePath,
      });
    } catch (error) {
      logger.main.error('[GitRefWatcher] Error handling ref change:', error);
    }
  }

  /**
   * Handle .git/index changes with debouncing
   */
  private handleIndexChangeDebounced(workspacePath: string): void {
    // Clear existing timer
    const existingTimer = this.indexDebounceTimers.get(workspacePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.indexDebounceTimers.delete(workspacePath);
      this.handleIndexChange(workspacePath);
    }, this.INDEX_DEBOUNCE_MS);

    this.indexDebounceTimers.set(workspacePath, timer);
  }

  /**
   * Handle .git/index changes (staging changes)
   */
  private handleIndexChange(workspacePath: string): void {
    // Clear git status cache so next query gets fresh data
    clearGitStatusCache(workspacePath);

    // Emit event to update UI
    this.emitToAllWindows('git:status-changed', {
      workspacePath,
    });
  }

  /**
   * Auto-approve pending reviews for committed files
   */
  private async autoApprovePendingReviews(
    workspacePath: string,
    committedFiles: string[]
  ): Promise<void> {
    try {
      const { historyManager } = await import('../HistoryManager');

      // logger.main.info('[GitRefWatcher] Auto-approving pending reviews for committed files:', {
      //   workspace: path.basename(workspacePath),
      //   fileCount: committedFiles.length,
      //   files: committedFiles.map(f => path.basename(f)),
      // });

      let approvedCount = 0;
      for (const filePath of committedFiles) {
        const pendingTags = await historyManager.getPendingTags(filePath);

        logger.main.debug('[GitRefWatcher] Checking file for pending tags:', {
          file: path.basename(filePath),
          fullPath: filePath,
          pendingTagCount: pendingTags.length,
        });

        if (pendingTags.length > 0) {
          // logger.main.info('[GitRefWatcher] Auto-approving pending review:', {
          //   file: path.basename(filePath),
          //   tags: pendingTags.length,
          //   tagIds: pendingTags.map(t => t.id),
          // });

          for (const tag of pendingTags) {
            await historyManager.updateTagStatus(filePath, tag.id, 'reviewed', workspacePath);
            approvedCount++;
          }
        }
      }

      if (approvedCount > 0) {
        logger.main.info('[GitRefWatcher] Auto-approved pending reviews:', {
          workspace: path.basename(workspacePath),
          count: approvedCount,
        });

        // Emit pending count changed event to update UI
        // The historyManager.updateTagStatus already emits this, but we emit
        // a final one to ensure the UI is up to date
        const count = await historyManager.getPendingCount(workspacePath);
        this.emitToAllWindows('history:pending-count-changed', {
          workspacePath,
          count,
        });
      } else {
        logger.main.info('[GitRefWatcher] No pending reviews found for committed files');
      }
    } catch (error) {
      logger.main.error('[GitRefWatcher] Error auto-approving pending reviews:', error);
    }
  }

  /**
   * Emit an event to all browser windows
   */
  private emitToAllWindows(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, data);
      }
    }
  }

  /**
   * Get statistics for debugging
   */
  getStats(): { type: string; activeWatchers: number; workspaces: string[] } {
    return {
      type: 'GitRefWatcher',
      activeWatchers: this.watchers.size,
      workspaces: Array.from(this.watchers.keys()).map((p) => path.basename(p)),
    };
  }
}

export const gitRefWatcher = new GitRefWatcher();
