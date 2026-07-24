/**
 * CodexEditWindowRegistry -- per-session registry of open Codex edit
 * attribution windows.
 *
 * Listener-backed Codex transports can encounter MCP tools with filesystem
 * side effects that are not reported as fileChange items, so we open an
 * attribution window when a known writer starts and close it on completion.
 * While the window is open, file watcher
 * events whose timestamps fall in the window are attributed to the
 * canonical synthetic edit-group ID for that tool call -- skipping the
 * fuzzy time-based matcher heuristics.
 *
 * Scope:
 *   - Native `file_change` does not use a window
 *   - Known write-capable MCP tools open windows
 *   - `command_execution` is intentionally excluded for v1 (per the resolved
 *     plan question) because shell-side effects produce too many false
 *     positives. The existing `trackBashEditsFromCommand` path stays.
 *
 * Closed windows are kept for a short grace period so writes that flush
 * to disk after the tool's `item.completed` arrives can still attribute.
 */

import * as path from 'path';
import { logger } from '../utils/logger';

/** How long after closeWindow a window stays match-eligible. */
const POST_CLOSE_GRACE_MS = 1500;
/** Max age before a window is unconditionally evicted (open or closed). */
const HARD_EXPIRY_MS = 5 * 60_000;

export interface CodexEditWindow {
  sessionId: string;
  /** Canonical synthetic edit-group ID (e.g. `nimtc|item_0|<ts>|<idx>`). */
  editGroupId: string;
  /** Codex tool name (e.g. `file_change`, `mcp__server__tool`). */
  toolName: string;
  /** Workspace this window belongs to. Used to scope attribution lookups. */
  workspacePath: string;
  /** Optional target file extracted from tool args, when the tool surfaced one. */
  targetFilePath: string | null;
  /** Wall-clock ms when the window opened. */
  openedAt: number;
  /** Wall-clock ms when closeWindow was called; undefined while still open. */
  closedAt: number | null;
  /** Tool completion result, if any. */
  status: 'open' | 'completed' | 'error' | 'aborted';
  /** Files observed via the watcher while this window covered the timestamp. */
  observedFiles: Set<string>;
}

/**
 * Codex tool names that always open an edit attribution window.
 *
 * `file_change` USED to be the lone entry here, but its edits are now
 * attributed via the provider's `pre_edit_snapshot` chunk path. App-server
 * reconstructs the baseline from the completed item's unified diff, while the
 * legacy SDK path uses its pre-edit hook/cache fallback. The registry now only
 * serves write-capable MCP tools whose filesystem side effects are not listed
 * by their app-server lifecycle items.
 */
const ALWAYS_OPEN_TOOL_NAMES = new Set<string>([]);

/**
 * Identify MCP tools that are known to write files in the workspace, so we
 * open an edit attribution window for them. Conservative on purpose -- the
 * cost of a missed window is degraded diff fidelity (which falls back to the
 * fuzzy matcher); the cost of a false-positive window is misattributed file
 * writes from concurrent activity.
 */
export function isWriteCapableMcpTool(toolName: string): boolean {
  if (!toolName.startsWith('mcp__')) return false;
  // Known write-capable MCP tool slugs after the `mcp__<server>__` prefix.
  // Keep this list narrow and intentional -- expand as new write tools land.
  const KNOWN_WRITE_SUFFIXES = [
    'applyCollabDocEdit',
    'threed_update_file',
    'mindmap_add_node',
    'mindmap_update_node',
    'mindmap_delete_node',
    'mindmap_move_node',
    'slides_add_slide',
    'slides_update_slide',
    'slides_remove_slide',
    'slides_reorder_slides',
    'slides_set_theme',
    'excalidraw_add_arrow',
    'excalidraw_add_arrows',
    'excalidraw_add_column',
    'excalidraw_add_elements',
    'excalidraw_add_frame',
    'excalidraw_add_rectangle',
    'excalidraw_add_row',
    'excalidraw_align_elements',
    'excalidraw_clear_all',
    'excalidraw_distribute_elements',
    'excalidraw_group_elements',
    'excalidraw_import_mermaid',
    'excalidraw_move_element',
    'excalidraw_remove_element',
    'excalidraw_remove_elements',
    'excalidraw_set_elements_in_frame',
    'excalidraw_update_element',
  ];
  return KNOWN_WRITE_SUFFIXES.some((suffix) => toolName.endsWith(`__${suffix}`));
}

/**
 * Decide whether a Codex tool call should open an edit attribution window.
 * Called by MessageStreamingHandler when it sees `tool_call` chunks for
 * `openai-codex` sessions.
 */
export function shouldOpenCodexEditWindow(toolName: string): boolean {
  if (ALWAYS_OPEN_TOOL_NAMES.has(toolName)) return true;
  if (isWriteCapableMcpTool(toolName)) return true;
  return false;
}

class CodexEditWindowRegistryImpl {
  private readonly byEditGroupId = new Map<string, CodexEditWindow>();
  private readonly bySession = new Map<string, Set<string>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Open a window for a tool call. Idempotent if called twice for the same
   * editGroupId -- subsequent calls are no-ops so item.started+item.updated
   * pairs don't reset window state.
   */
  open(params: {
    sessionId: string;
    editGroupId: string;
    toolName: string;
    workspacePath: string;
    targetFilePath?: string | null;
  }): void {
    if (this.byEditGroupId.has(params.editGroupId)) {
      return;
    }
    const window: CodexEditWindow = {
      sessionId: params.sessionId,
      editGroupId: params.editGroupId,
      toolName: params.toolName,
      workspacePath: params.workspacePath,
      targetFilePath: params.targetFilePath ?? null,
      openedAt: Date.now(),
      closedAt: null,
      status: 'open',
      observedFiles: new Set(),
    };
    this.byEditGroupId.set(params.editGroupId, window);
    let sessionIds = this.bySession.get(params.sessionId);
    if (!sessionIds) {
      sessionIds = new Set();
      this.bySession.set(params.sessionId, sessionIds);
    }
    sessionIds.add(params.editGroupId);
    this.ensureCleanupTimer();
    logger.main.debug('[CodexEditWindowRegistry] Opened window:', {
      sessionId: params.sessionId,
      editGroupId: params.editGroupId,
      toolName: params.toolName,
    });
  }

  /**
   * Close a window. Keeps the entry around for `POST_CLOSE_GRACE_MS` so
   * watcher events that arrive a bit after `item.completed` still attribute.
   */
  close(editGroupId: string, status: 'completed' | 'error' | 'aborted' = 'completed'): void {
    const window = this.byEditGroupId.get(editGroupId);
    if (!window) return;
    window.closedAt = Date.now();
    window.status = status;
    logger.main.debug('[CodexEditWindowRegistry] Closed window:', {
      sessionId: window.sessionId,
      editGroupId,
      status,
      observedFileCount: window.observedFiles.size,
    });
  }

  /**
   * Record that a file write was attributed to this window. Called by the
   * attribution service when it picks the window via `findWindowForEdit`.
   */
  recordObservation(editGroupId: string, filePath: string): void {
    const window = this.byEditGroupId.get(editGroupId);
    if (!window) return;
    window.observedFiles.add(filePath);
  }

  /**
   * Find a window that should claim this file watcher event:
   *   - the session matches
   *   - any explicit target file matches the watcher event path
   *   - the window is open OR closed within `POST_CLOSE_GRACE_MS`
   *   - the file timestamp falls inside [openedAt, closedAt + grace]
   *
   * If multiple windows for the session are still match-eligible (e.g. two
   * write-capable tools running back-to-back), the most recent one wins,
   * matching the implicit "last open window" semantics of the file_change
   * pre-snapshot path in MessageStreamingHandler.
   */
  findWindowForEdit(params: {
    sessionId: string;
    workspacePath: string;
    filePath: string;
    fileTimestamp: number;
  }): CodexEditWindow | null {
    const sessionIds = this.bySession.get(params.sessionId);
    if (!sessionIds || sessionIds.size === 0) return null;

    let best: CodexEditWindow | null = null;
    for (const editGroupId of sessionIds) {
      const window = this.byEditGroupId.get(editGroupId);
      if (!window) continue;
      if (window.workspacePath !== params.workspacePath) continue;
      if (window.targetFilePath !== null) {
        const targetFilePath = path.resolve(window.workspacePath, window.targetFilePath);
        if (targetFilePath !== path.resolve(params.filePath)) continue;
      }
      if (params.fileTimestamp < window.openedAt) continue;
      if (window.closedAt !== null && params.fileTimestamp > window.closedAt + POST_CLOSE_GRACE_MS) continue;
      if (best == null || window.openedAt > best.openedAt) {
        best = window;
      }
    }
    return best;
  }

  /**
   * Drop all windows for a session. Called when a session ends or is
   * aborted so the registry doesn't accumulate stale state.
   */
  clearSession(sessionId: string): void {
    const sessionIds = this.bySession.get(sessionId);
    if (!sessionIds) return;
    for (const editGroupId of sessionIds) {
      this.byEditGroupId.delete(editGroupId);
    }
    this.bySession.delete(sessionId);
  }

  /** Test/inspection accessor. */
  getWindow(editGroupId: string): CodexEditWindow | undefined {
    return this.byEditGroupId.get(editGroupId);
  }

  /** Test/inspection accessor. */
  getSessionWindowCount(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0;
  }

  /**
   * Periodic cleanup of expired windows so the registry doesn't grow
   * unbounded under long-running sessions.
   */
  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.runCleanup(), 30_000);
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  private runCleanup(): void {
    const now = Date.now();
    for (const [editGroupId, window] of this.byEditGroupId) {
      const age = now - window.openedAt;
      if (age > HARD_EXPIRY_MS) {
        this.byEditGroupId.delete(editGroupId);
        const sessionIds = this.bySession.get(window.sessionId);
        if (sessionIds) {
          sessionIds.delete(editGroupId);
          if (sessionIds.size === 0) {
            this.bySession.delete(window.sessionId);
          }
        }
      }
    }
    if (this.byEditGroupId.size === 0 && this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Test-only: tear down all state and timers. */
  __resetForTests(): void {
    this.byEditGroupId.clear();
    this.bySession.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export const codexEditWindowRegistry = new CodexEditWindowRegistryImpl();
