/**
 * Central File State Listeners
 *
 * Subscribes to all file/git-related IPC events ONCE and updates atoms.
 * Components read from atoms, never subscribe to IPC directly.
 *
 * Events handled:
 * - session-files:updated → sessionFileEditsAtom
 * - git:status-changed → sessionGitStatusAtom, workspaceUncommittedFilesAtom, worktreeChangedFilesAtom
 * - history:pending-count-changed → sessionPendingReviewFilesAtom
 *
 * Call initFileStateListeners() once in App.tsx on mount.
 */

import { store } from '@nimbalyst/runtime/store';
import {
  sessionFileEditsAtom,
  sessionGitStatusAtom,
  setSessionPendingReviewFilesAtom,
  workspaceUncommittedFilesAtom,
  worktreeChangedFilesAtom,
  worktreeGitStatusAtom,
  type FileEditWithSession,
} from '../atoms/sessionFiles';
import { workstreamStagedFilesAtom, setWorkstreamStagedFilesAtom } from '../atoms/workstreamState';
import { getRelativeWorkspacePath } from '../../../shared/pathUtils';
import { createToolCallMatchesCoalescer } from './toolCallMatchesCoalescer';
import { createPerKeyDebouncer } from './perKeyDebounce';

/**
 * Track which workspace path is currently open.
 * Set by initFileStateListeners(workspacePath).
 */
let currentWorkspacePath: string | null = null;

/**
 * Registry of session ID → workspace path.
 * Used to find which sessions belong to which workspace for git status updates.
 */
const sessionWorkspaceRegistry = new Map<string, string>();

/**
 * Older session_files rows (before the SessionFileTracker normalization fix)
 * persisted some Edit/Write paths as workspace-relative strings while Bash
 * watcher and ApplyPatch paths were absolute. When the same file appears in
 * both forms, the workstream tree renders it twice. Resolve relative paths
 * against the session workspace so dedup-by-filePath collapses them.
 */
function toAbsoluteFilePath(filePath: string, workspacePath: string): string {
  if (!filePath) return filePath;
  if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) {
    return filePath;
  }
  return `${workspacePath.replace(/[\\/]+$/, '')}/${filePath}`;
}

/**
 * Registry of worktree ID → worktree path.
 * Used to fetch worktree changed files on git:status-changed.
 */
const worktreePathRegistry = new Map<string, string>();

/**
 * Register a session with its workspace path.
 * Call this when a session is created or loaded.
 */
export function registerSessionWorkspace(sessionId: string, workspacePath: string): void {
  sessionWorkspaceRegistry.set(sessionId, workspacePath);
}

/**
 * Unregister a session (when deleted).
 */
export function unregisterSessionWorkspace(sessionId: string): void {
  sessionWorkspaceRegistry.delete(sessionId);
  clearInitialSessionFileStateCache(sessionId);
}

/**
 * Register a worktree with its path.
 * Call this when a worktree session is created or loaded.
 */
export function registerWorktreePath(worktreeId: string, worktreePath: string): void {
  worktreePathRegistry.set(worktreeId, worktreePath);
}

/**
 * Unregister a worktree (when deleted).
 */
export function unregisterWorktreePath(worktreeId: string): void {
  worktreePathRegistry.delete(worktreeId);
}

// Idempotency guard: callers like FilesEditedSidebar fire this from a
// useEffect with `workstreamSessions` in its deps, and that array's identity
// churns on every render -- so without this guard we got 120+ IPC calls per
// second for a single session. The actual data is kept in sync by the
// session-files:updated and history:pending-count-changed listeners; the
// initial load only needs to happen once per (session, workspace) per renderer.
const initialFileStateLoaded = new Set<string>();
const initialFileStateInFlight = new Map<string, Promise<void>>();

export function clearInitialSessionFileStateCache(sessionId?: string): void {
  if (sessionId) {
    for (const key of Array.from(initialFileStateLoaded)) {
      if (key.startsWith(`${sessionId}\0`)) initialFileStateLoaded.delete(key);
    }
  } else {
    initialFileStateLoaded.clear();
  }
}

/**
 * Load initial file state for a session.
 * Call this when a session is created or loaded to populate atoms with initial data.
 * Idempotent: subsequent calls for the same (sessionId, workspacePath) are no-ops
 * until clearInitialSessionFileStateCache(sessionId) is called.
 */
export async function loadInitialSessionFileState(sessionId: string, workspacePath: string): Promise<void> {
  const key = `${sessionId}\0${workspacePath}`;
  if (initialFileStateLoaded.has(key)) return;
  const inFlight = initialFileStateInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = loadInitialSessionFileStateImpl(sessionId, workspacePath);
  initialFileStateInFlight.set(key, promise);
  try {
    await promise;
    initialFileStateLoaded.add(key);
  } finally {
    initialFileStateInFlight.delete(key);
  }
}

async function loadInitialSessionFileStateImpl(sessionId: string, workspacePath: string): Promise<void> {
  // Debug logging - uncomment if needed
  // console.log('[fileStateListeners] Loading initial state for session:', sessionId);

  // Register session
  registerSessionWorkspace(sessionId, workspacePath);

  try {
    // Load file edits
    const fileResult = await window.electronAPI.invoke(
      'session-files:get-by-session',
      sessionId,
      'edited'
    );

    // Debug logging - uncomment if needed
    // console.log('[fileStateListeners] File result for', sessionId, ':', fileResult);

    if (fileResult.success && fileResult.files) {
      let edits: FileEditWithSession[] = fileResult.files.map((f: any) => ({
        filePath: toAbsoluteFilePath(f.filePath, workspacePath),
        linkType: 'edited' as const,
        operation: f.metadata?.operation,
        linesAdded: f.metadata?.linesAdded,
        linesRemoved: f.metadata?.linesRemoved,
        timestamp: f.createdAt || new Date().toISOString(),
        sessionId: f.sessionId,
      }));

      // Enrich with tool call match data
      edits = await enrichEditsWithToolCallMatches(sessionId, edits, fileResult.files);

      store.set(sessionFileEditsAtom(sessionId), edits);

      // Load git status for these files
      await refreshSessionGitStatus(sessionId);
    }

    // Load pending review files
    const pendingFiles: string[] = await window.electronAPI.invoke(
      'history:get-pending-files-for-session',
      workspacePath,
      sessionId
    );
    store.set(setSessionPendingReviewFilesAtom, { sessionId, pendingFiles });

  } catch (error) {
    console.error('[fileStateListeners] Failed to load initial state for session:', sessionId, error);
  }
}

/**
 * Load initial worktree state.
 * Call this when a worktree session is loaded.
 */
export async function loadInitialWorktreeState(worktreeId: string, worktreePath: string): Promise<void> {
  registerWorktreePath(worktreeId, worktreePath);
  await Promise.all([
    refreshWorktreeChangedFiles(worktreeId, worktreePath),
    refreshWorktreeGitStatus(worktreeId, worktreePath),
  ]);

  // Start watching the worktree for git changes (commits, staging)
  // This enables real-time updates when files are added/modified via command line
  try {
    await window.electronAPI.invoke('worktree:start-watching', worktreePath);
  } catch (error) {
    console.error('[fileStateListeners] Failed to start watching worktree:', worktreePath, error);
  }
}

/**
 * Initialize file state listeners.
 * Call once in App.tsx on mount.
 *
 * @param workspacePath - Current workspace path
 * @returns Cleanup function to call on unmount
 */
export function initFileStateListeners(workspacePath: string): () => void {
  currentWorkspacePath = workspacePath;
  const cleanups: Array<() => void> = [];
  const enrichDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const gitStatusDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingCountDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const sessionFilesFetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const SESSION_FILES_FETCH_DEBOUNCE_MS = 250;
  // session-files:updated fires once per file edit (hundreds/sec during active
  // AI tool execution); coalesce its per-session git-status refresh so bursts
  // collapse into a single trailing git:get-file-status call per session.
  const sessionGitStatusRefresh = createPerKeyDebouncer(250);
  const GIT_STATUS_DEBOUNCE_MS = 300;
  const PENDING_COUNT_DEBOUNCE_MS = 250;

  // Load all uncommitted files for workspace immediately
  (async () => {
    try {
      const result = await window.electronAPI.invoke('git:get-uncommitted-files', workspacePath);
      if (result.success && result.files) {
        store.set(workspaceUncommittedFilesAtom(workspacePath), result.files);
      }
    } catch (error) {
      console.error('[fileStateListeners] Failed to load initial uncommitted files:', error);
    }
  })();

  // =========================================================================
  // Session Files Updated
  // =========================================================================

  // Fetch + enrich + git-status refresh for a single session. Kept as a
  // sibling helper so the event handler below can debounce its invocation.
  const runSessionFilesRefresh = async (sessionId: string) => {
      try {
        const result = await window.electronAPI.invoke(
          'session-files:get-by-session',
          sessionId,
          'edited'
        );

        if (result.success && result.files) {
          const sessionWorkspacePath = sessionWorkspaceRegistry.get(sessionId) ?? currentWorkspacePath ?? '';
          let edits: FileEditWithSession[] = result.files.map((f: any) => ({
            filePath: toAbsoluteFilePath(f.filePath, sessionWorkspacePath),
            linkType: 'edited' as const,
            operation: f.metadata?.operation,
            linesAdded: f.metadata?.linesAdded,
            linesRemoved: f.metadata?.linesRemoved,
            timestamp: f.createdAt || new Date().toISOString(),
            sessionId: f.sessionId,
          }));

          // Set edits immediately without enrichment
          store.set(sessionFileEditsAtom(sessionId), edits);

          // Debounce the enrichment to avoid rapid-fire IPC calls during active sessions.
          // Short delay (200ms) since incremental matching now runs during the session.
          const existingTimer = enrichDebounceTimers.get(sessionId);
          if (existingTimer) clearTimeout(existingTimer);
          enrichDebounceTimers.set(sessionId, setTimeout(async () => {
            enrichDebounceTimers.delete(sessionId);
            try {
              const enriched = await enrichEditsWithToolCallMatches(sessionId, edits, result.files);
              store.set(sessionFileEditsAtom(sessionId), enriched);
            } catch {
              // Non-critical - edits already set without enrichment
            }
          }, 200));

          // Also refresh git status for these files. This handler fires once
          // per file edit (see the note below on session-files:updated volume),
          // so coalesce the refresh per session instead of running a full
          // git:get-file-status over the session's edited-file list every time.
          sessionGitStatusRefresh.schedule(sessionId, () => {
            void refreshSessionGitStatus(sessionId);
          });

          // Note: we used to also fetch pending-review files here to keep the
          // atom in sync, but that fired once per session-files:updated event
          // -- and the file-attribution service emits one per file edit during
          // AI tool execution (hundreds per second in active sessions). The
          // history:pending-count-changed handler below already covers this
          // case with proper per-workspace debouncing, and emitPendingCountChanged
          // is called from every site that mutates pending-review state
          // (createTag, markTagReviewed, clearAllPending, etc.). Don't
          // re-add this without a debounce.
        }
      } catch (error) {
        console.error('[fileStateListeners] Failed to fetch file edits for session:', sessionId, error);
      }
  };

  cleanups.push(
    window.electronAPI.on('session-files:updated', (sessionId: string) => {
      // The file-attribution service emits session-files:updated once per file
      // edit during AI tool execution (hundreds/sec). Multiplied by open
      // windows × active sessions, an un-debounced refresh here serializes in
      // the single-threaded PGLite worker and stalls the main thread. Debounce
      // per session so a burst collapses to a single trailing refresh.
      const existingTimer = sessionFilesFetchTimers.get(sessionId);
      if (existingTimer) clearTimeout(existingTimer);
      sessionFilesFetchTimers.set(
        sessionId,
        setTimeout(() => {
          sessionFilesFetchTimers.delete(sessionId);
          void runSessionFilesRefresh(sessionId);
        }, SESSION_FILES_FETCH_DEBOUNCE_MS)
      );
    })
  );

  // =========================================================================
  // Git Status Changed
  // =========================================================================

  cleanups.push(
    window.electronAPI.on('git:status-changed', (data: { workspacePath: string }) => {
      // Check if event is for current workspace OR any registered worktree
      const isCurrentWorkspace = data.workspacePath === currentWorkspacePath;
      const isRegisteredWorktree = Array.from(worktreePathRegistry.values()).includes(data.workspacePath);

      if (!isCurrentWorkspace && !isRegisteredWorktree) {
        return;
      }

      // Debounce per workspace path to coalesce rapid-fire events during startup
      const existingTimer = gitStatusDebounceTimers.get(data.workspacePath);
      if (existingTimer) clearTimeout(existingTimer);

      gitStatusDebounceTimers.set(data.workspacePath, setTimeout(async () => {
        gitStatusDebounceTimers.delete(data.workspacePath);

        try {
          // 1. Refresh all uncommitted files for the workspace/worktree
          const uncommittedResult = await window.electronAPI.invoke(
            'git:get-uncommitted-files',
            data.workspacePath
          );
          if (uncommittedResult.success && uncommittedResult.files) {
            store.set(workspaceUncommittedFilesAtom(data.workspacePath), uncommittedResult.files);
          }

          // 2. Refresh git status for ALL sessions in this workspace
          const sessionsInWorkspace = Array.from(sessionWorkspaceRegistry.entries())
            .filter(([, wsPath]) => wsPath === data.workspacePath)
            .map(([sessionId]) => sessionId);

          await Promise.all(sessionsInWorkspace.map(sessionId => refreshSessionGitStatus(sessionId)));

          // 3. Auto-prune committed files from staging for all sessions
          for (const sessionId of sessionsInWorkspace) {
            await pruneCommittedFilesFromStaging(sessionId, data.workspacePath);
          }

          // 4. Refresh worktree changed files and git status for worktrees matching this path
          const matchingWorktrees = Array.from(worktreePathRegistry.entries())
            .filter(([, worktreePath]) => worktreePath === data.workspacePath);

          await Promise.all(
            matchingWorktrees.flatMap(([worktreeId, worktreePath]) => [
              refreshWorktreeChangedFiles(worktreeId, worktreePath),
              refreshWorktreeGitStatus(worktreeId, worktreePath),
            ])
          );
        } catch (error) {
          console.error('[fileStateListeners] Failed to handle git:status-changed:', error);
        }
      }, GIT_STATUS_DEBOUNCE_MS));
    })
  );

  // =========================================================================
  // Pending Review Changed
  // =========================================================================

  cleanups.push(
    window.electronAPI.on('history:pending-count-changed', (data: { workspacePath: string; count: number }) => {
      // Only refresh sessions in the workspace whose pending count actually changed.
      // The previous fan-out across all registered sessions caused a 200+ call
      // pile-up when AI sessions tagged many files in succession (each createTag
      // emits one broadcast).
      const eventWorkspacePath = data?.workspacePath;
      if (!eventWorkspacePath) return;

      // Debounce per workspace so a burst of createTag emissions coalesces into
      // a single refresh pass (mirrors GIT_STATUS_DEBOUNCE_MS behavior).
      const existingTimer = pendingCountDebounceTimers.get(eventWorkspacePath);
      if (existingTimer) clearTimeout(existingTimer);

      pendingCountDebounceTimers.set(eventWorkspacePath, setTimeout(async () => {
        pendingCountDebounceTimers.delete(eventWorkspacePath);

        const sessionsInWorkspace = Array.from(sessionWorkspaceRegistry.entries())
          .filter(([, wsPath]) => wsPath === eventWorkspacePath)
          .map(([sessionId]) => sessionId);

        await Promise.all(
          sessionsInWorkspace.map(async (sessionId) => {
            try {
              const pendingFiles: string[] = await window.electronAPI.invoke(
                'history:get-pending-files-for-session',
                eventWorkspacePath,
                sessionId
              );
              store.set(setSessionPendingReviewFilesAtom, { sessionId, pendingFiles });
            } catch (error) {
              console.error('[fileStateListeners] Failed to fetch pending files for session:', sessionId, error);
            }
          })
        );
      }, PENDING_COUNT_DEBOUNCE_MS));
    })
  );

  return () => {
    cleanups.forEach(cleanup => cleanup?.());
    enrichDebounceTimers.forEach(timer => clearTimeout(timer));
    enrichDebounceTimers.clear();
    gitStatusDebounceTimers.forEach(timer => clearTimeout(timer));
    gitStatusDebounceTimers.clear();
    pendingCountDebounceTimers.forEach(timer => clearTimeout(timer));
    pendingCountDebounceTimers.clear();
    sessionFilesFetchTimers.forEach(timer => clearTimeout(timer));
    sessionFilesFetchTimers.clear();
    sessionGitStatusRefresh.cancelAll();
  };
}

/**
 * Enrich file edits with tool call match data.
 * Fetches matches from the database and merges tool call info into the edits.
 */
/**
 * Coalesces `session-files:get-tool-call-matches` per session so concurrent
 * enrich calls (initial multi-session load + debounced updates) collapse to a
 * single worker round-trip instead of piling up on the single-threaded PGLite
 * worker. Short TTL keeps results fresh during active editing.
 */
const toolCallMatchesCoalescer = createToolCallMatchesCoalescer<any[]>(
  async (sessionId: string) => {
    const result = await window.electronAPI.invoke(
      'session-files:get-tool-call-matches',
      sessionId
    );
    return result.success && result.matches ? result.matches : [];
  },
  500
);

async function enrichEditsWithToolCallMatches(
  sessionId: string,
  edits: FileEditWithSession[],
  rawFiles: Array<{ id: string; filePath: string }>
): Promise<FileEditWithSession[]> {
  try {
    const matches = await toolCallMatchesCoalescer.get(sessionId);

    if (!matches || matches.length === 0) {
      return edits;
    }

    // Build map of sessionFileId -> match
    // We need sessionFileId from the original files, but edits don't carry it.
    // Instead, map by (filePath, sessionId) since each file appears once per session.
    // The match has sessionFileId which maps to a session_files row.
    // For now, store match data on the match itself and merge by message info.
    const matchByFileId = new Map<string, any>();
    for (const match of matches) {
      matchByFileId.set(match.sessionFileId, match);
    }

    // Build filePath -> sessionFileId mapping from the raw files we already have.
    // Normalize raw paths the same way edits were normalized so absolute and
    // workspace-relative DB rows still match the (now absolute) edit.filePath.
    const sessionWorkspacePath = sessionWorkspaceRegistry.get(sessionId) ?? currentWorkspacePath ?? '';
    const filePathToId = new Map<string, string>();
    for (const f of rawFiles) {
      filePathToId.set(toAbsoluteFilePath(f.filePath, sessionWorkspacePath), f.id);
    }

    // Enrich edits with match data
    return edits.map(edit => {
      const fileId = filePathToId.get(edit.filePath);
      if (!fileId) return edit;

      const match = matchByFileId.get(fileId);
      if (!match) return edit;

      // Extract tool name from match_reason
      const toolNameMatch = match.matchReason?.match(/tool=(.+)$/);
      const toolName = toolNameMatch ? toolNameMatch[1] : undefined;

      return {
        ...edit,
        toolCallMessageId: match.messageId,
        toolCallName: toolName,
        matchScore: match.matchScore,
      };
    });
  } catch (error) {
    // Non-critical - return edits without match data
    console.error('[fileStateListeners] Failed to enrich edits with tool call matches:', error);
    return edits;
  }
}

/**
 * Refresh git status for a specific session's files.
 */
async function refreshSessionGitStatus(sessionId: string): Promise<void> {
  const workspacePath = sessionWorkspaceRegistry.get(sessionId);
  if (!workspacePath) return;

  const edits = store.get(sessionFileEditsAtom(sessionId));
  if (edits.length === 0) return;

  try {
    // Get relative paths using proper path boundary checking
    const filePaths = edits.map(f => {
      const relativePath = getRelativeWorkspacePath(f.filePath, workspacePath);
      return relativePath !== null ? relativePath : f.filePath;
    });

    const result = await window.electronAPI.invoke('git:get-file-status', workspacePath, filePaths);
    if (result.success && result.status) {
      store.set(sessionGitStatusAtom(sessionId), result.status);
    }
  } catch (error) {
    console.error('[fileStateListeners] Failed to refresh git status for session:', sessionId, error);
  }
}

/**
 * Auto-prune committed files from staging.
 * When files are committed (via any method), remove them from the staged set.
 */
async function pruneCommittedFilesFromStaging(sessionId: string, workspacePath: string): Promise<void> {
  const stagedFiles = store.get(workstreamStagedFilesAtom(sessionId));
  if (stagedFiles.length === 0) return;

  try {
    // Get relative paths for checking using proper path boundary checking
    const relativePaths = stagedFiles.map(fp => {
      const relativePath = getRelativeWorkspacePath(fp, workspacePath);
      return relativePath !== null ? relativePath : fp;
    });

    const result = await window.electronAPI.invoke('git:get-file-status', workspacePath, relativePaths);

    if (result.success && result.status) {
      // Filter out files that are now committed (unchanged)
      const stillUncommitted = stagedFiles.filter(fp => {
        const relativePath = getRelativeWorkspacePath(fp, workspacePath) ?? fp;
        const status = result.status[relativePath];
        return status && status.status !== 'unchanged';
      });

      // Only update if some files were pruned
      if (stillUncommitted.length !== stagedFiles.length) {
        // Debug logging - uncomment if needed
        // console.log('[fileStateListeners] Pruning committed files from staging:',
        //   stagedFiles.length - stillUncommitted.length, 'files');

        // Use the action atom to update
        store.set(setWorkstreamStagedFilesAtom, {
          workstreamId: sessionId,
          files: stillUncommitted
        });
      }
    }
  } catch (error) {
    console.error('[fileStateListeners] Failed to prune committed files:', error);
  }
}

/**
 * Refresh worktree changed files.
 * Exported so components can trigger a refresh (e.g., refresh button in GitOperationsPanel).
 */
export async function refreshWorktreeChangedFiles(worktreeId: string, worktreePath: string): Promise<void> {
  try {
    const result = await window.electronAPI.invoke('worktree:get-changed-files', worktreePath);
    if (result.success && result.files) {
      store.set(worktreeChangedFilesAtom(worktreeId), result.files);
    } else if (!result.success) {
      console.error('[fileStateListeners] Failed to get worktree changed files:', worktreeId, result.error);
    }
  } catch (error) {
    console.error('[fileStateListeners] Failed to refresh worktree changes:', worktreeId, error);
  }
}

/**
 * Worktree git status response from IPC.
 */
interface WorktreeStatusResponse {
  success: boolean;
  status?: {
    ahead?: number;
    behind?: number;
    commitsAhead?: number;
    commitsBehind?: number;
    hasUncommittedChanges?: boolean;
  };
}

/**
 * Refresh worktree git status (ahead/behind counts).
 */
async function refreshWorktreeGitStatus(worktreeId: string, worktreePath: string): Promise<void> {
  try {
    const result: WorktreeStatusResponse = await window.electronAPI.invoke('worktree:get-status', worktreePath);
    if (result.success && result.status) {
      store.set(worktreeGitStatusAtom(worktreeId), {
        ahead: result.status.ahead ?? result.status.commitsAhead ?? 0,
        behind: result.status.behind ?? result.status.commitsBehind ?? 0,
        hasUncommittedChanges: result.status.hasUncommittedChanges ?? false,
      });
    }
  } catch (error) {
    console.error('[fileStateListeners] Failed to refresh worktree git status:', worktreeId, error);
  }
}
