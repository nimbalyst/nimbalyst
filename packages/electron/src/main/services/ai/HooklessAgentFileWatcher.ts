/**
 * Per-session file watcher manager for agent providers (claude-code, codex,
 * opencode, copilot-cli, ...). These providers execute file edits via their
 * own internal mechanisms — we don't always get a tool-call event we can
 * attribute. We run a chokidar-backed `SessionFileWatcher` rooted at the
 * workspace, paired with a `FileSnapshotCache` that captures pre-edit
 * baselines, so the diff/pending-review pipeline works.
 *
 * Claude Code hooks Edit/Write at the SDK level so most edits don't need this,
 * but its Bash invocations still flow through `trackBashEditsFromCommand`,
 * which is why a watcher is started for it too.
 *
 * Lifecycle:
 *   - `ensureForSession` — start (or reuse) a watcher for a session/workspace
 *   - `scheduleStop` — schedule a delayed shutdown so pending watcher events
 *     can drain after a turn completes
 *   - `stopForSession` — synchronously stop a watcher (cancels any scheduled
 *     stop and tears down the watcher + cache)
 *   - `getEntry` — read access for code that needs the cache (e.g.
 *     `advanceDiffBaseline`, `trackBashEditsFromCommand`)
 *   - `captureBashPreEditSnapshots` — call at `item.started` for a Bash
 *     command to seed the FileSnapshotCache with current disk content for
 *     each file referenced in the command. This guarantees that
 *     `trackBashEditsFromCommand` (run later at `item.completed`) compares
 *     against a true pre-command baseline, so read-only commands like
 *     `sed -n` no longer false-attribute when the working tree differs from
 *     `HEAD`/`startSha`.
 *   - `trackBashEditsFromCommand` — when an agent runs a Bash command,
 *     attempt to discover edited files in the command and create pre-edit
 *     tags + session file links the same way the watcher would
 *   - `destroy` — clear all timers and stop all watchers (called on AIService
 *     shutdown)
 */

import * as fs from 'fs';
import * as path from 'path';
import { type SessionData } from '@nimbalyst/runtime/ai/server/types';
import { SessionFilesRepository } from '@nimbalyst/runtime';
import { logger } from '../../utils/logger';
import { historyManager } from '../../HistoryManager';
import { FileSnapshotCache } from '../../file/FileSnapshotCache';
import { SessionFileWatcher } from '../../file/SessionFileWatcher';
import { addGitignoreBypass } from '../../file/WorkspaceEventBus';
import { workspaceFileEditAttributionService } from '../WorkspaceFileEditAttributionService';
import { isFileInWorkspaceOrWorktree } from '../../utils/workspaceDetection';
import {
  safeSend,
  readFileContentOrNull,
  recoverBaselineFromHistory,
  isBinaryFile,
} from './aiServiceUtils';

interface WatcherEntry {
  cache: FileSnapshotCache;
  watcher: SessionFileWatcher;
  workspacePath: string;
}

export class HooklessAgentFileWatcher {
  private readonly watchers = new Map<string, WatcherEntry>();
  private readonly stopTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Start (or reuse) a watcher for a session at the given workspace path.
   * If an existing watcher targets a different path, it is replaced.
   * Cancels any pending scheduled-stop for the session.
   */
  async ensureForSession(
    sessionId: string,
    workspacePath: string,
    event: Electron.IpcMainInvokeEvent,
  ): Promise<void> {
    // Cancel any pending delayed-stop timer so it doesn't destroy the watcher
    // we're about to reuse (race: new turn starts within the 500ms drain delay).
    this.cancelScheduledStop(sessionId);

    const existing = this.watchers.get(sessionId);
    if (existing && existing.workspacePath === workspacePath) {
      return;
    }

    if (existing) {
      try {
        await existing.watcher.stop();
        existing.cache.stopSession();
      } catch (error) {
        logger.main.error('[HooklessAgentFileWatcher] Failed to stop existing watcher:', error);
      }
      this.watchers.delete(sessionId);
    }

    const cache = new FileSnapshotCache();
    const watcher = new SessionFileWatcher();
    await cache.startSession(workspacePath, sessionId);

    // Seed the cache with current disk content for files that have prior tags
    // from this session but aren't in the cache (e.g., gitignored files).
    // Without this, the proactive file_change handler would fall through to
    // recoverBaselineFromHistory and potentially use a stale pre-edit baseline.
    try {
      const taggedFiles = await historyManager.getTaggedFilesForSession(workspacePath, sessionId);
      const MAX_SEED_FILES = 50;
      let seeded = 0;
      for (const filePath of taggedFiles) {
        if (seeded >= MAX_SEED_FILES) break;
        const existingSnapshot = await cache.getBeforeState(filePath);
        if (existingSnapshot !== null) continue;
        const content = await readFileContentOrNull(filePath);
        if (content !== null) {
          cache.updateSnapshot(filePath, content);
          seeded++;
        }
      }
      if (seeded > 0) {
        logger.main.info('[HooklessAgentFileWatcher] Seeded cache with historical files:', { sessionId, seeded, total: taggedFiles.length });
      }
    } catch (seedError) {
      logger.main.warn('[HooklessAgentFileWatcher] Failed to seed cache with historical files:', seedError);
    }

    await watcher.start(
      workspacePath,
      sessionId,
      cache,
      async (watchEvent) => {
        workspaceFileEditAttributionService.ingestWatcherEvent({
          workspacePath: watchEvent.workspacePath,
          filePath: watchEvent.filePath,
          timestamp: watchEvent.timestamp,
          beforeContent: watchEvent.beforeContent,
        });
        safeSend(event, 'session-files:updated', sessionId);
      },
    );
    this.watchers.set(sessionId, { cache, watcher, workspacePath });
  }

  /**
   * Schedule a delayed stop so pending watcher events have time to drain.
   * If a new turn starts before the timer fires, `ensureForSession` cancels it.
   */
  scheduleStop(sessionId: string, delayMs: number): void {
    // Replace any existing scheduled stop.
    this.cancelScheduledStop(sessionId);
    const timer = setTimeout(() => {
      this.stopTimers.delete(sessionId);
      void this.stopForSession(sessionId);
    }, delayMs);
    this.stopTimers.set(sessionId, timer);
  }

  cancelScheduledStop(sessionId: string): void {
    const pendingTimer = this.stopTimers.get(sessionId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.stopTimers.delete(sessionId);
    }
  }

  async stopForSession(sessionId: string): Promise<void> {
    this.cancelScheduledStop(sessionId);

    const entry = this.watchers.get(sessionId);
    if (!entry) return;

    try {
      await entry.watcher?.stop();
      entry.cache.stopSession();
    } catch (error) {
      logger.main.error('[HooklessAgentFileWatcher] Error stopping watcher:', error);
    } finally {
      this.watchers.delete(sessionId);
    }
  }

  getEntry(sessionId: string): WatcherEntry | undefined {
    return this.watchers.get(sessionId);
  }

  /**
   * Advance the FileSnapshotCache baseline for a file after a diff is accepted/rejected.
   * This ensures subsequent AI edits use the post-review content as the diff baseline,
   * preventing "baseline drift" where already-accepted changes reappear in future diffs.
   */
  advanceDiffBaseline(sessionId: string, filePath: string, content: string): void {
    const entry = this.watchers.get(sessionId);
    if (!entry) {
      // Watcher may have been stopped between turns — not an error
      return;
    }
    entry.cache.updateSnapshot(filePath, content);
    logger.main.debug('[HooklessAgentFileWatcher] Advanced diff baseline:', {
      sessionId,
      filePath,
      contentLength: content.length,
    });
  }

  /**
   * For Bash tool calls in agent sessions: scan the command for plausible file
   * paths and seed `FileSnapshotCache` with each file's current disk content
   * so the cache holds a real pre-command baseline before the bash command
   * runs. Skips files already in the cache so we don't clobber an in-flight
   * pre-edit baseline from an earlier write in this turn.
   *
   * Why: without this, `trackBashEditsFromCommand` later compares post-command
   * disk content against `cache.getBeforeState`, which falls through to git
   * `startSha` (committed) content when the in-memory cache misses. Any file
   * with uncommitted modifications at session start then looks "edited" by a
   * read-only command (`sed -n`, `cat`, `nl`), producing false attributions
   * across sessions.
   */
  async captureBashPreEditSnapshots(
    sessionId: string,
    workspacePath: string,
    command: string,
  ): Promise<void> {
    const watcherEntry = this.watchers.get(sessionId);
    if (!watcherEntry) return;

    const cwd = watcherEntry.workspacePath;
    const filePaths = await this.extractFilePathsFromCommand(command, workspacePath, cwd);
    if (filePaths.length === 0) return;

    for (const filePath of filePaths) {
      // Preserve any existing in-session snapshot (initGitCache, prior write
      // in this turn). The user opted for seed-if-missing so a parallel-bash
      // race can't erase an earlier command's pre-edit baseline.
      if (watcherEntry.cache.hasSnapshot(filePath)) continue;
      if (isBinaryFile(filePath)) continue;

      const content = await readFileContentOrNull(filePath);
      if (content === null) continue;

      watcherEntry.cache.updateSnapshot(filePath, content);
    }
  }

  /**
   * For Bash tool calls in agent sessions: scan the command for plausible file
   * paths, and for each one create a pre-edit tag + session file link.
   * Mirrors the work the `file_change` watcher path would have done if the
   * agent had emitted a structured edit event.
   */
  async trackBashEditsFromCommand(
    session: SessionData,
    workspacePath: string,
    command: string,
    commandItemId?: string,
  ): Promise<boolean> {
    const effectivePath = session.worktreePath || workspacePath;
    const watcherEntry = this.watchers.get(session.id);
    const filePaths = await this.extractFilePathsFromCommand(command, workspacePath, effectivePath);
    if (filePaths.length === 0) return false;

    let trackedAny = false;

    // Register gitignore bypass so watcher events fire for bash-edited files.
    for (const fp of filePaths) {
      addGitignoreBypass(effectivePath, fp);
    }

    for (const filePath of filePaths) {
      try {
        await fs.promises.access(filePath);
        if (isBinaryFile(filePath)) continue;
      } catch {
        // File does not exist - proceed (it may be a new file)
      }

      const currentContentResult = await readFileContentOrNull(filePath);
      if (currentContentResult === null) {
        // Non-ENOENT read failure (EACCES, EISDIR for races where a path
        // resolves to a directory after our extractor's stat check, etc.).
        // Best-effort tracking: skip silently — operators can't act on this.
        logger.main.debug('[HooklessAgentFileWatcher] Failed to read current Bash content:', {
          sessionId: session.id,
          filePath,
        });
        continue;
      }
      const currentContent = currentContentResult;

      const pendingTags = await historyManager.getPendingTags(filePath);
      const existingTag = pendingTags?.find(t => t.sessionId === session.id);
      if (existingTag && existingTag.content.length > 0) {
        // Tag already exists with real content - nothing to do
        watcherEntry?.cache.updateSnapshot(filePath, currentContent);
        continue;
      }

      let beforeContent: string | null = null;

      // In-memory cache only. We deliberately bypass `getBeforeState`'s tier-2
      // git-`startSha` fallback here: that path returns committed content,
      // which differs from the working tree for any file dirty at session
      // start, and any read-only command (`sed -n`, `cat`, `nl`) then looks
      // like an edit. `captureBashPreEditSnapshots` should have already seeded
      // a real working-tree baseline at `item.started`; if it didn't, fall
      // through to history rather than fabricating one from `HEAD`.
      if (watcherEntry) {
        const cachedBaseline = watcherEntry.cache.hasSnapshot(filePath)
          ? await watcherEntry.cache.getBeforeState(filePath)
          : null;
        if (cachedBaseline !== null) {
          beforeContent = cachedBaseline;
        }
      }

      if (beforeContent === null) {
        const recoveredBaseline = await recoverBaselineFromHistory(filePath, currentContent);
        if (recoveredBaseline !== null) {
          beforeContent = recoveredBaseline;
        }
      }

      // No `git show HEAD:` last-resort fallback. It produced the cross-session
      // false-attribution bug for `sed -n`-style read-only commands run against
      // working-tree-modified files. If neither the in-memory cache nor local
      // history can supply a real baseline, skip the bash-watcher tag and let
      // an authoritative writer (file_change pre_edit_snapshot, OpenCode /
      // Codex-ACP edit tools) attribute later.
      if (beforeContent === null) {
        logger.main.debug('[HooklessAgentFileWatcher] Skipping bash tag — no real baseline available:', {
          sessionId: session.id,
          filePath,
        });
        watcherEntry?.cache.updateSnapshot(filePath, currentContent);
        continue;
      }

      const resolvedBeforeContent = beforeContent;

      // If baseline equals current content, command did not materially change this file.
      if (resolvedBeforeContent === currentContent) {
        watcherEntry?.cache.updateSnapshot(filePath, currentContent);
        continue;
      }

      // If an existing tag with empty content was found earlier, upgrade it
      // instead of creating a new tag (defense-in-depth for Fix 2).
      if (existingTag && existingTag.content.length === 0 && resolvedBeforeContent.length > 0) {
        await historyManager.createTag(
          effectivePath,
          filePath,
          existingTag.id,
          resolvedBeforeContent,
          session.id,
          existingTag.toolUseId,
        );
        logger.main.info('[HooklessAgentFileWatcher] Upgraded empty bash tag with baseline:', {
          sessionId: session.id, filePath, tagId: existingTag.id,
        });
        watcherEntry?.cache.updateSnapshot(filePath, currentContent);
        continue;
      }

      const toolUseId = commandItemId || `codex-bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tagId = `ai-edit-pending-${session.id}-${toolUseId}`;

      await historyManager.createTag(
        effectivePath,
        filePath,
        tagId,
        resolvedBeforeContent,
        session.id,
        toolUseId,
      );

      await SessionFilesRepository.addFileLink({
        sessionId: session.id,
        workspaceId: effectivePath,
        filePath,
        linkType: 'edited',
        timestamp: Date.now(),
        metadata: {
          toolName: 'Bash',
          operation: 'bash',
          toolUseId,
          bashCommand: command.slice(0, 500),
        },
      });
      watcherEntry?.cache.updateSnapshot(filePath, currentContent);
      trackedAny = true;
    }

    return trackedAny;
  }

  destroy(): void {
    for (const timer of this.stopTimers.values()) {
      clearTimeout(timer);
    }
    this.stopTimers.clear();

    for (const [sessionId, entry] of this.watchers) {
      try {
        entry.watcher?.stop();
        entry.cache.stopSession();
      } catch (error) {
        console.error(`[HooklessAgentFileWatcher] Error stopping watcher for ${sessionId}:`, error);
      }
    }
    this.watchers.clear();
  }

  private async extractFilePathsFromCommand(
    command: string,
    workspacePath: string,
    cwd: string,
  ): Promise<string[]> {
    return extractFilePathsFromCommand(command, workspacePath, cwd);
  }
}

/**
 * Scan a Bash command for plausible file paths within the workspace.
 * Returns absolute, real (symlink-resolved) paths to *regular files only* —
 * directories are filtered out so commands like `find /dir` or `ls /dir`
 * don't pollute the candidate set with unreadable entries. Used by
 * `trackBashEditsFromCommand` to discover which files an agent's bash
 * command touched.
 *
 * Exported for unit testing.
 */
export async function extractFilePathsFromCommand(
  command: string,
  workspacePath: string,
  cwd: string,
): Promise<string[]> {
  const results = new Set<string>();
  const normalizedCommand = command.replace(/\\/g, path.sep);

  const resolveAndCheck = async (candidate: string): Promise<void> => {
    try {
      // Resolve symlinks so boundary check cannot be bypassed via symlinks.
      const realPath = await fs.promises.realpath(candidate);
      if (!isFileInWorkspaceOrWorktree(realPath, workspacePath)) return;
      // Skip non-regular files (directories, sockets, fifos). Bash commands
      // routinely reference directories as positional args; without this
      // filter every such mention later fails `readFile` with EISDIR.
      const stats = await fs.promises.stat(realPath);
      if (!stats.isFile()) return;
      results.add(realPath);
    } catch {
      // File does not exist or is inaccessible - skip
    }
  };

  const candidates: string[] = [];

  const absoluteMatches = [
    ...(normalizedCommand.match(/\/[^\s'"]+/g) || []),
    ...(normalizedCommand.match(/[A-Za-z]:[\\\/][^\s'"]+/g) || []),
  ];
  for (const raw of absoluteMatches) {
    const cleaned = raw.replace(/[);:,]+$/, '');
    if (!cleaned) continue;
    candidates.push(path.normalize(cleaned));
  }

  const tokens = normalizedCommand.split(/\s+/);
  for (const token of tokens) {
    if (!token) continue;
    const cleaned = token.replace(/^['"]|['"]$/g, '').replace(/[);:,]+$/, '');
    if (!cleaned || path.isAbsolute(cleaned)) continue;
    if (!cleaned.includes(path.sep) && !cleaned.includes('/')) continue;
    candidates.push(path.normalize(path.resolve(cwd, cleaned)));
  }

  await Promise.all(candidates.map(c => resolveAndCheck(c)));
  return [...results];
}
