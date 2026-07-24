/**
 * GitWorktreeService - Manages git worktree operations
 *
 * Provides methods to create, delete, and query git worktrees using simple-git.
 * Worktrees are parallel working directories that share the same git repository.
 *
 * CROSS-PLATFORM NOTES:
 * - Git internally uses forward slashes (/) for paths in all output, even on Windows
 * - All git command output (diff, status, log) returns paths with forward slashes
 * - Manual diff generation also uses forward slashes to match git's format
 * - Local file operations use path.join() for platform-specific path separators
 * - This design ensures consistent diff output across all platforms
 */

import simpleGit, { SimpleGit } from 'simple-git';
import { simpleGitWithHookEnv } from './gitEnv';
import * as path from 'path';
import * as fs from 'fs';
import { ulid } from 'ulid';
import log from 'electron-log/main';
import { getUntrackedFilesInDirectory } from '../utils/gitUtils';
import { gitOperationLock } from './GitOperationLock';

const logger = log.scope('GitWorktreeService');

/**
 * Thrown when a workspace's git repository has no commits yet, so HEAD
 * does not resolve to a tree-ish. Worktree operations cannot proceed.
 */
export class WorkspaceHasNoCommitsError extends Error {
  constructor(workspacePath: string) {
    super(
      `Workspace '${workspacePath}' has no commits yet, so worktrees cannot be created. ` +
      `Make an initial commit, or open a different folder that already has commits.`
    );
    this.name = 'WorkspaceHasNoCommitsError';
  }
}

/**
 * Worktree data structure (matches runtime types)
 */
export interface Worktree {
  id: string;
  name: string;
  path: string;
  branch: string;
  baseBranch: string;
  projectPath: string;
  createdAt: number;
}

/**
 * Git status summary for a worktree
 */
export interface WorktreeStatus {
  hasUncommittedChanges: boolean;
  modifiedFileCount: number;
  commitsAhead: number;
  commitsBehind: number;
  isMerged: boolean;
  /**
   * Number of commits that are truly unique to this branch (no equivalent on base).
   * Uses git cherry to compare by patch content rather than hash.
   * When undefined, uniqueCommitsAhead equals commitsAhead.
   */
  uniqueCommitsAhead?: number;
}

/**
 * Diff result for a file
 */
export interface FileDiffResult {
  filePath: string;
  diff: string;
  oldContent: string;
  newContent: string;
  status: 'added' | 'modified' | 'deleted';
}

/**
 * Commit information
 */
export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: Date;
  files: string[];
  /**
   * True if an equivalent commit (same patch content) exists on the base branch.
   * These commits will be skipped during rebase.
   */
  hasEquivalentOnBase?: boolean;
}

/**
 * Result of a merge operation
 */
export interface MergeResult {
  success: boolean;
  message: string;
  conflictedFiles?: string[];
  /**
   * True if the operation succeeded but stash pop failed after completion.
   * When set, the user's changes are still in the stash and need manual recovery.
   */
  stashWarning?: boolean;
}

/**
 * Options for creating a worktree
 */
export interface CreateWorktreeOptions {
  name?: string; // Optional custom name (defaults to random adjective-noun)
  baseBranch?: string; // Branch to base the worktree on (defaults to repo root's current branch)
}

/**
 * Result of worktree validation check
 */
export interface WorktreeValidationResult {
  valid: boolean;
  issues: string[];
}

/**
 * Git state information
 */
export interface GitState {
  isClean: boolean;
  inMerge: boolean;
  inRebase: boolean;
  inCherryPick: boolean;
  inRevert: boolean;
  conflictedFiles: string[];
}

/**
 * Service for managing git worktrees
 */
export class GitWorktreeService {
  /**
   * Validate that a worktree is in a healthy state.
   *
   * Checks:
   * 1. Directory exists on disk
   * 2. .git file exists in the directory
   * 3. git rev-parse --is-inside-work-tree succeeds
   * 4. The expected branch exists (if provided)
   *
   * @param worktreePath - Path to the worktree directory
   * @param expectedBranch - Optional branch name that should exist
   * @returns Validation result with valid flag and list of issues
   */
  async validateWorktree(worktreePath: string, expectedBranch?: string): Promise<WorktreeValidationResult> {
    const issues: string[] = [];

    try {
      logger.info('Validating worktree', { worktreePath, expectedBranch });

      // Check 1: Directory exists
      if (!fs.existsSync(worktreePath)) {
        issues.push(`Directory does not exist: ${worktreePath}`);
        return { valid: false, issues };
      }

      // Check 2: .git file exists (worktrees have a .git file, not a .git directory)
      const gitFilePath = path.join(worktreePath, '.git');
      if (!fs.existsSync(gitFilePath)) {
        issues.push(`.git file/directory missing at ${gitFilePath}`);
        return { valid: false, issues };
      }

      // Check 3: git rev-parse --is-inside-work-tree succeeds
      const git: SimpleGit = simpleGit(worktreePath);
      try {
        const isWorkTree = await git.revparse(['--is-inside-work-tree']);
        if (isWorkTree.trim() !== 'true') {
          issues.push('git rev-parse --is-inside-work-tree did not return true');
        }
      } catch (revParseError) {
        issues.push(`git rev-parse failed: ${revParseError instanceof Error ? revParseError.message : String(revParseError)}`);
      }

      // Check 4: Expected branch exists (if provided)
      if (expectedBranch) {
        try {
          const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
          if (currentBranch.trim() !== expectedBranch) {
            // Branch exists but isn't the current one - this might be okay
            // Let's check if the branch actually exists
            try {
              await git.raw(['rev-parse', '--verify', expectedBranch]);
              // Branch exists, just not checked out - add a warning but not critical
              logger.info('Worktree is on different branch than expected', {
                worktreePath,
                currentBranch: currentBranch.trim(),
                expectedBranch,
              });
            } catch {
              issues.push(`Expected branch '${expectedBranch}' does not exist`);
            }
          }
        } catch (branchError) {
          issues.push(`Failed to check branch: ${branchError instanceof Error ? branchError.message : String(branchError)}`);
        }
      }

      const valid = issues.length === 0;

      if (!valid) {
        logger.warn('Worktree validation failed', { worktreePath, issues });
      } else {
        logger.info('Worktree validation passed', { worktreePath });
      }

      return { valid, issues };
    } catch (error) {
      logger.error('Worktree validation encountered unexpected error', { error, worktreePath });
      issues.push(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      return { valid: false, issues };
    }
  }

  /**
   * Create a new git worktree
   *
   * Creates a new worktree in the default worktrees directory:
   * ../<project_name>_worktrees/<worktree_name>
   *
   * @param workspacePath - Path to the main git repository
   * @param options - Optional configuration
   * @returns Worktree data
   */
  async createWorktree(workspacePath: string, options: CreateWorktreeOptions = {}): Promise<Worktree> {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    // Use centralized lock to prevent concurrent worktree operations
    return gitOperationLock.withLock(workspacePath, 'createWorktree', () =>
      this.createWorktreeImpl(workspacePath, options)
    );
  }

  /**
   * Internal implementation of createWorktree (called within lock)
   */
  private async createWorktreeImpl(workspacePath: string, options: CreateWorktreeOptions): Promise<Worktree> {
    logger.info('Creating worktree', { workspacePath, options });

    // Ensure this is a git repository
    const git: SimpleGit = simpleGit(workspacePath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error(`Not a git repository: ${workspacePath}`);
    }

    // Generate unique worktree name if not provided
    const worktreeName = options.name || this.generateWorktreeName();
    logger.info('Generated worktree name', { worktreeName });

    // Determine base branch - use the repo root's current branch (not hardcoded)
    let baseBranch: string;
    if (options.baseBranch) {
      baseBranch = options.baseBranch;
    } else {
      // Get the current branch of the repo root
      baseBranch = await this.getCurrentBranch(git);
    }
    logger.info('Using base branch', { baseBranch });

    // Create worktrees directory if it doesn't exist
    const projectName = path.basename(workspacePath);
    const worktreesDir = path.resolve(workspacePath, '..', `${projectName}_worktrees`);

    if (!fs.existsSync(worktreesDir)) {
      logger.info('Creating worktrees directory', { worktreesDir });
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    // Full path to new worktree (handle duplicates with incrementing numbers)
    let worktreePath = path.join(worktreesDir, worktreeName);
    let finalWorktreeName = worktreeName;
    let counter = 1;

    // If path exists, append incrementing number until we find an available path
    while (fs.existsSync(worktreePath)) {
      finalWorktreeName = `${worktreeName}-${counter}`;
      worktreePath = path.join(worktreesDir, finalWorktreeName);
      counter++;
    }

    if (counter > 1) {
      logger.info('Worktree path already existed, using incremented name', {
        originalName: worktreeName,
        finalName: finalWorktreeName
      });
    }

    // Create a new branch name for this worktree (ensure uniqueness)
    const branchName = `worktree/${finalWorktreeName}`;

    try {
      // Create the worktree with a new branch
      logger.info('Creating git worktree', { worktreePath, branchName, baseBranch });
      await git.raw(['worktree', 'add', '-b', branchName, worktreePath, baseBranch]);

      logger.info('Worktree created successfully', { worktreePath });

      // Return worktree data
      const worktree: Worktree = {
        id: ulid(),
        name: finalWorktreeName,
        path: worktreePath,
        branch: branchName,
        baseBranch,
        projectPath: workspacePath,
        createdAt: Date.now(),
      };

      return worktree;
    } catch (error) {
      logger.error('Failed to create worktree', { error, worktreePath, branchName });

      // Clean up if worktree directory was created but git command failed
      if (fs.existsSync(worktreePath)) {
        try {
          fs.rmSync(worktreePath, { recursive: true, force: true });
          logger.info('Cleaned up failed worktree directory', { worktreePath });
        } catch (cleanupError) {
          logger.warn('Failed to clean up worktree directory', { cleanupError, worktreePath });
        }
      }

      throw new Error(`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get the status of a worktree compared to its base branch
   *
   * @param worktreePath - Path to the worktree
   * @returns Status summary
   */
  async getWorktreeStatus(worktreePath: string, baseBranchOverride?: string): Promise<WorktreeStatus> {
    if (!worktreePath) {
      throw new Error('worktreePath is required');
    }

    // logger.info('Getting worktree status', { worktreePath, baseBranchOverride });

    const git: SimpleGit = simpleGit(worktreePath);

    try {
      // git.status() already provides the current branch via .current,
      // so we skip the separate git.revparse(['--abbrev-ref', 'HEAD']) call
      const status = await git.status();
      const currentBranch = status.current;
      const hasUncommittedChanges = !status.isClean();
      const modifiedFileCount = status.files.length;

      if (!currentBranch) {
        // Detached HEAD -- return basic status without branch comparison
        return {
          hasUncommittedChanges,
          modifiedFileCount,
          commitsAhead: 0,
          commitsBehind: 0,
          isMerged: false,
        };
      }

      // Use provided base branch (from database) or fall back to inferring
      const baseBranch = baseBranchOverride || await this.inferBaseBranch(git);

      // Get commits ahead/behind base branch
      let commitsAhead = 0;
      let commitsBehind = 0;
      let isMerged = false;
      let uniqueCommitsAhead: number | undefined;

      try {
        const revList = await git.raw(['rev-list', '--left-right', '--count', `${baseBranch}...${currentBranch}`]);
        const [behind, ahead] = revList.trim().split('\t').map(Number);
        commitsBehind = behind || 0;
        commitsAhead = ahead || 0;

        // Check if branch is merged (use -a to include remote tracking branches)
        const mergedBranches = await git.raw(['branch', '-a', '--merged', baseBranch]);
        isMerged = mergedBranches.includes(currentBranch);

        // Use git cherry to find truly unique commits (by patch content, not hash)
        // This handles cases where commits were rebased and have different hashes
        // but the same content on both branches
        if (commitsAhead > 0) {
          try {
            const cherryResult = await git.raw(['cherry', baseBranch, currentBranch]);
            // Lines starting with '+' are unique, '-' means equivalent exists on base
            const uniqueCount = cherryResult.split('\n').filter(line => line.startsWith('+')).length;
            // Only set if different from commitsAhead (indicates duplicates exist)
            if (uniqueCount !== commitsAhead) {
              uniqueCommitsAhead = uniqueCount;
            }
          } catch (cherryError) {
            // git cherry can fail in some edge cases, just skip unique counting
            logger.warn('Failed to count unique commits with git cherry', { cherryError });
          }
        }
      } catch (error) {
        logger.warn('Failed to get ahead/behind counts', { error });
        // Continue with default values
      }

      return {
        hasUncommittedChanges,
        modifiedFileCount,
        commitsAhead,
        commitsBehind,
        isMerged,
        uniqueCommitsAhead,
      };
    } catch (error) {
      logger.error('Failed to get worktree status', { error, worktreePath });
      throw new Error(`Failed to get worktree status: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete a worktree and its branch
   *
   * @param worktreePath - Path to the worktree to delete
   * @param workspacePath - Path to the main repository (needed for git operations)
   * @throws Error if the worktree directory still exists after all cleanup attempts
   */
  async deleteWorktree(worktreePath: string, workspacePath: string): Promise<void> {
    if (!worktreePath) {
      throw new Error('worktreePath is required');
    }
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    // Use centralized lock on workspace to prevent concurrent worktree operations
    return gitOperationLock.withLock(workspacePath, 'deleteWorktree', () =>
      this.deleteWorktreeImpl(worktreePath, workspacePath)
    );
  }

  /**
   * Internal implementation of deleteWorktree (called within lock)
   */
  private async deleteWorktreeImpl(worktreePath: string, workspacePath: string): Promise<void> {
    logger.info('Deleting worktree', { worktreePath, workspacePath });

    const git: SimpleGit = simpleGit(workspacePath);
    let branchName: string | null = null;

    // Step 1: Get the branch name before removing (best effort)
    if (fs.existsSync(worktreePath)) {
      try {
        const worktreeGit: SimpleGit = simpleGit(worktreePath);
        branchName = await worktreeGit.revparse(['--abbrev-ref', 'HEAD']);
        logger.info('Found branch for worktree', { branchName });
      } catch (error) {
        logger.warn('Failed to get branch name, continuing with worktree removal', { error });
      }
    }

    // Step 2: Try git worktree remove first (the clean way)
    let gitRemoveSucceeded = false;
    try {
      await git.raw(['worktree', 'remove', worktreePath, '--force']);
      logger.info('Git worktree remove succeeded', { worktreePath });
      gitRemoveSucceeded = true;
    } catch (error) {
      logger.warn('Git worktree remove failed, will try fallback cleanup', { error, worktreePath });
    }

    // Step 3: If git worktree remove failed or directory still exists, try fallbacks
    if (fs.existsSync(worktreePath)) {
      logger.info('Worktree directory still exists, attempting fallback cleanup', { worktreePath });

      // Fallback 1: Try git worktree prune to clean up stale worktree entries
      try {
        await git.raw(['worktree', 'prune']);
        logger.info('Git worktree prune completed', { workspacePath });
      } catch (pruneError) {
        logger.warn('Git worktree prune failed', { pruneError });
      }

      // Fallback 2: Force remove the directory with fs.rm
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        logger.info('Fallback fs.rmSync succeeded', { worktreePath });
      } catch (fsError) {
        logger.error('Fallback fs.rmSync failed', { fsError, worktreePath });
      }
    }

    // Step 4: Final verification - the directory MUST be gone
    if (fs.existsSync(worktreePath)) {
      const errorMsg = `Failed to delete worktree directory: ${worktreePath} still exists after all cleanup attempts`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    logger.info('Worktree directory confirmed deleted', { worktreePath });

    // Step 5: Delete the branch if we found it (best effort, don't fail if this doesn't work)
    if (branchName && branchName !== 'HEAD') {
      try {
        await git.deleteLocalBranch(branchName, true); // force delete
        logger.info('Branch deleted', { branchName });
      } catch (error) {
        logger.warn('Failed to delete branch', { error, branchName });
        // Continue even if branch deletion fails - the important part (directory removal) succeeded
      }
    }

    // Step 6: Run a final prune to clean up any stale worktree references
    if (!gitRemoveSucceeded) {
      try {
        await git.raw(['worktree', 'prune']);
        logger.info('Final git worktree prune completed');
      } catch (pruneError) {
        logger.warn('Final git worktree prune failed', { pruneError });
      }
    }

    // Step 7: Verify the worktree is no longer in git's list
    try {
      const worktrees = await this.listWorktrees(workspacePath);
      const stillInList = worktrees.some(wt => wt.path === worktreePath);

      if (stillInList) {
        // Try one more prune
        logger.warn('Worktree still in git list after deletion, attempting final prune', { worktreePath });
        await git.raw(['worktree', 'prune']);

        // Check again
        const worktreesAfterPrune = await this.listWorktrees(workspacePath);
        const stillInListAfterPrune = worktreesAfterPrune.some(wt => wt.path === worktreePath);

        if (stillInListAfterPrune) {
          const errorMsg = `Worktree ${worktreePath} still in git worktree list after deletion. Git index may be corrupted.`;
          logger.error(errorMsg, {
            worktreePath,
            remainingWorktrees: worktreesAfterPrune.map(wt => wt.path),
          });
          throw new Error(errorMsg);
        }
      }

      logger.info('Verified worktree is no longer in git list', { worktreePath });
    } catch (verifyError) {
      // Only throw if it's our specific verification error
      if (verifyError instanceof Error && verifyError.message.includes('still in git worktree list')) {
        throw verifyError;
      }
      // For other errors (like listWorktrees failure), just log a warning
      logger.warn('Could not verify worktree removal from git list', { worktreePath, error: verifyError });
    }

    logger.info('Worktree deletion complete', { worktreePath });
  }

  /**
   * List all worktrees for a repository
   *
   * @param workspacePath - Path to the main git repository
   * @returns Array of worktree paths and branches
   */
  async listWorktrees(workspacePath: string): Promise<Array<{ path: string; branch: string; isMain: boolean }>> {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    // logger.info('Listing worktrees', { workspacePath });

    const git: SimpleGit = simpleGit(workspacePath);

    try {
      // Get worktree list in porcelain format
      const output = await git.raw(['worktree', 'list', '--porcelain']);

      const worktrees: Array<{ path: string; branch: string; isMain: boolean }> = [];
      let currentPath: string | null = null;
      let currentBranch: string | null = null;
      let isMain = false;

      // Parse porcelain output
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          currentPath = line.substring('worktree '.length).trim();
          isMain = false; // Will be set by 'HEAD' or 'branch' line
        } else if (line.startsWith('HEAD ')) {
          isMain = true; // Main worktree
        } else if (line.startsWith('branch ')) {
          currentBranch = line.substring('branch '.length).replace('refs/heads/', '').trim();
        } else if (line === '' && currentPath) {
          // End of worktree entry
          worktrees.push({
            path: currentPath,
            branch: currentBranch || 'HEAD',
            isMain,
          });
          currentPath = null;
          currentBranch = null;
          isMain = false;
        }
      }

      // logger.info('Found worktrees', { count: worktrees.length });
      return worktrees;
    } catch (error) {
      logger.error('Failed to list worktrees', { error, workspacePath });
      throw new Error(`Failed to list worktrees: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate a random worktree name using adjective-noun pattern
   * @private
   */
  private generateWorktreeName(): string {
    // 128 adjectives x 128 nouns = 16,384 combinations
    const adjectives = [
      // Nature/weather (16)
      'swift', 'bright', 'calm', 'cool', 'warm', 'clear', 'wild', 'crisp',
      'fresh', 'misty', 'sunny', 'windy', 'frosty', 'dusty', 'hazy', 'foggy',
      // Character traits (16)
      'bold', 'brave', 'keen', 'wise', 'kind', 'fair', 'quick', 'clever',
      'sharp', 'neat', 'steady', 'loyal', 'humble', 'noble', 'proud', 'silent',
      // Colors/appearance (16)
      'golden', 'silver', 'copper', 'amber', 'azure', 'coral', 'ivory', 'jade',
      'ruby', 'onyx', 'pearl', 'rusty', 'mossy', 'sandy', 'snowy', 'dusky',
      // Size/intensity (16)
      'vast', 'tiny', 'grand', 'mighty', 'gentle', 'fierce', 'subtle', 'vivid',
      'dense', 'sparse', 'ample', 'narrow', 'broad', 'steep', 'hollow', 'solid',
      // Time/age (16)
      'ancient', 'young', 'ageless', 'early', 'late', 'timely', 'lasting', 'brief',
      'sudden', 'gradual', 'constant', 'fleeting', 'endless', 'daily', 'nightly', 'weekly',
      // Texture/material (16)
      'smooth', 'rough', 'soft', 'hard', 'silky', 'velvet', 'glossy', 'matte',
      'grainy', 'polished', 'woven', 'carved', 'molten', 'frozen', 'liquid', 'crystal',
      // Sound/movement (16)
      'quiet', 'loud', 'still', 'moving', 'dancing', 'flowing', 'rushing', 'gliding',
      'soaring', 'drifting', 'spinning', 'rolling', 'leaping', 'resting', 'humming', 'singing',
      // Abstract qualities (16)
      'pure', 'true', 'deep', 'light', 'dark', 'bright', 'dim', 'radiant',
      'serene', 'tranquil', 'vibrant', 'mellow', 'zesty', 'tangy', 'savory', 'earthy',
    ];

    const nouns = [
      // Birds (16)
      'falcon', 'hawk', 'eagle', 'raven', 'owl', 'crane', 'finch', 'sparrow',
      'heron', 'dove', 'lark', 'wren', 'robin', 'osprey', 'condor', 'cardinal',
      // Landforms (16)
      'mountain', 'valley', 'canyon', 'glacier', 'ridge', 'cliff', 'mesa', 'dune',
      'summit', 'crater', 'bluff', 'gorge', 'basin', 'plateau', 'ravine', 'slope',
      // Water features (16)
      'river', 'stream', 'brook', 'creek', 'lake', 'pond', 'spring', 'bay',
      'cove', 'delta', 'marsh', 'reef', 'tide', 'wave', 'rapids', 'falls',
      // Sky/weather (16)
      'cloud', 'storm', 'thunder', 'wind', 'star', 'moon', 'dawn', 'dusk',
      'aurora', 'comet', 'nova', 'nebula', 'zenith', 'horizon', 'gale', 'breeze',
      // Trees/plants (16)
      'oak', 'pine', 'cedar', 'maple', 'birch', 'willow', 'aspen', 'spruce',
      'elm', 'ash', 'fern', 'moss', 'ivy', 'lotus', 'orchid', 'bamboo',
      // Animals (16)
      'wolf', 'fox', 'bear', 'deer', 'elk', 'moose', 'lynx', 'otter',
      'badger', 'beaver', 'marten', 'ferret', 'mink', 'stoat', 'hare', 'vole',
      // Terrain features (16)
      'path', 'trail', 'pass', 'ford', 'bridge', 'gate', 'arch', 'tower',
      'spire', 'beacon', 'cairn', 'haven', 'grove', 'glade', 'dell', 'hollow',
      // Elements/minerals (16)
      'stone', 'flint', 'quartz', 'granite', 'marble', 'obsidian', 'basalt', 'shale',
      'ember', 'flame', 'spark', 'frost', 'mist', 'vapor', 'smoke', 'shadow',
    ];

    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];

    return `${adjective}-${noun}`;
  }

  /**
   * Throws WorkspaceHasNoCommitsError if the repo's HEAD does not resolve
   * to a commit. This is the empty-repo case (`git init` ran, no commits).
   * Cheap pre-flight that lets callers fail fast with a friendly message
   * before any worktree-record or session-row gets created.
   */
  async validateWorkspaceHasCommits(workspacePath: string): Promise<void> {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    // Differentiate "not a git repo at all" from "git repo with no commits".
    // simple-git's checkIsRepo defaults to IN_TREE which walks UP the directory
    // tree and would return true if any ancestor has a .git. We need the
    // workspacePath itself to be the repo root for worktree ops, so do a
    // direct fs check for `.git` (file or directory - submodules use a file).
    const gitMeta = path.join(workspacePath, '.git');
    if (!fs.existsSync(gitMeta)) {
      throw new Error(`Not a git repository: ${workspacePath}`);
    }
    const git: SimpleGit = simpleGit(workspacePath);
    try {
      await git.raw(['rev-parse', '--verify', 'HEAD']);
    } catch {
      throw new WorkspaceHasNoCommitsError(workspacePath);
    }
  }

  /**
   * Get the current branch of a git repository (private helper)
   * @private
   */
  private async getCurrentBranch(git: SimpleGit): Promise<string> {
    try {
      const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
      return branch.trim();
    } catch (error) {
      logger.error('Failed to get current branch', { error });
      const message = error instanceof Error ? error.message : String(error);
      // Recognize the empty-repo failure mode and rethrow as a typed error
      // so callers can show a friendly message. Git emits this stderr when
      // HEAD points at a symbolic ref whose target does not exist (no commits).
      if (message.includes("ambiguous argument 'HEAD'")) {
        throw new WorkspaceHasNoCommitsError('repository');
      }
      throw new Error(`Failed to get current branch: ${message}`);
    }
  }

  /**
   * Get all local branch names (for de-duplication when creating worktrees)
   *
   * @param workspacePath - Path to the git repository
   * @returns Set of branch names (without refs/heads/ prefix)
   */
  async getAllBranchNames(workspacePath: string): Promise<Set<string>> {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    // logger.info('Getting all branch names', { workspacePath });

    const git: SimpleGit = simpleGit(workspacePath);

    try {
      // Get all local branches
      const branchSummary = await git.branchLocal();
      const branchNames = new Set<string>();

      for (const branchName of branchSummary.all) {
        branchNames.add(branchName);

        // Also extract worktree name from worktree branches (worktree/name -> name)
        if (branchName.startsWith('worktree/')) {
          branchNames.add(branchName.substring('worktree/'.length));
        }
      }

      // logger.info('Found branch names', { count: branchNames.size });
      return branchNames;
    } catch (error) {
      logger.error('Failed to get branch names', { error, workspacePath });
      throw new Error(`Failed to get branch names: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get all directory names in the worktrees directory (for de-duplication)
   *
   * @param workspacePath - Path to the main git repository
   * @returns Set of existing worktree directory names
   */
  getExistingWorktreeDirectories(workspacePath: string): Set<string> {
    const projectName = path.basename(workspacePath);
    const worktreesDir = path.resolve(workspacePath, '..', `${projectName}_worktrees`);

    const names = new Set<string>();

    if (fs.existsSync(worktreesDir)) {
      try {
        const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            names.add(entry.name);
          }
        }
        logger.info('Found existing worktree directories', { count: names.size, worktreesDir });
      } catch (error) {
        logger.warn('Failed to read worktrees directory', { error, worktreesDir });
      }
    }

    return names;
  }

  /**
   * Generate a unique worktree name that doesn't conflict with existing names
   *
   * @param existingNames - Set of names that are already taken (from db, filesystem, branches)
   * @returns A unique worktree name
   */
  generateUniqueWorktreeName(existingNames: Set<string>): string {
    const maxAttempts = 100; // Prevent infinite loop

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const name = this.generateWorktreeName();

      if (!existingNames.has(name)) {
        logger.info('Generated unique worktree name', { name, attempts: attempt + 1 });
        return name;
      }
    }

    // Fallback: append timestamp if we can't find a unique name after many attempts
    const fallbackName = `${this.generateWorktreeName()}-${Date.now()}`;
    logger.warn('Could not find unique name after max attempts, using timestamp fallback', {
      fallbackName,
      existingNamesCount: existingNames.size,
    });
    return fallbackName;
  }

  /**
   * Get the current branch of a repository by path.
   * Public method for use by IPC handlers.
   *
   * @param repoPath - Path to the git repository
   * @returns Current branch name
   */
  async getRepoCurrentBranch(repoPath: string): Promise<string> {
    if (!repoPath) {
      throw new Error('repoPath is required');
    }

    const git: SimpleGit = simpleGit(repoPath);
    return this.getCurrentBranch(git);
  }

  /**
   * Get the base branch for a worktree by reading it from the main repo's current branch.
   * This ensures worktree operations are always relative to the repo root's current branch.
   * @private
   */
  private async inferBaseBranch(git: SimpleGit): Promise<string> {
    // Get the current branch - this is the source of truth
    return this.getCurrentBranch(git);
  }

  /**
   * Validate file path to prevent path traversal and command injection
   * @private
   */
  private validateFilePath(filePath: string): void {
    // Check for null bytes (command injection)
    if (filePath.includes('\0')) {
      throw new Error('Invalid file path: contains null bytes');
    }

    // Check for path traversal attempts
    const normalized = path.normalize(filePath);
    if (normalized.startsWith('..') || normalized.includes('/../')) {
      throw new Error('Invalid file path: path traversal detected');
    }

    // Check for absolute paths (should be relative)
    if (path.isAbsolute(filePath)) {
      throw new Error('Invalid file path: must be relative');
    }
  }

  /**
   * Check the git state of a repository to detect if it's in the middle of a merge, rebase, or other operation
   *
   * @param repoPath - Path to the git repository
   * @returns Git state information
   */
  async checkGitState(repoPath: string): Promise<GitState> {
    if (!repoPath) {
      throw new Error('repoPath is required');
    }

    // logger.info('Checking git state', { repoPath });

    const gitDir = path.join(repoPath, '.git');
    const git: SimpleGit = simpleGit(repoPath);

    try {
      const status = await git.status();

      // Check for various git states by looking for specific files in .git directory
      const inMerge = fs.existsSync(path.join(gitDir, 'MERGE_HEAD'));
      // Note: REBASE_HEAD alone is NOT sufficient - it can be a stale leftover.
      // Git tracks active rebases via rebase-merge/ or rebase-apply/ directories.
      const inRebase = fs.existsSync(path.join(gitDir, 'rebase-merge')) ||
                       fs.existsSync(path.join(gitDir, 'rebase-apply'));
      const inCherryPick = fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'));
      const inRevert = fs.existsSync(path.join(gitDir, 'REVERT_HEAD'));

      // isClean means no in-progress operations (not about uncommitted files)
      const isClean = !inMerge && !inRebase && !inCherryPick && !inRevert;
      const conflictedFiles = status.conflicted || [];

      const state: GitState = {
        isClean,
        inMerge,
        inRebase,
        inCherryPick,
        inRevert,
        conflictedFiles,
      };

      // logger.info('Git state check complete', { state });
      return state;
    } catch (error) {
      logger.error('Failed to check git state', { error, repoPath });
      throw new Error(`Failed to check git state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if stashing would succeed or fail due to conflicts
   * Returns an array of files that would cause stash to fail
   *
   * IMPORTANT: Git stashes are stored in .git/refs/stash and are SHARED across all worktrees.
   * This means:
   * 1. A stash created in one worktree is visible in all worktrees
   * 2. Stash operations in different worktrees can interfere with each other
   * 3. Always check for stash conflicts before attempting to stash
   * 4. Be careful when popping stashes - verify you're in the correct worktree
   *
   * The stash stores the branch name with each stash entry, which helps track which
   * worktree a stash came from, but concurrent stash operations across worktrees
   * should be avoided.
   *
   * @param repoPath - Path to the git repository
   * @returns Array of problematic files, or empty array if stash would succeed
   */
  async checkStashConflicts(repoPath: string): Promise<string[]> {
    if (!repoPath) {
      throw new Error('repoPath is required');
    }

    logger.info('Checking for potential stash conflicts', { repoPath });

    const git: SimpleGit = simpleGit(repoPath);

    try {
      // Get status to check for conflicted files
      const status = await git.status();

      // If there are conflicted files (needs merge), stash will fail
      if (status.conflicted && status.conflicted.length > 0) {
        logger.warn('Stash would fail due to conflicted files', { conflictedFiles: status.conflicted });
        return status.conflicted;
      }

      return [];
    } catch (error) {
      logger.error('Failed to check stash conflicts', { error, repoPath });
      throw new Error(`Failed to check stash conflicts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Safely pop a stash, cleaning up conflict markers if the pop fails.
   *
   * When git stash pop encounters conflicts, it leaves conflict markers
   * (<<<<<<< Updated upstream / ======= / >>>>>>> Stashed changes) in files
   * but does NOT consume the stash. This method detects that case and
   * restores the working directory to a clean state so the user doesn't
   * end up with unexpected conflict markers in their files.
   */
  private async safeStashPop(git: SimpleGit, context: string): Promise<void> {
    try {
      logger.info(`Restoring stashed changes after ${context}`);
      await git.stash(['pop']);
    } catch (popError) {
      logger.error(`Stash pop failed after ${context}, cleaning up conflict markers`, { popError });
      // git stash pop with conflicts leaves markers in files but doesn't consume the stash.
      // Clean up the working directory to remove conflict markers, restoring pre-operation state.
      // The stash remains on the stack so nothing is lost.
      try {
        await git.checkout(['.']);
        logger.info('Cleaned up conflict markers from failed stash pop. Stash is preserved on stack.');
      } catch (cleanupError) {
        logger.error('Failed to clean up conflict markers after failed stash pop', { cleanupError });
      }
    }
  }

  /**
   * Get diff for a specific file in a worktree
   *
   * @param worktreePath - Path to the worktree
   * @param filePath - Relative path to the file
   * @returns File diff result with old and new content
   */
  async getFileDiff(worktreePath: string, filePath: string, baseBranchOverride?: string): Promise<FileDiffResult> {
    if (!worktreePath) {
      throw new Error('worktreePath is required');
    }
    if (!filePath) {
      throw new Error('filePath is required');
    }

    // Validate file path for security
    this.validateFilePath(filePath);

    logger.info('Getting file diff', { worktreePath, filePath, baseBranchOverride });

    const git: SimpleGit = simpleGit(worktreePath);

    try {
      // Use provided base branch (from database) or fall back to inferring
      const baseBranch = baseBranchOverride || await this.inferBaseBranch(git);

      // Get old content from base branch
      let oldContent = '';
      let status: 'added' | 'modified' | 'deleted' = 'modified';

      try {
        oldContent = await git.show([`${baseBranch}:${filePath}`]);
      } catch {
        // File doesn't exist in base branch - it's a new file
        status = 'added';
      }

      // Get new content from current working tree
      let newContent = '';
      const absolutePath = path.join(worktreePath, filePath);
      try {
        if (fs.existsSync(absolutePath)) {
          newContent = fs.readFileSync(absolutePath, 'utf-8');
        } else {
          // File was deleted
          status = 'deleted';
        }
      } catch {
        status = 'deleted';
      }

      // Get the diff - use most efficient approach based on status
      let diff = '';

      // Try diff between base branch and HEAD (committed changes)
      try {
        diff = await git.diff([`${baseBranch}...HEAD`, '--', filePath]);
        if (diff.trim()) {
          // Found committed diff, return early
          return {
            filePath,
            diff,
            oldContent,
            newContent,
            status,
          };
        }
      } catch {
        // Ignore error, try next approach
      }

      // Check for uncommitted changes (working directory)
      try {
        diff = await git.diff(['--', filePath]);
        if (diff.trim()) {
          // Found working directory diff, return early
          return {
            filePath,
            diff,
            oldContent,
            newContent,
            status,
          };
        }
      } catch {
        // Ignore error
      }

      // Check staged changes
      try {
        diff = await git.diff(['--cached', '--', filePath]);
        if (diff.trim()) {
          // Found staged diff, return early
          return {
            filePath,
            diff,
            oldContent,
            newContent,
            status,
          };
        }
      } catch {
        // Ignore error
      }

      // If still no diff but file is new (untracked), generate a simple diff
      if (status === 'added' && newContent) {
        const lines = newContent.split('\n');
        diff = `diff --git a/${filePath} b/${filePath}
new file mode 100644
--- /dev/null
+++ b/${filePath}
@@ -0,0 +1,${lines.length} @@
${lines.map(line => '+' + line).join('\n')}`;

        return {
          filePath,
          diff,
          oldContent,
          newContent,
          status,
        };
      }

      // If file is deleted, generate deletion diff
      if (status === 'deleted' && oldContent) {
        const lines = oldContent.split('\n');
        diff = `diff --git a/${filePath} b/${filePath}
deleted file mode 100644
--- a/${filePath}
+++ /dev/null
@@ -1,${lines.length} +0,0 @@
${lines.map(line => '-' + line).join('\n')}`;

        return {
          filePath,
          diff,
          oldContent,
          newContent,
          status,
        };
      }

      // If we have both old and new content but still no diff, generate one
      if (oldContent !== newContent) {
        // Use git diff to generate the diff between old and new content
        try {
          diff = await git.diff([`${baseBranch}`, '--', filePath]);
          if (diff.trim()) {
            return {
              filePath,
              diff,
              oldContent,
              newContent,
              status,
            };
          }
        } catch {
          // Log warning and fall back to manual diff generation
          logger.warn('Git diff failed, generating manual diff', { filePath });

          // Generate a simple unified diff manually
          // Note: This is a crude fallback and may not be accurate for all cases
          const oldLines = oldContent.split('\n');
          const newLines = newContent.split('\n');
          diff = `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@ -1,${oldLines.length} +1,${newLines.length} @@
${oldLines.map(line => '-' + line).join('\n')}
${newLines.map(line => '+' + line).join('\n')}`;
        }
      }

      return {
        filePath,
        diff,
        oldContent,
        newContent,
        status,
      };
    } catch (error) {
      logger.error('Failed to get file diff', { error, worktreePath, filePath });
      throw new Error(`Failed to get file diff: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get commits in the worktree branch that are not in the base branch
   *
   * @param worktreePath - Path to the worktree
   * @returns Array of commit information
   */
  async getWorktreeCommits(worktreePath: string, baseBranchOverride?: string): Promise<CommitInfo[]> {
    if (!worktreePath) {
      throw new Error('worktreePath is required');
    }

    // logger.info('Getting worktree commits', { worktreePath, baseBranchOverride });

    const git: SimpleGit = simpleGit(worktreePath);

    try {
      // Get current branch and base branch
      const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      // Use provided base branch (from database) or fall back to inferring
      const baseBranch = baseBranchOverride || await this.inferBaseBranch(git);

      // Get commits with file information in a single command
      // Format: hash, short hash, subject, author, date, then files separated by NUL
      // Use %x00 (NUL) as delimiter to handle special characters in messages
      const logOutput = await git.raw([
        'log',
        `${baseBranch}..${currentBranch}`,
        '--name-only',
        '--format=%H%x00%h%x00%s%x00%an%x00%aI%x00',
      ]);

      const commits: CommitInfo[] = [];

      if (logOutput.trim()) {
        // Each commit's format line ends with NUL (%x00), so we can split by the NUL-newline pattern
        // The format is: hash\0shorthash\0message\0author\0date\0\nfile1\nfile2\n\nhash2\0...
        // But commits without files won't have the double newline separator
        // Instead, parse by looking for lines that contain NUL characters (metadata lines)
        const allLines = logOutput.trim().split('\n');

        let currentCommit: { parts: string[]; files: string[] } | null = null;

        for (const line of allLines) {
          if (line.includes('\x00')) {
            // This is a metadata line - save previous commit and start new one
            if (currentCommit) {
              const [hash, shortHash, message, author, dateStr] = currentCommit.parts;
              if (hash) {
                let date: Date;
                if (dateStr && dateStr.trim()) {
                  date = new Date(dateStr);
                  if (isNaN(date.getTime())) {
                    logger.warn('Invalid date string from git log, using current date', { dateStr, hash });
                    date = new Date();
                  }
                } else {
                  logger.warn('Missing date string from git log, using current date', { hash, partsCount: currentCommit.parts.length });
                  date = new Date();
                }
                commits.push({
                  hash,
                  shortHash,
                  message,
                  author,
                  date,
                  files: currentCommit.files,
                });
              }
            }
            // Start new commit
            currentCommit = {
              parts: line.split('\x00'),
              files: [],
            };
          } else if (line.trim() && currentCommit) {
            // This is a file line
            currentCommit.files.push(line);
          }
        }

        // Don't forget the last commit
        if (currentCommit) {
          const [hash, shortHash, message, author, dateStr] = currentCommit.parts;
          if (hash) {
            let date: Date;
            if (dateStr && dateStr.trim()) {
              date = new Date(dateStr);
              if (isNaN(date.getTime())) {
                logger.warn('Invalid date string from git log, using current date', { dateStr, hash });
                date = new Date();
              }
            } else {
              logger.warn('Missing date string from git log, using current date', { hash, partsCount: currentCommit.parts.length });
              date = new Date();
            }
            commits.push({
              hash,
              shortHash,
              message,
              author,
              date,
              files: currentCommit.files,
            });
          }
        }
      }

      // Use git cherry to identify commits that have equivalents on the base branch
      // These commits will be skipped during rebase
      if (commits.length > 0) {
        try {
          const cherryResult = await git.raw(['cherry', baseBranch, currentBranch]);
          // Build a set of hashes that have equivalents (lines starting with '-')
          const equivalentHashes = new Set<string>();
          for (const line of cherryResult.split('\n')) {
            if (line.startsWith('-')) {
              // Format is "- <hash>", extract the hash
              const hash = line.substring(2).trim();
              equivalentHashes.add(hash);
            }
          }

          // Mark commits that have equivalents
          if (equivalentHashes.size > 0) {
            for (const commit of commits) {
              if (equivalentHashes.has(commit.hash)) {
                commit.hasEquivalentOnBase = true;
              }
            }
            logger.info('Marked equivalent commits', { equivalentCount: equivalentHashes.size, totalCommits: commits.length });
          }
        } catch (cherryError) {
          // git cherry can fail in some edge cases, just skip marking
          logger.warn('Failed to check for equivalent commits with git cherry', { cherryError });
        }
      }

      // logger.info('Found worktree commits', { count: commits.length });
      return commits;
    } catch (error) {
      logger.error('Failed to get worktree commits', { error, worktreePath });
      throw new Error(`Failed to get worktree commits: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Commit changes in the worktree
   *
   * @param worktreePath - Path to the worktree
   * @param message - Commit message
   * @param files - Optional array of specific files to commit (commits all changes if not specified)
   * @returns Commit information
   */
  async commitChanges(worktreePath: string, message: string, files?: string[]): Promise<CommitInfo> {
    if (!worktreePath) {
      throw new Error('worktreePath is required');
    }
    if (!message) {
      throw new Error('message is required');
    }

    // Use centralized lock to prevent concurrent commit/staging operations
    return gitOperationLock.withLock(worktreePath, 'commitChanges', () =>
      this.commitChangesImpl(worktreePath, message, files)
    );
  }

  /**
   * Internal implementation of commitChanges (called within lock)
   */
  private async commitChangesImpl(worktreePath: string, message: string, files?: string[]): Promise<CommitInfo> {
    logger.info('Committing changes', { worktreePath, message, fileCount: files?.length });

    const git: SimpleGit = simpleGitWithHookEnv(worktreePath);

    try {
      // CRITICAL: Check git state before committing
      const gitState = await this.checkGitState(worktreePath);

      if (!gitState.isClean) {
        const issues = [];
        if (gitState.inMerge) issues.push('in the middle of a merge');
        if (gitState.inRebase) issues.push('in the middle of a rebase');
        if (gitState.inCherryPick) issues.push('in the middle of a cherry-pick');
        if (gitState.inRevert) issues.push('in the middle of a revert');

        logger.error('Cannot commit: repository is in a bad state', { gitState });
        throw new Error(`Cannot commit: repository is ${issues.join(', ')}. Please resolve the existing operation first.`);
      }
      // Stage files
      if (files && files.length > 0) {
        // First unstage everything to ensure we only commit the specified files
        await git.reset();
        // Then stage only the specified files
        await git.add(files);
      } else {
        // Stage all changes
        await git.add('-A');
      }

      // Check if there are staged changes
      const status = await git.status();
      if (status.staged.length === 0) {
        throw new Error('No changes to commit');
      }

      // Commit
      const commitResult = await git.commit(message);

      if (!commitResult.commit) {
        throw new Error('Commit failed - no commit hash returned');
      }

      // Get commit details
      const logResult = await git.log(['-1', commitResult.commit]);
      const commit = logResult.latest;

      if (!commit) {
        throw new Error('Failed to get commit details');
      }

      // Get files in commit
      const filesOutput = await git.raw(['show', '--name-only', '--format=', commit.hash]);
      const committedFiles = filesOutput.trim().split('\n').filter(Boolean);

      logger.info('Changes committed successfully', { hash: commit.hash });

      return {
        hash: commit.hash,
        shortHash: commit.hash.substring(0, 7),
        message: commit.message,
        author: commit.author_name,
        date: new Date(commit.date),
        files: committedFiles,
      };
    } catch (error) {
      logger.error('Failed to commit changes', { error, worktreePath });
      throw new Error(`Failed to commit changes: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Merge worktree branch into the base branch
   *
   * @param worktreePath - Path to the worktree
   * @param mainRepoPath - Path to the main repository
   * @returns Merge result
   */
  async mergeToMain(worktreePath: string, mainRepoPath: string): Promise<MergeResult> {
    if (!worktreePath) {
      throw new Error('worktreePath is required');
    }
    if (!mainRepoPath) {
      throw new Error('mainRepoPath is required');
    }

    // Use centralized lock to prevent concurrent merge/rebase/squash operations
    return gitOperationLock.withLock(mainRepoPath, 'mergeToMain', () => this.mergeToMainImpl(worktreePath, mainRepoPath));
  }

  /**
   * Internal implementation of mergeToMain (called within lock)
   */
  private async mergeToMainImpl(worktreePath: string, mainRepoPath: string): Promise<MergeResult> {
    logger.info('Merging worktree to main', { worktreePath, mainRepoPath });

    const worktreeGit: SimpleGit = simpleGitWithHookEnv(worktreePath);
    const mainGit: SimpleGit = simpleGitWithHookEnv(mainRepoPath);

    try {
      // CRITICAL: Check git state before any operations
      const worktreeGitState = await this.checkGitState(worktreePath);

      if (!worktreeGitState.isClean) {
        const issues = [];
        if (worktreeGitState.inMerge) issues.push('in the middle of a merge');
        if (worktreeGitState.inRebase) issues.push('in the middle of a rebase');
        if (worktreeGitState.inCherryPick) issues.push('in the middle of a cherry-pick');
        if (worktreeGitState.inRevert) issues.push('in the middle of a revert');

        logger.error('Cannot merge: worktree is in a bad state', { worktreeGitState });
        return {
          success: false,
          message: `Cannot merge: worktree is ${issues.join(', ')}. Please resolve the existing operation first.`,
          conflictedFiles: worktreeGitState.conflictedFiles,
        };
      }

      const mainGitState = await this.checkGitState(mainRepoPath);

      if (!mainGitState.isClean) {
        const issues = [];
        if (mainGitState.inMerge) issues.push('in the middle of a merge');
        if (mainGitState.inRebase) issues.push('in the middle of a rebase');
        if (mainGitState.inCherryPick) issues.push('in the middle of a cherry-pick');
        if (mainGitState.inRevert) issues.push('in the middle of a revert');

        logger.error('Cannot merge: main repository is in a bad state', { mainGitState });
        return {
          success: false,
          message: `Cannot merge: main repository is ${issues.join(', ')}. Please resolve the existing operation first.`,
          conflictedFiles: mainGitState.conflictedFiles,
        };
      }

      // Note: We allow merging even if the worktree has uncommitted changes.
      // The merge happens in the main repo (checking out base branch and merging the worktree branch),
      // so the worktree's uncommitted changes are completely unaffected.
      // We capture the worktree status before merging and verify it's preserved after.
      const worktreeStatusBefore = await worktreeGit.status();
      const worktreeUncommittedCountBefore = worktreeStatusBefore.files.length;

      // Check for uncommitted changes in main repo
      const statusStartTime = Date.now();
      const mainStatus = await mainGit.status();
      const statusDuration = Date.now() - statusStartTime;
      logger.info('Main repo status check complete', { statusDuration, isClean: mainStatus.isClean(), fileCount: mainStatus.files.length });

      // Get worktree branch name and base branch early (need for conflict detection)
      const worktreeBranch = await worktreeGit.revparse(['--abbrev-ref', 'HEAD']);
      const baseBranch = await this.inferBaseBranch(mainGit);

      // Track whether we stashed changes
      let didStash = false;
      let stashMessage = '';

      // CRITICAL: Check if any uncommitted files would be affected by the merge
      // If a file has uncommitted changes AND the worktree branch modifies it, always ask Claude
      if (!mainStatus.isClean()) {
        // Get list of files modified in main (uncommitted)
        const uncommittedFiles = mainStatus.files
          .filter(f => f.working_dir !== ' ' && f.working_dir !== '?') // Modified or new, not untracked
          .map(f => f.path);

        if (uncommittedFiles.length > 0) {
          logger.info('Found uncommitted changes in main', { uncommittedFiles });

          // Get list of files changed in worktree branch compared to base
          try {
            const worktreeDiff = await mainGit.diff([baseBranch, worktreeBranch, '--name-only']);
            const worktreeChangedFiles = worktreeDiff.split('\n').filter(f => f.trim().length > 0);

            logger.info('Files changed in worktree branch', { worktreeChangedFiles });

            // Check if any uncommitted files are also changed in worktree
            const overlappingFiles = uncommittedFiles.filter(f => worktreeChangedFiles.includes(f));

            if (overlappingFiles.length > 0) {
              // Same file(s) modified in both places - always ask Claude to handle it
              logger.warn('Files modified in both main (uncommitted) and worktree (committed)', { overlappingFiles });
              return {
                success: false,
                message: 'merge-conflict-detected',
                conflictedFiles: overlappingFiles,
              };
            }
          } catch (diffError) {
            logger.error('Failed to check worktree changes', { diffError });
            // Fall through to stash and merge
          }
        }

        // No overlapping files - safe to auto-stash
        // Only stash if there are MODIFIED/STAGED files (not just untracked files)
        const hasModifiedFiles = mainStatus.files.some(f => f.working_dir !== '?' && f.working_dir !== '!');

        if (hasModifiedFiles) {
          // CRITICAL: Check if stash will succeed before attempting
          const stashConflicts = await this.checkStashConflicts(mainRepoPath);

          if (stashConflicts.length > 0) {
            logger.error('Cannot stash: files have merge conflicts', { conflictedFiles: stashConflicts });
            return {
              success: false,
              message: 'Cannot merge: uncommitted changes in main repository have merge conflicts. Please use AI to resolve the conflicts first, or commit/discard the changes.',
              conflictedFiles: stashConflicts,
            };
          }

          // Check for existing stashes that might interfere
          const stashListBefore = await mainGit.stash(['list']);
          const stashCountBefore = stashListBefore ? stashListBefore.split('\n').filter(s => s.trim()).length : 0;

          if (stashCountBefore > 0) {
            logger.warn('Existing stashes detected in main repo - these could interfere with auto-stash', { stashCountBefore });
          }

          logger.info('Auto-stashing uncommitted changes in main repository', {
            fileCount: mainStatus.files.filter(f => f.working_dir !== '?' && f.working_dir !== '!').length,
            existingStashes: stashCountBefore,
          });
          const stashStartTime = Date.now();

          // Create a unique stash message to verify we pop the right one
          stashMessage = `Auto-stash before merge ${Date.now()}`;

          try {
            // Don't use -u flag to avoid stashing large untracked files (performance issue)
            await mainGit.stash(['push', '-m', stashMessage]);

            // CRITICAL: Verify the stash was actually created
            const stashListAfter = await mainGit.stash(['list']);
            const stashCountAfter = stashListAfter ? stashListAfter.split('\n').filter(s => s.trim()).length : 0;

            if (stashCountAfter > stashCountBefore) {
              // Verify the top stash has our message
              const topStash = stashListAfter.split('\n')[0];
              if (topStash && topStash.includes(stashMessage)) {
                didStash = true;
                const stashDuration = Date.now() - stashStartTime;
                logger.info('Auto-stash successful', { stashDuration, stashMessage });
              } else {
                logger.error('Stash created but with wrong message', { topStash, expectedMessage: stashMessage });
                return {
                  success: false,
                  message: 'Internal error: stash created with wrong message. Please contact support.',
                };
              }
            } else {
              logger.warn('git stash succeeded but no stash was created - working directory might be clean');
              didStash = false;
            }
          } catch (stashError) {
            logger.error('Failed to auto-stash changes', { stashError });

            // Check if this is a merge conflict preventing stash
            const errorMessage = stashError instanceof Error ? stashError.message : String(stashError);
            if (errorMessage.includes('needs merge') || errorMessage.includes('needs update')) {
              // There are merge conflicts in the main repository
              const conflictedFiles = mainStatus.conflicted || [];

              // Return a special error that the IPC handler can detect
              return {
                success: false,
                message: 'merge-conflict-in-main',
                conflictedFiles,
              };
            }

            return {
              success: false,
              message: 'Cannot merge: uncommitted changes in main repository and auto-stash failed. Please commit or stash changes manually.',
            };
          }
        }
      }

      logger.info('Merge details', { worktreeBranch, baseBranch });

      // Switch to base branch in main repo
      const checkoutStartTime = Date.now();
      await mainGit.checkout(baseBranch);
      const checkoutDuration = Date.now() - checkoutStartTime;
      logger.info('Checkout complete', { checkoutDuration, baseBranch });

      // Attempt merge (no remote operations - purely local)
      // Allow fast-forward when possible to keep history clean
      // If base branch has diverged, a merge commit will be created automatically
      try {
        const mergeStartTime = Date.now();
        await mainGit.merge([worktreeBranch]);
        const mergeDuration = Date.now() - mergeStartTime;

        logger.info('Merge completed successfully', { mergeDuration });

        // CRITICAL: Verify git state after merge
        const postMergeState = await this.checkGitState(mainRepoPath);

        if (!postMergeState.isClean) {
          const issues = [];
          if (postMergeState.inMerge) issues.push('in the middle of a merge');
          if (postMergeState.inRebase) issues.push('in the middle of a rebase');
          if (postMergeState.inCherryPick) issues.push('in the middle of a cherry-pick');
          if (postMergeState.inRevert) issues.push('in the middle of a revert');

          logger.error('Merge completed but repository is in a bad state', { postMergeState });

          // Try to restore stash if needed
          if (didStash) {
            await this.safeStashPop(mainGit, 'detecting bad merge state');
          }

          return {
            success: false,
            message: `Merge completed but repository is ${issues.join(', ')}. Please resolve the issue manually.`,
            conflictedFiles: postMergeState.conflictedFiles,
          };
        }

        // Pop the stash if we auto-stashed
        if (didStash) {
          try {
            // CRITICAL: Verify the top stash is ours before popping
            const stashListBeforePop = await mainGit.stash(['list']);
            const topStash = stashListBeforePop ? stashListBeforePop.split('\n')[0] : '';

            if (!topStash || !topStash.includes(stashMessage)) {
              logger.error('Top stash is not ours - refusing to pop', {
                topStash,
                expectedMessage: stashMessage,
              });
              return {
                success: true,
                message: `Successfully merged ${worktreeBranch} into ${baseBranch}. Warning: Stash stack was corrupted - your changes are in stash. Use 'git stash list' to find them.`,
                stashWarning: true,
              };
            }

            const popStartTime = Date.now();
            await mainGit.stash(['pop']);
            const popDuration = Date.now() - popStartTime;
            logger.info('Auto-stash popped successfully', { popDuration });

            // CRITICAL: Check git state after stash pop to detect conflicts
            const postStashState = await this.checkGitState(mainRepoPath);
            const postStashStatus = await mainGit.status();

            // Check if stash pop created conflicts
            if (!postStashState.isClean || postStashStatus.conflicted.length > 0) {
              logger.error('Stash pop created conflicts', {
                postStashState,
                conflictedFiles: postStashStatus.conflicted,
              });

              return {
                success: false,
                message: `Merge succeeded, but restoring your uncommitted changes created conflicts. Please resolve the conflicts in the uncommitted changes.`,
                conflictedFiles: postStashStatus.conflicted,
              };
            }
          } catch (popError) {
            logger.warn('Failed to pop stash after merge', { popError });
            return {
              success: true,
              message: `Successfully merged ${worktreeBranch} into ${baseBranch}. Warning: Auto-stashed changes could not be restored automatically. Use 'git stash pop' to restore them.`,
              stashWarning: true, // Flag for UI to show prominent alert
            };
          }
          // Verify worktree uncommitted changes are preserved
          const worktreeStatusAfterStash = await worktreeGit.status();
          if (worktreeStatusAfterStash.files.length !== worktreeUncommittedCountBefore) {
            logger.error('Worktree uncommitted changes were unexpectedly modified after merge', {
              before: worktreeUncommittedCountBefore,
              after: worktreeStatusAfterStash.files.length,
            });
            return {
              success: false,
              message: 'Internal error: worktree uncommitted changes were modified during merge. Please check your worktree status.',
            };
          }

          return {
            success: true,
            message: `Successfully merged ${worktreeBranch} into ${baseBranch}. Auto-stashed changes have been restored.`,
          };
        }

        // Verify worktree uncommitted changes are preserved
        const worktreeStatusAfter = await worktreeGit.status();
        if (worktreeStatusAfter.files.length !== worktreeUncommittedCountBefore) {
          logger.error('Worktree uncommitted changes were unexpectedly modified after merge', {
            before: worktreeUncommittedCountBefore,
            after: worktreeStatusAfter.files.length,
          });
          return {
            success: false,
            message: 'Internal error: worktree uncommitted changes were modified during merge. Please check your worktree status.',
          };
        }

        return {
          success: true,
          message: `Successfully merged ${worktreeBranch} into ${baseBranch}`,
        };
      } catch (mergeError) {
        // Check for merge conflicts
        const status = await mainGit.status();
        if (status.conflicted.length > 0) {
          // Abort the merge first, before restoring stash
          await mainGit.merge(['--abort']);

          // If merge failed and we stashed, try to restore the stash AFTER abort
          if (didStash) {
            await this.safeStashPop(mainGit, 'merge abort');
          }

          return {
            success: false,
            message: 'Merge conflicts detected. Please resolve conflicts manually.',
            conflictedFiles: status.conflicted,
          };
        }

        // Non-conflict merge error - restore stash before throwing
        if (didStash) {
          await this.safeStashPop(mainGit, 'non-conflict merge failure');
        }

        throw mergeError;
      }
    } catch (error) {
      logger.error('Failed to merge to main', { error, worktreePath });
      throw new Error(`Failed to merge to main: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check for potential rebase conflicts before attempting a rebase
   * Uses git merge-tree to simulate the rebase without modifying the repository
   *
   * @param worktreePath - Path to the worktree
   * @param baseBranch - The base branch to check conflicts against
   * @returns Conflict information including files and commits
   */
  private async checkForRebaseConflicts(
    worktreePath: string,
    baseBranch: string
  ): Promise<{
    hasConflicts: boolean;
    conflictingFiles?: string[];
    conflictingCommits?: { ours: string[]; theirs: string[] };
  }> {
    const git: SimpleGit = simpleGit(worktreePath);

    try {
      // Get the current branch
      const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();

      // Use git cherry to find commits that are truly unique (will actually be replayed)
      // Commits with equivalent content on base branch will be skipped during rebase
      const cherryResult = await git.raw(['cherry', baseBranch, currentBranch]);
      const uniqueCommitHashes: string[] = [];
      for (const line of cherryResult.split('\n')) {
        if (line.startsWith('+')) {
          // Format is "+ <hash>", extract the hash
          uniqueCommitHashes.push(line.substring(2).trim());
        }
      }

      // If no unique commits, no conflicts possible - rebase will be a no-op
      if (uniqueCommitHashes.length === 0) {
        logger.info('No unique commits to rebase, skipping conflict check');
        return { hasConflicts: false };
      }

      // Get files modified by unique commits only, tracking which commits touch which files
      const ourFiles = new Set<string>();
      const commitToFiles = new Map<string, Set<string>>(); // hash -> files
      const fileToCommits = new Map<string, Set<string>>(); // file -> hashes

      for (const hash of uniqueCommitHashes) {
        const filesInCommit = (await git.raw(['diff-tree', '--no-commit-id', '--name-only', '-r', hash])).split('\n').filter(f => f.trim());
        commitToFiles.set(hash, new Set(filesInCommit));
        for (const file of filesInCommit) {
          ourFiles.add(file);
          if (!fileToCommits.has(file)) {
            fileToCommits.set(file, new Set());
          }
          fileToCommits.get(file)!.add(hash);
        }
      }

      if (ourFiles.size === 0) {
        return { hasConflicts: false };
      }

      // Find the merge base for comparing what's on the base branch
      const mergeBase = (await git.raw(['merge-base', baseBranch, currentBranch])).trim();

      // Get files modified on the base branch since merge base
      const theirFiles = (await git.diff([`${mergeBase}...${baseBranch}`, '--name-only'])).split('\n').filter(f => f.trim());

      // Find intersecting files (potential conflicts)
      const conflictingFiles = [...ourFiles].filter(f => theirFiles.includes(f));

      if (conflictingFiles.length === 0) {
        return { hasConflicts: false };
      }

      // File-level conflict detection: if ANY file was modified on both branches,
      // treat it as a conflict. This is conservative but safe — the user can delegate
      // to AI to resolve the rebase if needed.
      const conflictingCommitHashes = new Set<string>();
      for (const file of conflictingFiles) {
        const commits = fileToCommits.get(file);
        if (commits) {
          for (const hash of commits) {
            conflictingCommitHashes.add(hash);
          }
        }
      }

      // Batch fetch all commit messages in a single git command to avoid N+1 performance issue
      const hashArray = Array.from(conflictingCommitHashes);
      let ourCommitMessages: string[] = [];
      if (hashArray.length > 0) {
        const messagesOutput = await git.raw(['log', '--format=%s', '--no-walk', ...hashArray]);
        ourCommitMessages = messagesOutput.trim().split('\n').filter(Boolean);
      }

      // Get their commits that touch conflicting files
      const theirConflictingCommitMessages: string[] = [];
      for (const file of conflictingFiles) {
        const theirCommitsForFile = await git.log({ from: mergeBase, to: baseBranch, file });
        for (const commit of theirCommitsForFile.all) {
          if (!theirConflictingCommitMessages.includes(commit.message)) {
            theirConflictingCommitMessages.push(commit.message);
          }
        }
      }

      logger.info('Rebase blocked due to file-level overlap', {
        conflictingFiles,
        ourConflictingCommitCount: ourCommitMessages.length,
        theirConflictingCommitCount: theirConflictingCommitMessages.length,
      });

      return {
        hasConflicts: true,
        conflictingFiles,
        conflictingCommits: {
          ours: ourCommitMessages,
          theirs: theirConflictingCommitMessages,
        },
      };
    } catch (error) {
      logger.error('Failed to check for rebase conflicts', { error, worktreePath, baseBranch });
      // On error, assume no conflicts to allow the rebase to proceed (it will handle conflicts itself)
      return { hasConflicts: false };
    }
  }

  /**
   * Rebase the worktree branch onto the latest base branch
   * This brings in any new commits from the base branch into the worktree
   *
   * @param worktreePath - Path to the worktree
   * @param baseBranch - The base branch to rebase onto (from database)
   * @returns Rebase result
   */
  async rebaseFromBase(
    worktreePath: string,
    baseBranch: string
  ): Promise<{
    success: boolean;
    message?: string;
    conflictedFiles?: string[];
    conflictingCommits?: { ours: string[]; theirs: string[] };
    untrackedFiles?: string[];
    stashWarning?: boolean;
  }> {
    if (!worktreePath) {
      throw new Error('worktreePath is required');
    }
    if (!baseBranch) {
      throw new Error('baseBranch is required');
    }

    // Use lock to prevent concurrent merge/rebase/squash operations
    return gitOperationLock.withLock(worktreePath, 'rebaseFromBase', () => this.rebaseFromBaseImpl(worktreePath, baseBranch));
  }

  /**
   * Internal implementation of rebaseFromBase (called within lock)
   */
  private async rebaseFromBaseImpl(
    worktreePath: string,
    baseBranch: string
  ): Promise<{
    success: boolean;
    message?: string;
    conflictedFiles?: string[];
    conflictingCommits?: { ours: string[]; theirs: string[] };
    untrackedFiles?: string[];
    stashWarning?: boolean;
  }> {
    logger.info('Rebasing worktree from base branch', { worktreePath, baseBranch });

    const git: SimpleGit = simpleGitWithHookEnv(worktreePath);

    try {
      // CRITICAL: Check git state before any operations
      const gitState = await this.checkGitState(worktreePath);

      if (!gitState.isClean) {
        const issues = [];
        if (gitState.inMerge) issues.push('in the middle of a merge');
        if (gitState.inRebase) issues.push('in the middle of a rebase');
        if (gitState.inCherryPick) issues.push('in the middle of a cherry-pick');
        if (gitState.inRevert) issues.push('in the middle of a revert');

        logger.error('Cannot rebase: repository is in a bad state', { gitState });
        return {
          success: false,
          message: `Cannot rebase: repository is ${issues.join(', ')}. Please resolve the existing operation first.`,
          conflictedFiles: gitState.conflictedFiles,
        };
      }

      const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      logger.info('Rebase details', { currentBranch, baseBranch });

      // Pre-flight check for conflicts (Crystal pattern)
      const conflictCheck = await this.checkForRebaseConflicts(worktreePath, baseBranch);

      if (conflictCheck.hasConflicts) {
        logger.warn('Rebase would result in conflicts, aborting before attempting', {
          conflictingFiles: conflictCheck.conflictingFiles,
        });

        return {
          success: false,
          message: 'rebase-conflicts-detected',
          conflictedFiles: conflictCheck.conflictingFiles,
          conflictingCommits: conflictCheck.conflictingCommits,
        };
      }

      // Check for uncommitted changes and auto-stash if needed
      const status = await git.status();
      let didStash = false;
      let stashMessage = '';

      // Only stash if there are MODIFIED/STAGED files (not just untracked files)
      // Untracked files don't need to be stashed and can cause issues
      const hasModifiedFiles = status.files.some(f => f.working_dir !== '?' && f.working_dir !== '!');

      if (hasModifiedFiles) {
        // CRITICAL: Check if stash will succeed before attempting
        const stashConflicts = await this.checkStashConflicts(worktreePath);

        if (stashConflicts.length > 0) {
          logger.error('Cannot stash: files have merge conflicts', { conflictedFiles: stashConflicts });
          return {
            success: false,
            message: 'Cannot rebase: uncommitted changes have merge conflicts. Please use AI to resolve the conflicts first, or commit/discard the changes.',
            conflictedFiles: stashConflicts,
          };
        }

        // Check for existing stashes that might interfere
        const stashListBefore = await git.stash(['list']);
        const stashCountBefore = stashListBefore ? stashListBefore.split('\n').filter(s => s.trim()).length : 0;

        if (stashCountBefore > 0) {
          logger.warn('Existing stashes detected - these could interfere with auto-stash', { stashCountBefore });
        }

        logger.info('Auto-stashing uncommitted changes before rebase', {
          fileCount: status.files.filter(f => f.working_dir !== '?' && f.working_dir !== '!').length,
          existingStashes: stashCountBefore,
        });
        const stashStartTime = Date.now();

        // Create a unique stash message to verify we pop the right one
        stashMessage = `Auto-stash before rebase ${Date.now()}`;

        try {
          // Don't use -u flag to avoid stashing large untracked files
          await git.stash(['push', '-m', stashMessage]);

          // CRITICAL: Verify the stash was actually created
          const stashListAfter = await git.stash(['list']);
          const stashCountAfter = stashListAfter ? stashListAfter.split('\n').filter(s => s.trim()).length : 0;

          if (stashCountAfter > stashCountBefore) {
            // Verify the top stash has our message
            const topStash = stashListAfter.split('\n')[0];
            if (topStash && topStash.includes(stashMessage)) {
              didStash = true;
              const stashDuration = Date.now() - stashStartTime;
              logger.info('Auto-stash successful', { stashDuration, stashMessage });
            } else {
              logger.error('Stash created but with wrong message', { topStash, expectedMessage: stashMessage });
              return {
                success: false,
                message: 'Internal error: stash created with wrong message. Please contact support.',
              };
            }
          } else {
            logger.warn('git stash succeeded but no stash was created - working directory might be clean');
            didStash = false;
          }
        } catch (stashError) {
          logger.error('Failed to auto-stash changes', { stashError });
          return {
            success: false,
            message: `Failed to stash uncommitted changes: ${stashError instanceof Error ? stashError.message : String(stashError)}`,
          };
        }
      }

      // Perform the rebase
      try {
        await git.rebase([baseBranch]);

        logger.info('Rebase completed successfully');

        // CRITICAL: Verify git state after rebase
        const postRebaseState = await this.checkGitState(worktreePath);

        if (!postRebaseState.isClean) {
          const issues = [];
          if (postRebaseState.inMerge) issues.push('in the middle of a merge');
          if (postRebaseState.inRebase) issues.push('in the middle of a rebase');
          if (postRebaseState.inCherryPick) issues.push('in the middle of a cherry-pick');
          if (postRebaseState.inRevert) issues.push('in the middle of a revert');

          logger.error('Rebase completed but repository is in a bad state', { postRebaseState });

          // Try to restore stash if needed
          if (didStash) {
            await this.safeStashPop(git, 'detecting bad rebase state');
          }

          return {
            success: false,
            message: `Rebase completed but repository is ${issues.join(', ')}. Please resolve the issue manually.`,
            conflictedFiles: postRebaseState.conflictedFiles,
          };
        }

        // Pop stash if we stashed changes
        if (didStash) {
          try {
            logger.info('Attempting to restore stashed changes');

            // CRITICAL: Verify the top stash is ours before popping
            const stashListBeforePop = await git.stash(['list']);
            const topStash = stashListBeforePop ? stashListBeforePop.split('\n')[0] : '';

            if (!topStash || !topStash.includes(stashMessage)) {
              logger.error('Top stash is not ours - refusing to pop', {
                topStash,
                expectedMessage: stashMessage,
              });
              return {
                success: true,
                message: `Rebase succeeded but cannot restore stashed changes: stash stack was corrupted. Your changes are in stash - use 'git stash list' to find them.`,
                stashWarning: true,
              };
            }

            await git.stash(['pop']);
            logger.info('Stashed changes restored successfully');

            // CRITICAL: Check git state after stash pop to detect conflicts
            const postStashState = await this.checkGitState(worktreePath);
            const postStashStatus = await git.status();

            // Check if stash pop created conflicts
            if (!postStashState.isClean || postStashStatus.conflicted.length > 0) {
              logger.error('Stash pop created conflicts', {
                postStashState,
                conflictedFiles: postStashStatus.conflicted,
              });

              return {
                success: false,
                message: `Rebase succeeded, but restoring your uncommitted changes created conflicts. Please resolve the conflicts in the uncommitted changes.`,
                conflictedFiles: postStashStatus.conflicted,
              };
            }
          } catch (popError) {
            logger.error('Failed to restore stashed changes', { popError });
            // Return success=true because the rebase itself worked, but flag the stash warning
            return {
              success: true,
              message: `Rebase succeeded but failed to restore stashed changes: ${popError instanceof Error ? popError.message : String(popError)}. Use 'git stash pop' manually to restore.`,
              stashWarning: true, // Flag for UI to show prominent alert
            };
          }
        }

        return {
          success: true,
          message: `Successfully rebased ${currentBranch} onto ${baseBranch}`,
        };
      } catch (rebaseError) {
        const errorMessage = rebaseError instanceof Error ? rebaseError.message : String(rebaseError);

        // Check for untracked files that would be overwritten
        if (errorMessage.includes('untracked working tree files would be overwritten')) {
          // Parse the file names from the error message
          const untrackedFiles: string[] = [];
          const lines = errorMessage.split('\n');
          let inFileList = false;
          for (const line of lines) {
            if (line.includes('untracked working tree files would be overwritten')) {
              inFileList = true;
              continue;
            }
            if (inFileList) {
              // File names are indented with tabs, stop when we hit a non-indented line
              if (line.startsWith('\t')) {
                untrackedFiles.push(line.trim());
              } else if (line.trim() !== '' && !line.startsWith('error:')) {
                // Hit "Please move or remove..." or other non-file line
                break;
              }
            }
          }

          // Restore stash if we stashed
          if (didStash) {
            await this.safeStashPop(git, 'untracked file conflict');
          }

          return {
            success: false,
            message: 'untracked-files-conflict',
            untrackedFiles,
          };
        }

        // Check for rebase conflicts
        const rebaseStatus = await git.status();
        if (rebaseStatus.conflicted.length > 0) {
          // Abort the rebase
          await git.rebase(['--abort']);

          // Restore stash if we stashed
          if (didStash) {
            await this.safeStashPop(git, 'aborted rebase');
          }

          return {
            success: false,
            message: 'rebase-conflicts-detected',
            conflictedFiles: rebaseStatus.conflicted,
          };
        }

        // Restore stash on other errors too
        if (didStash) {
          await this.safeStashPop(git, 'rebase error');
        }

        throw rebaseError;
      }
    } catch (error) {
      logger.error('Failed to rebase from base', { error, worktreePath, baseBranch });
      throw new Error(`Failed to rebase: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get all changed files in the worktree compared to base branch
   *
   * @param worktreePath - Path to the worktree
   * @returns Array of changed file paths with their status
   */
  async getChangedFiles(worktreePath: string): Promise<Array<{ path: string; status: 'added' | 'modified' | 'deleted'; staged: boolean }>> {
    if (!worktreePath) {
      throw new Error('worktreePath is required');
    }

    // logger.info('Getting changed files', { worktreePath });

    const git: SimpleGit = simpleGit(worktreePath);

    try {
      // Get only uncommitted changes from git status
      // This shows files that need to be staged/committed, not the full branch diff
      const gitStatus = await git.status();

      const changedFiles: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; staged: boolean }> = [];

      for (const file of gitStatus.files) {
        let status: 'added' | 'modified' | 'deleted';

        if (file.index === 'D' || file.working_dir === 'D') {
          status = 'deleted';
        } else if (file.index === '?' || file.index === 'A') {
          status = 'added';
        } else {
          status = 'modified';
        }

        // A file is staged if its index status is not ' ' (space) or '?' (untracked)
        const staged = file.index !== ' ' && file.index !== '?';

        // For untracked entries (? in working_dir), check if it's a directory
        // git status shows untracked directories as a single entry, not individual files
        if (file.working_dir === '?') {
          const absolutePath = path.join(worktreePath, file.path);
          try {
            const stats = fs.statSync(absolutePath);
            if (stats.isDirectory()) {
              // Expand the untracked directory to individual files, honoring
              // .gitignore so an installed node_modules/dist doesn't explode
              // into tens of thousands of paths (NIM-1782). git ls-files emits
              // worktree-relative, forward-slashed paths already.
              const relFiles = getUntrackedFilesInDirectory(worktreePath, absolutePath);
              for (const filePath of relFiles) {
                changedFiles.push({ path: filePath, status: 'added', staged: false });
              }
              continue; // Skip adding the directory itself
            }
          } catch {
            // If stat fails (file doesn't exist), just add the path as-is
          }
        }

        changedFiles.push({ path: file.path, status, staged });
      }

      // logger.info('Found changed files', { count: changedFiles.length });
      return changedFiles;
    } catch (error) {
      logger.error('Failed to get changed files', { error, worktreePath });
      throw new Error(`Failed to get changed files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if commits exist on other branches besides the current one
   *
   * @param worktreePath - Path to the worktree
   * @param commitHashes - Array of commit hashes to check
   * @returns Whether any commits exist on other branches
   */
  async checkCommitsExistElsewhere(worktreePath: string, commitHashes: string[]): Promise<boolean> {
    if (!worktreePath) {
      throw new Error('worktreePath is required');
    }

    if (!commitHashes || commitHashes.length === 0) {
      return false;
    }

    logger.info('Checking if commits exist on other branches', { worktreePath, commitCount: commitHashes.length });

    const git: SimpleGit = simpleGit(worktreePath);

    try {
      // Get current branch
      const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);

      // For each commit, check if it exists on any branch other than current
      for (const hash of commitHashes) {
        // Get all branches that contain this commit
        const result = await git.raw(['branch', '--contains', hash, '--all']);
        const branches = result.split('\n').map(b => b.trim().replace(/^\* /, ''));

        // Filter out current branch and check if commit exists elsewhere
        const otherBranches = branches.filter(b =>
          b &&
          b !== currentBranch &&
          !b.startsWith('remotes/origin/' + currentBranch)
        );

        if (otherBranches.length > 0) {
          logger.info('Commit exists on other branches', { hash, otherBranches });
          return true;
        }
      }

      return false;
    } catch (error) {
      logger.error('Failed to check commit existence', { error, worktreePath });
      // If check fails, return false to allow squashing (user can proceed at own risk)
      return false;
    }
  }

  /**
   * Squash multiple commits into a single commit
   *
   * Creates a backup branch before squashing to allow recovery if the operation fails.
   *
   * @param worktreePath - Path to the worktree
   * @param commitHashes - Array of commit hashes to squash (must be consecutive)
   * @param message - Commit message for the squashed commit
   * @returns The new commit hash
   */
  async squashCommits(worktreePath: string, commitHashes: string[], message: string): Promise<string> {
    if (!worktreePath) {
      throw new Error('worktreePath is required');
    }

    if (!commitHashes || commitHashes.length < 2) {
      throw new Error('At least 2 commits are required for squashing');
    }

    if (!message) {
      throw new Error('Commit message is required');
    }

    // Use lock to prevent concurrent merge/rebase/squash operations
    return gitOperationLock.withLock(worktreePath, 'squashCommits', () => this.squashCommitsImpl(worktreePath, commitHashes, message));
  }

  /**
   * Internal implementation of squashCommits (called within lock)
   */
  private async squashCommitsImpl(worktreePath: string, commitHashes: string[], message: string): Promise<string> {
    logger.info('Squashing commits', { worktreePath, commitCount: commitHashes.length });

    const git: SimpleGit = simpleGitWithHookEnv(worktreePath);

    // Create backup branch name with timestamp
    const backupBranchName = `backup-before-squash-${Date.now()}`;
    let backupCreated = false;

    try {
      // Get all commits to validate the selection is consecutive
      const allCommits = await git.log();
      const commitIndices = commitHashes.map(hash => {
        const index = allCommits.all.findIndex(c => c.hash === hash || c.hash.startsWith(hash));
        if (index === -1) {
          throw new Error(`Commit not found: ${hash}`);
        }
        return index;
      });

      // Sort indices to find the range
      commitIndices.sort((a, b) => a - b);

      // Verify commits are consecutive
      for (let i = 1; i < commitIndices.length; i++) {
        if (commitIndices[i] !== commitIndices[i - 1] + 1) {
          throw new Error('Selected commits must be consecutive');
        }
      }

      // Find the oldest commit (highest index) to use as the base
      const oldestIndex = commitIndices[commitIndices.length - 1];
      const oldestCommit = allCommits.all[oldestIndex];

      // Create a backup branch before squashing (for recovery if operation fails)
      logger.info('Creating backup branch before squash', { backupBranchName });
      await git.branch([backupBranchName]);
      backupCreated = true;

      // Use reset --soft to move HEAD to the commit before the oldest selected commit
      // This keeps all changes from the squashed commits in the staging area
      const baseCommit = oldestCommit.hash + '~1';

      logger.info('Resetting to base commit', { baseCommit });
      await git.reset(['--soft', baseCommit]);

      // Create a new commit with all the changes
      logger.info('Creating squashed commit', { message });
      await git.commit(message);

      // Get the new commit hash
      const newCommit = await git.revparse(['HEAD']);

      // Squash succeeded - delete the backup branch
      logger.info('Squash succeeded, deleting backup branch', { backupBranchName });
      try {
        await git.deleteLocalBranch(backupBranchName, true);
      } catch (deleteBranchError) {
        // Non-critical - just log a warning
        logger.warn('Failed to delete backup branch after successful squash', {
          backupBranchName,
          error: deleteBranchError,
        });
      }

      logger.info('Successfully squashed commits', { newCommit });
      return newCommit;
    } catch (error) {
      logger.error('Failed to squash commits', { error, worktreePath });

      if (backupCreated) {
        logger.warn('Squash failed - backup branch remains for manual recovery', {
          backupBranchName,
          recoveryCommand: `git checkout ${backupBranchName}`,
        });
      }

      throw new Error(`Failed to squash commits: ${error instanceof Error ? error.message : String(error)}. ${backupCreated ? `Backup branch '${backupBranchName}' available for recovery.` : ''}`);
    }
  }

  /**
   * Paths to preserve even if gitignored (workspace config, secrets, session state).
   * git clean -X -e does NOT work for excluding paths, so we filter the dry-run
   * output ourselves and pass explicit paths to git clean.
   */
  private static readonly CLEAN_PRESERVE_PATTERNS = [
    '.nimbalyst',       // Workspace assets and tracker configs
    'nimbalyst-local',  // Plans, trackers, mockups, voice summaries
    '.superloop',       // Superloop state
    '.ralph',           // Ralph Loop task state, progress, implementation plans
    '.claude',          // Permission approvals (settings.local.json), slash commands
  ];

  /** Check if a path (from git clean output) matches any preserved pattern. */
  private static isPreservedPath(filePath: string): boolean {
    const normalized = filePath.replace(/\/$/, '');
    const topLevel = normalized.split('/')[0];
    return GitWorktreeService.CLEAN_PRESERVE_PATTERNS.includes(topLevel);
  }

  /**
   * Dry run: list all gitignored files that would be removed from a worktree.
   * Filters out preserved paths (workspace config, secrets, session state).
   */
  async listGitignoredFiles(worktreePath: string): Promise<string[]> {
    if (!worktreePath) {
      throw new Error('worktreePath is required');
    }

    const git: SimpleGit = simpleGit(worktreePath);
    const result = await git.raw(['clean', '-Xdn']);

    if (!result.trim()) return [];

    const lines = result.trim().split('\n').filter(line => line.trim().length > 0);
    return lines
      .map(line => line.replace(/^Would remove /, ''))
      .filter(p => !GitWorktreeService.isPreservedPath(p));
  }

  /**
   * Remove all gitignored files from a worktree, skipping preserved paths.
   * Gets the full list via dry-run, filters out preserved paths, then removes
   * only the safe paths by passing them as explicit pathspecs.
   */
  async cleanGitignoredFiles(worktreePath: string): Promise<string[]> {
    if (!worktreePath) {
      throw new Error('worktreePath is required');
    }

    return gitOperationLock.withLock(worktreePath, 'cleanGitignoredFiles', async () => {
      logger.info('Cleaning gitignored files from worktree', { worktreePath });

      const git: SimpleGit = simpleGit(worktreePath);

      // Dry-run to get the full list
      const dryRun = await git.raw(['clean', '-Xdn']);
      if (!dryRun.trim()) return [];

      // Parse and filter out preserved paths
      const allPaths = dryRun.trim().split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => line.replace(/^Would remove /, ''));

      const toRemove = allPaths.filter(p => !GitWorktreeService.isPreservedPath(p));
      if (toRemove.length === 0) return [];

      logger.info('Removing gitignored files', {
        worktreePath,
        total: allPaths.length,
        preserved: allPaths.length - toRemove.length,
        toRemove: toRemove.length,
      });

      // Pass explicit paths so preserved dirs are never touched
      await git.raw(['clean', '-Xdf', '--', ...toRemove]);

      logger.info('Cleaned gitignored files', { worktreePath, removedCount: toRemove.length });
      return toRemove;
    });
  }
}

// Export singleton instance
export const gitWorktreeService = new GitWorktreeService();
