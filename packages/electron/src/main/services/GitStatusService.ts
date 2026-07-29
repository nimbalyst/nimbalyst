import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import {
  getUntrackedFilesInDirectories,
  isGitAvailable,
  logEbadfDiagnostic,
  type UntrackedExpansionOptions,
} from '../utils/gitUtils';
import { AnalyticsService } from './analytics/AnalyticsService';

export interface FileGitStatus {
  filePath: string;
  status: 'modified' | 'staged' | 'untracked' | 'unchanged' | 'deleted';
  gitStatusCode?: string; // Raw git status code (M, A, D, ??, etc.)
}

export interface GitStatusResult {
  [filePath: string]: FileGitStatus;
}

type GitStatusCallerClass = 'whole_workspace' | 'worktree_session';

type UntrackedExpander = (
  repoRoot: string,
  directories: string[],
  options: UntrackedExpansionOptions
) => Promise<string[]>;

interface RootStatusSnapshot {
  generation: number;
  timestamp: number;
  statuses: GitStatusResult;
  uncommittedFiles: string[];
}

interface RootStatusInFlight {
  generation: number;
  controller: AbortController;
  callers: Set<GitStatusCallerClass>;
  promise: Promise<RootStatusSnapshot>;
}

export interface GitStatusServiceOptions {
  expandUntrackedFiles?: UntrackedExpander;
  analytics?: Pick<AnalyticsService, 'sendEvent'>;
}

/**
 * Find the git repository root that owns a file path.
 *
 * Walks up from the file's parent directory looking for a `.git` entry
 * (directory or worktree-link file). Stops at `boundary` so a file outside
 * the workspace cannot be matched against an unrelated repo somewhere
 * higher up the filesystem.
 *
 * Returns the absolute path of the owning git root, or null if the file
 * is not inside any git repo within `boundary`. The returned root may be
 * `boundary` itself (when the workspace IS a git repo) or a nested
 * subdirectory (workspace contains nested repos but is not itself one).
 *
 * Exported for unit testing.
 */
// Per-directory cache of `.git` existence. findGitRootForFile is called once
// per file by getFileStatus, walking up the tree with an existsSync at every
// level; without caching this is an O(files x depth) synchronous FS storm on
// the main thread under multi-session editing of a large repo (nimbalyst#868).
// Git roots do not move during a session, so memoizing is safe.
const gitDirExistsCache = new Map<string, boolean>();

/** Test-only: reset the git-root existence cache. */
export function __resetGitRootCache(): void {
  gitDirExistsCache.clear();
}

function hasGitDir(dir: string): boolean {
  let cached = gitDirExistsCache.get(dir);
  if (cached === undefined) {
    try {
      cached = existsSync(join(dir, '.git'));
    } catch {
      cached = false;
    }
    gitDirExistsCache.set(dir, cached);
  }
  return cached;
}

export function findGitRootForFile(filePath: string, boundary: string): string | null {
  const boundaryAbs = resolve(boundary);
  const fileAbs = isAbsolute(filePath) ? filePath : resolve(boundaryAbs, filePath);

  // The file must live inside the boundary. resolve normalizes separators
  // so we can compare prefix-wise. Add a separator on the right side to
  // avoid matching siblings like `/foo/bar2` against boundary `/foo/bar`.
  const boundaryWithSep = boundaryAbs.endsWith('/') || boundaryAbs.endsWith('\\')
    ? boundaryAbs
    : boundaryAbs + (process.platform === 'win32' ? '\\' : '/');
  if (fileAbs !== boundaryAbs && !fileAbs.startsWith(boundaryWithSep)) {
    return null;
  }

  let dir = dirname(fileAbs);
  // Walk up until we leave the boundary, hit fs root, or find `.git`.
  while (true) {
    try {
      if (hasGitDir(dir)) {
        return dir;
      }
    } catch {
      // ignore - keep walking
    }
    if (dir === boundaryAbs) break;
    const parent = dirname(dir);
    if (parent === dir) break; // hit filesystem root
    // If walking up would take us out of the boundary, stop after one
    // last check at boundary (handled by the `dir === boundaryAbs` break).
    if (!parent.startsWith(boundaryWithSep) && parent !== boundaryAbs) break;
    dir = parent;
  }

  return null;
}

/**
 * GitStatusService provides git status information for files.
 *
 * Inspired by Crystal's GitStatusManager, but simplified for our use case
 * of showing git status for edited files in the AgenticPanel.
 */
export class GitStatusService {
  private cache: Map<string, { status: GitStatusResult; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 5000; // 5 seconds cache
  private static readonly rootSnapshots = new Map<string, RootStatusSnapshot>();
  private static readonly rootInFlight = new Map<string, RootStatusInFlight>();
  private static readonly rootGenerations = new Map<string, number>();
  private readonly expandUntrackedFiles: UntrackedExpander;
  private readonly analytics: Pick<AnalyticsService, 'sendEvent'>;

  constructor(options: GitStatusServiceOptions = {}) {
    this.expandUntrackedFiles = options.expandUntrackedFiles ?? getUntrackedFilesInDirectories;
    this.analytics = options.analytics ?? AnalyticsService.getInstance();
  }

  /**
   * Get git status for a list of files in a workspace.
   *
   * @param workspacePath The workspace/repository path
   * @param filePaths Array of file paths (relative to workspace) to check
   * @returns Map of file paths to their git status
   */
  async getFileStatus(workspacePath: string, filePaths: string[]): Promise<GitStatusResult> {
    if (!workspacePath || filePaths.length === 0) {
      return {};
    }

    // Check if git is available on the system
    if (!isGitAvailable()) {
      return this.createEmptyResult(filePaths);
    }

    // Group requested files by their owning git root.
    // - Files whose owning root is the workspace root (the original case).
    // - Files inside a nested git repo when the workspace root is not itself
    //   a git repo, or when the file lives in a sub-repo of a git workspace.
    // - Files outside any git repo within the workspace bounds.
    //
    // This is the core of the nested-repo fix (#122). Without grouping by
    // owning root, `git status --porcelain` runs against the workspace root
    // and either returns nothing (workspace not a repo) or returns paths
    // relative to the wrong root (workspace IS a repo but the file lives in
    // a nested submodule-style repo with its own .git).
    const filesByRoot = new Map<string, string[]>();
    const filesWithoutRoot: string[] = [];
    for (const filePath of filePaths) {
      const root = findGitRootForFile(filePath, workspacePath);
      if (!root) {
        filesWithoutRoot.push(filePath);
        continue;
      }
      const list = filesByRoot.get(root);
      if (list) {
        list.push(filePath);
      } else {
        filesByRoot.set(root, [filePath]);
      }
    }

    // No git repo anywhere in the picture - preserve old behavior.
    if (filesByRoot.size === 0) {
      return this.createEmptyResult(filePaths);
    }

    // Cache key includes every owning root we are about to query, so a
    // call mixing files from two different nested repos is cached
    // separately from a call that hits only one of them.
    const sortedRoots = Array.from(filesByRoot.keys()).sort();
    const sortedFiles = [...filePaths].sort().join(',');
    const cacheKey = `${workspacePath}\0${sortedRoots.join('\0')}\0${sortedFiles}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.status;
    }

    const result: GitStatusResult = {};

    for (const [rootPath, rootFiles] of filesByRoot) {
      let statusMap: Map<string, FileGitStatus>;
      try {
        const statusOutput = this.executeGitStatus(rootPath);
        statusMap = this.parseGitStatus(statusOutput);
      } catch (error) {
        logEbadfDiagnostic('GitStatusService', error);
        console.error('[GitStatusService] Error getting git status for root', rootPath, error);
        // On error for this root only, treat its files as unchanged. Don't
        // poison the cache - other roots may still succeed below.
        for (const fp of rootFiles) {
          result[fp] = { filePath: fp, status: 'unchanged' };
        }
        continue;
      }

      for (const filePath of rootFiles) {
        // git status --porcelain prints paths relative to the repo root.
        // Convert the requested filePath (may be absolute, may be relative
        // to the workspace) to the same relative-to-root form before
        // looking it up.
        const fileAbs = isAbsolute(filePath)
          ? filePath
          : resolve(workspacePath, filePath);
        const relToRoot = relative(rootPath, fileAbs).replace(/\\/g, '/');
        const normalizedPath = this.normalizePath(relToRoot);
        let status = statusMap.get(normalizedPath);

        // If file not found directly, check if it's inside an untracked directory
        // git status --porcelain shows untracked directories as a single entry (e.g., "?? plans/")
        // so files inside won't be listed individually
        if (!status) {
          // Walk up the path to see if any parent directory is untracked
          const pathParts = normalizedPath.split('/');
          for (let i = pathParts.length - 1; i > 0; i--) {
            const parentPath = pathParts.slice(0, i).join('/');
            const parentStatus = statusMap.get(parentPath);
            if (parentStatus && parentStatus.status === 'untracked') {
              // File is inside an untracked directory, so it's also untracked
              status = {
                filePath,
                status: 'untracked',
                gitStatusCode: '??'
              };
              break;
            }
          }
        }

        result[filePath] = status
          ? { ...status, filePath }
          : { filePath, status: 'unchanged' };
      }
    }

    // Files outside any git root - mirror the old non-git-workspace behavior
    // by marking them untracked so they still show in the edited-files UI.
    for (const fp of filesWithoutRoot) {
      result[fp] = { filePath: fp, status: 'untracked' };
    }

    // Cache the result
    this.cache.set(cacheKey, { status: result, timestamp: Date.now() });

    return result;
  }

  /**
   * Execute git status --porcelain command and return raw output
   * @private
   */
  private executeGitStatus(workspacePath: string): string {
    // IMPORTANT: Don't trim() here as it removes the leading space from status codes
    return execSync('git status --porcelain', {
      cwd: workspacePath,
      encoding: 'utf8',
      timeout: 5000, // 5 second timeout
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  /**
   * Parse git status --porcelain output into a map.
   *
   * Format: XY PATH
   * where XY is a two-character status code:
   * - First character: status in index (staged)
   * - Second character: status in working tree
   *
   * Common codes:
   * - ' M' = modified in working tree (not staged)
   * - 'M ' = modified and staged
   * - 'MM' = modified in both index and working tree
   * - 'A ' = added to index
   * - 'D ' = deleted from index
   * - ' D' = deleted in working tree
   * - '??' = untracked
   */
  private parseGitStatus(statusOutput: string): Map<string, FileGitStatus> {
    const statusMap = new Map<string, FileGitStatus>();

    if (!statusOutput) {
      return statusMap;
    }

    const lines = statusOutput.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;

      // Git status format: XY PATH (or XY PATH -> NEWPATH for renames)
      // where XY is 2 characters and there's a single space separator
      const code = line.substring(0, 2);
      let filePath = line.substring(3);

      // Handle renames (R  old -> new)
      if (code.startsWith('R')) {
        const parts = filePath.split(' -> ');
        filePath = parts[parts.length - 1]; // Use new path
      }

      filePath = this.normalizePath(filePath);

      // Determine status from code
      let status: FileGitStatus['status'];
      if (code === '??') {
        status = 'untracked';
      } else if (code === ' D' || code === 'D ' || code === 'DD') {
        status = 'deleted';
      } else if (code[0] !== ' ') {
        // First character not space = staged
        status = 'staged';
      } else if (code[1] !== ' ') {
        // Second character not space = modified in working tree
        status = 'modified';
      } else {
        status = 'unchanged';
      }

      statusMap.set(filePath, {
        filePath,
        status,
        gitStatusCode: code
      });
    }

    return statusMap;
  }

  /**
   * Check if a directory is a git repository
   */
  private isGitRepository(workspacePath: string): boolean {
    try {
      const gitDir = join(workspacePath, '.git');
      return existsSync(gitDir);
    } catch {
      return false;
    }
  }

  /**
   * Normalize file path (remove leading ./, handle quotes, trailing slashes, etc.)
   */
  private normalizePath(filePath: string): string {
    // Remove quotes that git adds for paths with spaces
    let normalized = filePath.replace(/^"|"$/g, '');

    // Remove leading ./
    if (normalized.startsWith('./')) {
      normalized = normalized.substring(2);
    }

    // Remove trailing slash (git shows untracked directories with trailing slash)
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    return normalized;
  }

  /**
   * Create empty result for non-git repos (all files as untracked).
   * This ensures checkboxes are shown for files in non-git directories.
   */
  private createEmptyResult(filePaths: string[]): GitStatusResult {
    const result: GitStatusResult = {};
    for (const filePath of filePaths) {
      result[filePath] = {
        filePath,
        status: 'untracked'
      };
    }
    return result;
  }

  /**
   * Build one repository-wide changed-file snapshot. Both whole-workspace and
   * worktree/session callers join this single flight so a large repository
   * never starts one `git ls-files` process per collapsed untracked directory.
   */
  private async getRootStatusSnapshot(
    workspacePath: string,
    callerClass: GitStatusCallerClass
  ): Promise<RootStatusSnapshot> {
    const repoRoot = resolve(workspacePath);
    const generation = GitStatusService.rootGenerations.get(repoRoot) ?? 0;
    const cached = GitStatusService.rootSnapshots.get(repoRoot);
    if (cached && cached.generation === generation && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached;
    }

    const existing = GitStatusService.rootInFlight.get(repoRoot);
    if (existing && existing.generation === generation) {
      existing.callers.add(callerClass);
      return existing.promise;
    }

    const controller = new AbortController();
    const inFlight: RootStatusInFlight = {
      generation,
      controller,
      callers: new Set([callerClass]),
      promise: Promise.resolve(undefined as never),
    };
    inFlight.promise = this.buildRootStatusSnapshot(repoRoot, inFlight);
    GitStatusService.rootInFlight.set(repoRoot, inFlight);

    try {
      const snapshot = await inFlight.promise;
      // An invalidation may have superseded this work while its Git process
      // was still exiting. Only the current generation may become reusable.
      if ((GitStatusService.rootGenerations.get(repoRoot) ?? 0) !== generation || controller.signal.aborted) {
        throw new Error('Git status snapshot invalidated');
      }
      GitStatusService.rootSnapshots.set(repoRoot, snapshot);
      return snapshot;
    } finally {
      if (GitStatusService.rootInFlight.get(repoRoot) === inFlight) {
        GitStatusService.rootInFlight.delete(repoRoot);
      }
    }
  }

  private async buildRootStatusSnapshot(
    repoRoot: string,
    inFlight: RootStatusInFlight
  ): Promise<RootStatusSnapshot> {
    const gitStartedAt = Date.now();
    const statusOutput = this.executeGitStatus(repoRoot);
    const gitDurationMs = Date.now() - gitStartedAt;
    this.throwIfAborted(inFlight.controller.signal);

    const result: GitStatusResult = {};
    const untrackedDirectories: string[] = [];
    for (const [relativePath, fileStatus] of this.parseGitStatus(statusOutput).entries()) {
      if (fileStatus.status === 'unchanged') continue;

      const absolutePath = resolve(repoRoot, relativePath);
      if (fileStatus.status === 'untracked') {
        try {
          if (statSync(absolutePath).isDirectory()) {
            untrackedDirectories.push(absolutePath);
            continue;
          }
        } catch {
          // A concurrently deleted path remains a normal status entry.
        }
      }

      result[absolutePath] = { ...fileStatus, filePath: absolutePath };
    }

    let expansionDurationMs = 0;
    let eventLoopLagMs = 0;
    if (untrackedDirectories.length > 0) {
      const lagStartedAt = Date.now();
      const eventLoopLag = new Promise<number>(resolveLag => {
        setImmediate(() => resolveLag(Math.min(Date.now() - lagStartedAt, 5000)));
      });
      const expansionStartedAt = Date.now();
      const relativeFiles = await this.expandUntrackedFiles(repoRoot, untrackedDirectories, {
        signal: inFlight.controller.signal,
        timeoutMs: 5000,
        maxBufferBytes: 8 * 1024 * 1024,
      });
      expansionDurationMs = Date.now() - expansionStartedAt;
      eventLoopLagMs = await eventLoopLag;
      this.throwIfAborted(inFlight.controller.signal);

      for (const relativePath of relativeFiles) {
        const filePath = resolve(repoRoot, relativePath);
        result[filePath] = { filePath, status: 'untracked', gitStatusCode: '??' };
      }

      const callers = inFlight.callers.size === 1
        ? Array.from(inFlight.callers)[0]
        : 'mixed';
      this.analytics.sendEvent('git_status_untracked_expanded', {
        workspace_hash: createHash('sha256').update(repoRoot).digest('hex').slice(0, 16),
        caller_class: callers,
        generation: Math.min(inFlight.generation, 1_000_000),
        in_flight_count: Math.min(GitStatusService.rootInFlight.size, 100),
        git_duration_ms: Math.min(gitDurationMs, 60_000),
        expansion_duration_ms: Math.min(expansionDurationMs, 60_000),
        untracked_directory_count: Math.min(untrackedDirectories.length, 100_000),
        untracked_result_count: Math.min(relativeFiles.length, 100_000),
        event_loop_lag_ms: eventLoopLagMs,
      });
    }

    const statuses = this.copyStatuses(result);
    return {
      generation: inFlight.generation,
      timestamp: Date.now(),
      statuses,
      uncommittedFiles: Object.keys(statuses),
    };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Git status snapshot invalidated');
  }

  private copyStatuses(statuses: GitStatusResult): GitStatusResult {
    return Object.fromEntries(Object.entries(statuses).map(([path, status]) => [path, { ...status }]));
  }

  /**
   * Get all uncommitted files in the workspace.
   * Returns files that are either:
   * - Untracked (not yet in git)
   * - Modified and not committed
   *
   * Does NOT include:
   * - Gitignored files
   * - Unchanged files
   *
   * @param workspacePath The workspace/repository path
   * @returns Array of file paths (relative to workspace) that have uncommitted changes
   */
  async getUncommittedFiles(
    workspacePath: string,
    callerClass: GitStatusCallerClass = 'whole_workspace'
  ): Promise<string[]> {
    if (!workspacePath) {
      return [];
    }

    // Check if git is available on the system
    if (!isGitAvailable()) {
      return [];
    }

    // Check if this is a git repository
    if (!this.isGitRepository(workspacePath)) {
      return [];
    }

    try {
      const snapshot = await this.getRootStatusSnapshot(workspacePath, callerClass);
      return [...snapshot.uncommittedFiles];
    } catch (error) {
      logEbadfDiagnostic('GitStatusService', error);
      console.error('[GitStatusService] Error getting uncommitted files:', error);
      // On error, return empty array
      return [];
    }
  }

  /**
   * Check if a workspace is a git repository
   *
   * @param workspacePath The workspace path to check
   * @returns True if workspace is a git repository
   */
  async isGitRepo(workspacePath: string): Promise<boolean> {
    return this.isGitRepository(workspacePath);
  }

  /**
   * Check if a workspace is a git worktree
   * A worktree is detected when .git is a file (not a directory) or when git rev-parse --git-dir contains "worktrees/"
   *
   * @param workspacePath The workspace path to check
   * @returns True if workspace is a git worktree
   */
  async isGitWorktree(workspacePath: string): Promise<boolean> {
    if (!workspacePath) {
      return false;
    }

    try {
      // Check if .git exists and is a file (not a directory)
      // In a worktree, .git is a file that points to the actual git directory
      const gitPath = join(workspacePath, '.git');
      const fs = require('fs');

      if (!existsSync(gitPath)) {
        return false;
      }

      const stats = fs.statSync(gitPath);
      if (stats.isFile()) {
        return true; // .git is a file = worktree
      }

      // Check if git is available before running git commands
      if (!isGitAvailable()) {
        return false;
      }

      // Also check via git command as a fallback
      const gitDir = execSync('git rev-parse --git-dir', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      // If git-dir contains "worktrees/", it's a worktree
      return gitDir.includes('worktrees/');
    } catch (error) {
      // If git command fails, not a git repo or worktree
      return false;
    }
  }

  /**
   * Get the main worktree path (repository root) for a given worktree
   *
   * @param workspacePath The worktree path
   * @returns The main worktree path, or null if not a worktree
   */
  private getMainWorktreePath(workspacePath: string): string | null {
    try {
      // Get the common git directory (contains the actual repo)
      const commonDir = execSync('git rev-parse --git-common-dir', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      // List all worktrees
      const worktreeList = execSync('git worktree list --porcelain', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Parse worktree list to find the main worktree
      const lines = worktreeList.split('\n');
      let currentPath: string | null = null;
      let currentBranch: string | null = null;

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          currentPath = line.substring('worktree '.length);
        } else if (line.startsWith('HEAD ')) {
          // This is the main worktree (has HEAD but no branch line follows)
          if (currentPath) {
            return currentPath;
          }
        } else if (line.startsWith('branch ')) {
          currentBranch = line.substring('branch '.length).replace('refs/heads/', '');
        } else if (line === '') {
          // End of worktree entry
          // Main worktree typically comes first and has no specific branch in the format
          currentPath = null;
          currentBranch = null;
        }
      }

      // Fallback: find the first worktree (which is usually the main one)
      const firstWorktreeMatch = worktreeList.match(/^worktree (.+)$/m);
      if (firstWorktreeMatch) {
        return firstWorktreeMatch[1];
      }

      return null;
    } catch (error) {
      console.error('[GitStatusService] Error getting main worktree path:', error);
      return null;
    }
  }

  /**
   * Get the current branch name for a workspace
   *
   * @param workspacePath The workspace path
   * @returns The current branch name, or null if detached HEAD or error
   */
  private getCurrentBranch(workspacePath: string): string | null {
    try {
      const branch = execSync('git branch --show-current', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      return branch || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get files modified in the worktree relative to the main repository branch
   * Returns absolute file paths for:
   * 1. Files committed in worktree branch but not in main branch
   * 2. Files with uncommitted changes (staged, modified, or untracked)
   *
   * @param workspacePath The worktree path
   * @returns Array of absolute file paths modified in the worktree
   */
  async getWorktreeModifiedFiles(workspacePath: string): Promise<string[]> {
    if (!workspacePath) {
      return [];
    }

    // Check if this is a worktree
    const isWorktree = await this.isGitWorktree(workspacePath);
    if (!isWorktree) {
      return [];
    }

    // Check cache
    const cacheKey = `${workspacePath}:worktree-modified`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return Object.keys(cached.status);
    }

    try {
      // Get the current branch of this worktree
      const worktreeBranch = this.getCurrentBranch(workspacePath);
      if (!worktreeBranch) {
        console.error('[GitStatusService] Could not determine worktree branch');
        return [];
      }

      // Get the main worktree path
      const mainWorktreePath = this.getMainWorktreePath(workspacePath);
      if (!mainWorktreePath) {
        console.error('[GitStatusService] Could not determine main worktree path');
        return [];
      }

      // Get the current branch of the main repository
      const mainBranch = this.getCurrentBranch(mainWorktreePath);
      if (!mainBranch) {
        console.error('[GitStatusService] Could not determine main repository branch');
        return [];
      }

      // Use a Set to collect unique file paths
      const filePathSet = new Set<string>();
      const cacheResult: GitStatusResult = {};

      // 1. Get files committed in worktree branch but not in main branch
      // Use three-dot diff to show changes in worktree branch since it diverged from main branch
      const diffOutput = execSync(`git diff --name-only ${mainBranch}...${worktreeBranch}`, {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      if (diffOutput) {
        const lines = diffOutput.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;

          const relativePath = this.normalizePath(line);
          const absolutePath = resolve(workspacePath, relativePath);
          filePathSet.add(absolutePath);

          cacheResult[absolutePath] = {
            filePath: absolutePath,
            status: 'modified'
          };
        }
      }

      // 2. Get uncommitted files (staged, modified, or untracked)
      const uncommittedFiles = await this.getUncommittedFiles(workspacePath, 'worktree_session');
      for (const absolutePath of uncommittedFiles) {
        filePathSet.add(absolutePath);

        // Only add to cache if not already there
        if (!cacheResult[absolutePath]) {
          cacheResult[absolutePath] = {
            filePath: absolutePath,
            status: 'modified'
          };
        }
      }

      // Cache the result
      this.cache.set(cacheKey, { status: cacheResult, timestamp: Date.now() });

      // Convert Set to Array
      return Array.from(filePathSet);
    } catch (error) {
      logEbadfDiagnostic('GitStatusService', error);
      console.error('[GitStatusService] Error getting worktree modified files:', error);
      return [];
    }
  }

  /**
   * Get all changed files with their git status.
   * Returns a map of absolute file paths to their status (modified, staged, untracked, deleted).
   * Does NOT include unchanged files or gitignored files.
   *
   * @param workspacePath The workspace/repository path
   * @returns Map of absolute file paths to their git status
   */
  async getAllFileStatuses(workspacePath: string): Promise<GitStatusResult> {
    if (!workspacePath) {
      return {};
    }

    // Check if git is available on the system
    if (!isGitAvailable()) {
      return {};
    }

    // Check if this is a git repository
    if (!this.isGitRepository(workspacePath)) {
      return {};
    }

    try {
      const snapshot = await this.getRootStatusSnapshot(workspacePath, 'whole_workspace');
      return this.copyStatuses(snapshot.statuses);
    } catch (error) {
      logEbadfDiagnostic('GitStatusService', error);
      console.error('[GitStatusService] Error getting all file statuses:', error);
      return {};
    }
  }

  /**
   * Check if a workspace has a GitHub remote
   *
   * @param workspacePath The workspace path to check
   * @returns True if the workspace has a GitHub remote URL
   */
  async hasGitHubRemote(workspacePath: string): Promise<boolean> {
    if (!workspacePath) {
      return false;
    }

    // Check if this is a git repository
    if (!this.isGitRepository(workspacePath)) {
      return false;
    }

    // Check if git is available
    if (!isGitAvailable()) {
      return false;
    }

    try {
      // Get remote URL (typically origin)
      const remoteUrl = execSync('git remote get-url origin', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      // Check if URL contains github.com
      return remoteUrl.includes('github.com');
    } catch (error) {
      // If command fails (no remote), return false
      return false;
    }
  }

  /**
   * Parse the workspace's origin remote into an `owner/repo` tuple plus host.
   *
   * Used by the PR review panel to decide whether to show the
   * "Pull Requests" gutter button and to drive `gh api` requests. Supports
   * both SSH (`git@host:owner/repo.git`) and HTTPS (`https://host/owner/repo.git`)
   * origins, and arbitrary hosts (GitHub Enterprise — `gh` handles the
   * underlying authentication; we only need to pass `owner/repo`).
   *
   * Returns null when no origin exists, when git is unavailable, or when the
   * URL cannot be parsed.
   */
  async parseGitHubRemote(workspacePath: string): Promise<{ remote: string; host: string } | null> {
    if (!workspacePath) {
      return null;
    }
    if (!this.isGitRepository(workspacePath)) {
      return null;
    }
    if (!isGitAvailable()) {
      return null;
    }

    let remoteUrl: string;
    try {
      remoteUrl = execSync('git remote get-url origin', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }

    return parseGitRemoteUrl(remoteUrl);
  }

  /**
   * Clear the cache for a specific workspace or all workspaces
   */
  clearCache(workspacePath?: string): void {
    if (workspacePath) {
      const repoRoot = resolve(workspacePath);
      GitStatusService.rootGenerations.set(
        repoRoot,
        (GitStatusService.rootGenerations.get(repoRoot) ?? 0) + 1
      );
      GitStatusService.rootSnapshots.delete(repoRoot);
      const active = GitStatusService.rootInFlight.get(repoRoot);
      active?.controller.abort();
      GitStatusService.rootInFlight.delete(repoRoot);

      // Clear cache entries for this workspace.
      //
      // Two key shapes coexist:
      //   1) `${workspacePath}:uncommitted` and `${workspacePath}\0all-statuses`
      //      and the legacy `${workspacePath}:${filePaths}` shape used by older
      //      `getFileStatus` callers.
      //   2) The new nested-repo `${workspacePath}\0${sortedRoots}\0${files}`
      //      shape introduced for the multi-root grouping in `getFileStatus`.
      //
      // The colon-prefix predicate alone misses the new null-byte keys, so a
      // git ref-watcher invalidation would leave per-file cache entries stale
      // for up to the 5 second TTL. Match either separator here.
      const keysToDelete: string[] = [];
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${workspacePath}:`) || key.startsWith(`${workspacePath}\0`)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => this.cache.delete(key));
    } else {
      // Clear entire cache
      this.cache.clear();
      for (const active of GitStatusService.rootInFlight.values()) {
        active.controller.abort();
      }
      GitStatusService.rootInFlight.clear();
      GitStatusService.rootSnapshots.clear();
      GitStatusService.rootGenerations.clear();
    }
  }

}

/**
 * Pure helper that parses a git remote URL into `{ remote, host }`.
 *
 * Exported for unit testing and reuse by IPC handlers. Supports the four
 * shapes git itself emits:
 *   - `git@github.com:owner/repo.git`
 *   - `ssh://git@github.com/owner/repo.git`
 *   - `https://github.com/owner/repo.git`
 *   - `https://github.com/owner/repo`
 *
 * Returns null when the URL doesn't resemble a git host URL or the path
 * doesn't carry an `owner/repo` segment.
 */
export function parseGitRemoteUrl(url: string): { remote: string; host: string } | null {
  if (!url) return null;

  // SSH shorthand: git@host:owner/repo(.git)
  const sshMatch = url.match(/^(?:[\w.-]+@)?([\w.-]+):([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { host: sshMatch[1], remote: sshMatch[2] };
  }

  // ssh:// or https:// URL
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.replace(/^\//, '').split('/');
    if (segments.length < 2) return null;
    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/, '');
    if (!owner || !repo) return null;
    return { host: parsed.hostname, remote: `${owner}/${repo}` };
  } catch {
    return null;
  }
}
