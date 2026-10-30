import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';
import { GitCatFileBatch } from './GitCatFileBatch';

function execFileAsync(cmd: string, args: string[], opts: { cwd?: string; timeout?: number; maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });
}

/**
 * Paths from `git status --porcelain -z`. Without `-z` git quotes and escapes
 * names with spaces or non-ASCII characters, which then never resolve on disk.
 * A rename or copy record is followed by its source path as a separate entry;
 * that entry is skipped because only the destination exists in the worktree.
 */
export function parseDirtyPathsPorcelainZ(stdout: string): string[] {
  const records = stdout.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status.includes('R') || status.includes('C')) index++;
  }
  return paths;
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.flac',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.sqlite', '.db', '.lock',
  '.wasm', '.node',
  // Electron/packaged-app bundle artifacts — caching these blew up memory when
  // release-smoke-backup-marker/ was accidentally dropped into the workspace.
  '.pak', '.pdb', '.dat', '.bin', '.blockmap', '.asar', '.icns', '.appimage',
  '.dmg', '.deb', '.rpm', '.snap', '.msi', '.nupkg',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.svelte-kit', 'worktrees',
  '.vscode', '.idea', 'target', '.DS_Store',
]);

const MAX_FILE_SIZE = 1_000_000; // 1MB
const MAX_CACHE_BYTES = 100_000_000; // 100MB memory cap
const MAX_DIRTY_FILES = 200; // Cap upfront file reads to avoid I/O storms from large dirty sets
const MAX_FULL_SCAN_FILES = 500; // Higher cap for non-git repos (no git fallback available)

export class FileSnapshotCache {
  private cache = new Map<string, string>();
  private totalBytes = 0;
  private workspacePath: string | null = null;
  private sessionId: string | null = null;
  private isGitRepo = false;
  private startSha: string | null = null;
  /**
   * Lazily started per session. Baseline lookups used to spawn a `git show`
   * per file; on a memory-pressured machine one spawn measured ~1.9s and
   * twelve of them accounted for 22.4s of a single 23s freeze.
   */
  private catFile: GitCatFileBatch | null = null;
  /** The cap warning fires once per session; per-file logging flooded main.log (#1599). */
  private capWarned = false;

  async startSession(workspacePath: string, sessionId: string): Promise<void> {
    this.stopSession();
    this.workspacePath = workspacePath;
    this.sessionId = sessionId;

    this.isGitRepo = await this.detectGitRepo(workspacePath);

    if (this.isGitRepo) {
      await this.initGitCache(workspacePath);
    } else {
      await this.initFullScan(workspacePath);
    }

    // logger.main.info('[FileSnapshotCache] Session started', this.getStats());
  }

  stopSession(): void {
    this.cache.clear();
    this.totalBytes = 0;
    this.workspacePath = null;
    this.sessionId = null;
    this.isGitRepo = false;
    this.startSha = null;
    this.catFile?.dispose();
    this.catFile = null;
    this.capWarned = false;
  }

  async getBeforeState(filePath: string): Promise<string | null> {
    // Tier 1: in-memory cache
    const cached = this.cache.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    // Tier 2: git on-demand
    if (this.isGitRepo && this.startSha && this.workspacePath) {
      try {
        const resolved = await this.resolveRelativePathInWorkspace(filePath);
        if (!resolved) return null;

        const content = await this.gitShow(resolved.workspacePath, this.startSha, resolved.relativePath);
        // Cache for future lookups
        this.addToCache(filePath, content);
        return content;
      } catch {
        // File didn't exist at startSha (untracked or new)
        return null;
      }
    }

    // Non-git and not in cache: file is new
    return null;
  }

  updateSnapshot(filePath: string, content: string): void {
    this.addToCache(filePath, content);
  }

  /**
   * Returns true when this file is already in the in-memory cache (tier 1).
   * Does NOT consult tier 2 git fallback; intended for callers that need to
   * distinguish "we have a session-lifetime baseline" from "we'd be making
   * one up from committed state".
   */
  hasSnapshot(filePath: string): boolean {
    return this.cache.has(filePath);
  }

  removeSnapshot(filePath: string): void {
    const existing = this.cache.get(filePath);
    if (existing !== undefined) {
      this.totalBytes -= Buffer.byteLength(existing, 'utf-8');
      this.cache.delete(filePath);
    }
  }

  getStats(): { fileCount: number; totalBytes: number; sessionId: string | null; isGitRepo: boolean } {
    return {
      fileCount: this.cache.size,
      totalBytes: this.totalBytes,
      sessionId: this.sessionId,
      isGitRepo: this.isGitRepo,
    };
  }

  private addToCache(filePath: string, content: string): void {
    // Remove old entry size if replacing
    const existing = this.cache.get(filePath);
    if (existing !== undefined) {
      this.totalBytes -= Buffer.byteLength(existing, 'utf-8');
    }

    const byteLen = Buffer.byteLength(content, 'utf-8');

    // Enforce memory cap - skip caching if over limit (git fallback still works)
    if (this.totalBytes + byteLen > MAX_CACHE_BYTES && existing === undefined) {
      if (!this.capWarned) {
        this.capWarned = true;
        logger.main.warn('[FileSnapshotCache] Memory cap reached; further files use git fallback only:', {
          sessionId: this.sessionId,
          fileCount: this.cache.size,
          totalBytes: this.totalBytes,
          firstSkipped: filePath,
        });
      }
      return;
    }

    this.cache.set(filePath, content);
    this.totalBytes += byteLen;
  }

  private async detectGitRepo(workspacePath: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], {
        cwd: workspacePath,
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async initGitCache(workspacePath: string): Promise<void> {
    // Capture starting commit SHA
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: workspacePath,
        timeout: 5000,
      });
      this.startSha = stdout.trim();
    } catch {
      // Repo with no commits yet
      this.startSha = null;
      logger.main.warn('[FileSnapshotCache] No commits in repo, treating as non-git for caching');
      await this.initFullScan(workspacePath);
      return;
    }

    // Get dirty files (tracked + untracked) via git status
    try {
      // `--no-optional-locks` keeps this read-only status from refreshing (and
      // so locking) `.git/index`, where it would contend with concurrent git
      // writers such as the commit path (NIM-2285).
      const { stdout } = await execFileAsync('git', ['--no-optional-locks', 'status', '--porcelain', '-z'], {
        cwd: workspacePath,
        timeout: 10000,
        maxBuffer: 5_000_000, // 5MB cap on git status output
      });
      const dirtyFiles = new Set(parseDirtyPathsPorcelainZ(stdout));

      if (dirtyFiles.size > MAX_DIRTY_FILES) {
        logger.main.warn(`[FileSnapshotCache] ${dirtyFiles.size} dirty files exceeds limit of ${MAX_DIRTY_FILES}, caching only first ${MAX_DIRTY_FILES} (rest use git fallback)`);
      }

      // Read each dirty file into cache (capped to avoid I/O storms)
      let cached = 0;
      for (const relativePath of dirtyFiles) {
        if (cached >= MAX_DIRTY_FILES) break;

        const absPath = path.resolve(workspacePath, relativePath);
        if (this.isBinaryPath(absPath)) continue;

        try {
          // For dirty/untracked files, read current content as pre-session baseline
          const content = await this.readFileIfEligible(absPath);
          if (content !== null) {
            this.addToCache(absPath, content);
            cached++;
          }
        } catch {
          // Skip files that can't be read
        }
      }
    } catch (error) {
      logger.main.error('[FileSnapshotCache] Failed to scan dirty files:', error);
    }
  }

  private async initFullScan(workspacePath: string): Promise<void> {
    try {
      await this.walkAndCache(workspacePath, workspacePath);
    } catch (error) {
      logger.main.error('[FileSnapshotCache] Full scan failed:', error);
    }
  }

  private async walkAndCache(dir: string, rootPath: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.walkAndCache(fullPath, rootPath);
      } else if (entry.isFile()) {
        if (this.isBinaryPath(fullPath)) continue;
        if (this.cache.size >= MAX_FULL_SCAN_FILES || this.totalBytes >= MAX_CACHE_BYTES) break;

        const content = await this.readFileIfEligible(fullPath);
        if (content !== null) {
          this.addToCache(fullPath, content);
        }
      }
    }
  }

  private async readFileIfEligible(filePath: string): Promise<string | null> {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_FILE_SIZE) return null;

      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Content at `sha`, served by one long-lived `git cat-file --batch` process
   * for the whole session rather than a spawn per file.
   *
   * Throws when the object is absent so the existing caller contract holds:
   * `getBeforeState` treats a throw as "the file did not exist at startSha".
   */
  private async gitShow(workspacePath: string, sha: string, relativePath: string): Promise<string> {
    if (!this.catFile) {
      this.catFile = new GitCatFileBatch(workspacePath, { maxObjectBytes: MAX_FILE_SIZE });
    }
    const content = await this.catFile.read(sha, relativePath);
    if (content === null) {
      throw new Error(`not in ${sha}: ${relativePath}`);
    }
    return content;
  }

  /**
   * Resolve file path to a safe, workspace-relative path.
   *
   * Primary path uses raw workspace/file strings.
   * Fallback handles symlink/casing differences by comparing canonical realpaths.
   */
  private async resolveRelativePathInWorkspace(
    filePath: string
  ): Promise<{ workspacePath: string; relativePath: string } | null> {
    if (!this.workspacePath) return null;

    const directRelative = path.relative(this.workspacePath, filePath);
    if (this.isRelativeInsideWorkspace(directRelative)) {
      return { workspacePath: this.workspacePath, relativePath: directRelative };
    }

    try {
      const [realWorkspacePath, realFilePath] = await Promise.all([
        fs.realpath(this.workspacePath),
        fs.realpath(filePath),
      ]);
      const canonicalRelative = path.relative(realWorkspacePath, realFilePath);
      if (!this.isRelativeInsideWorkspace(canonicalRelative)) {
        return null;
      }
      return { workspacePath: realWorkspacePath, relativePath: canonicalRelative };
    } catch {
      return null;
    }
  }

  private isRelativeInsideWorkspace(relativePath: string): boolean {
    return !!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
  }

  private isBinaryPath(filePath: string): boolean {
    return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }
}
