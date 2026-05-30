import { SessionManager, ProviderFactory } from '@nimbalyst/runtime/ai/server';
import { AISessionsRepository, TranscriptMigrationRepository } from '@nimbalyst/runtime';
import {
    parseCodexToolLookupId,
} from '@nimbalyst/runtime/ai/server/toolLookupIds';
import { TranscriptProjector } from '@nimbalyst/runtime/ai/server/transcript';
import {
    ModelIdentifier,
    shouldBlockStartedSessionProviderSwitch,
    type AIProviderType,
} from '@nimbalyst/runtime/ai/server/types';
import type { UpdateSessionMetadataPayload } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import path from "path";
import { existsSync } from "fs";
import { BrowserWindow } from 'electron';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { parseJsonObjectColumn } from '../utils/jsonColumn';
import type { SessionCreateResult } from '../../shared/ipc/types';
import { TrayManager } from '../tray/TrayManager';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { resolveRequestUserInputPromptTargets } from '../mcp/tools/codexToolCallResolver';
import {
    getGitCommitProposalResponseChannel,
    resolveGitCommitProposalPromptId,
} from '../services/ai/gitCommitProposalPromptUtils';
import { enrichTranscriptMessagesWithToolCallDiffs } from '../services/TranscriptToolCallEnricher';

// Initialize session manager
const sessionManager = new SessionManager();
const analyticsService = AnalyticsService.getInstance();

// Track if handlers are registered to prevent double registration
let handlersRegistered = false;

// ============================================================
// Git Status Cache
// Caches uncommitted file sets to avoid repeated git status calls
// when multiple components request session lists simultaneously.
// In-flight dedup so concurrent callers share one git status invocation.
// ============================================================
interface GitStatusCache {
    uncommittedFiles: Set<string>;
    timestamp: number;
}

const gitStatusCache = new Map<string, GitStatusCache>();
const gitStatusInFlight = new Map<string, Promise<Set<string>>>();
const GIT_STATUS_CACHE_TTL_MS = 5000; // 5 second cache

// ============================================================
// Session Files Cache
// Caches the (uncommitted-file -> last-editing-session) mapping. The query is
// bounded to currently-uncommitted file paths (typically tens) so the result
// set is small. In-flight dedup keyed by (workspace + file set) collapses
// concurrent callers from session list refreshes onto a single query.
// ============================================================
interface SessionFilesCache {
    /** Map of file_path -> session_id (most recent editor of each uncommitted file) */
    fileToSession: Map<string, string>;
    timestamp: number;
}

const sessionFilesCache = new Map<string, SessionFilesCache>();
const sessionFilesInFlight = new Map<string, Promise<Map<string, string>>>();
const SESSION_FILES_CACHE_TTL_MS = 5000; // 5 second cache

// Sessions that have ever edited any file in a workspace -- bounded by session
// count (much smaller than per-file edit history). Used to seed zero counts
// so previously-touched sessions reset to 0 when their files get committed.
const sessionEditorsCache = new Map<string, { ids: Set<string>; timestamp: number }>();
const sessionEditorsInFlight = new Map<string, Promise<Set<string>>>();

function trackCreateAISession(provider: AIProviderType, options?: {
    worktreeId?: string | null;
    parentSessionId?: string | null;
    agentRole?: string | null;
}): void {
    analyticsService.sendEvent('create_ai_session', {
        provider,
        is_worktree_session: !!options?.worktreeId,
        is_workstream_child: !!options?.parentSessionId,
        is_meta_agent_session: options?.agentRole === 'meta-agent',
    });
}

function makeSessionFilesCacheKey(workspacePath: string, uncommittedFiles: Set<string>): string {
    if (uncommittedFiles.size === 0) return `${workspacePath}::__empty__`;
    return `${workspacePath}::${Array.from(uncommittedFiles).sort().join('|')}`;
}

/**
 * For each currently-uncommitted file, find the most recent session that edited it.
 * Returns a Map<file_path-as-stored-in-session_files, session_id>.
 *
 * The query is bounded to `uncommittedFiles.size` candidate paths instead of
 * scanning the entire per-file edit history of the workspace. Previously this
 * returned thousands of rows on every session-list refresh and saturated the
 * single-threaded PGLite queue.
 *
 * In-flight dedup is keyed by (workspace + file set) so concurrent callers
 * from sessions:list, sessions:list-children, and sessions:get-uncommitted-counts
 * share one query.
 */
async function getSessionsForUncommittedFiles(
    workspacePath: string,
    uncommittedFiles: Set<string>
): Promise<Map<string, string>> {
    if (uncommittedFiles.size === 0) {
        return new Map();
    }

    const cacheKey = makeSessionFilesCacheKey(workspacePath, uncommittedFiles);

    const cached = sessionFilesCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SESSION_FILES_CACHE_TTL_MS) {
        return cached.fileToSession;
    }

    const inFlight = sessionFilesInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const queryPromise = (async () => {
        const { database } = await import('../database/PGLiteDatabaseWorker');

        // session_files historically stored paths in two forms (relative for
        // older Edit/Write rows, absolute for Bash watcher and ApplyPatch).
        // Look up by both so legacy rows still match. New rows are normalized
        // by SessionFileTracker.
        const candidatePaths: string[] = [];
        for (const relativePath of uncommittedFiles) {
            candidatePaths.push(relativePath);
            candidatePaths.push(`${workspacePath}/${relativePath}`);
        }

        // Pick the most recent session per file_path. Rewritten from PG's
        // `SELECT DISTINCT ON (file_path) ... ORDER BY file_path, timestamp DESC`
        // to a window-function form that works under both PGLite and SQLite.
        const { rows } = await database.query<{ session_id: string; file_path: string }>(
            `SELECT session_id, file_path FROM (
               SELECT session_id, file_path,
                      ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY timestamp DESC) AS rn
               FROM session_files
               WHERE workspace_id = $1
                 AND link_type = 'edited'
                 AND file_path = ANY($2::text[])
             ) ranked WHERE rn = 1`,
            [workspacePath, candidatePaths]
        );

        const fileToSession = new Map<string, string>();
        rows.forEach(row => {
            fileToSession.set(row.file_path, row.session_id);
        });

        sessionFilesCache.set(cacheKey, { fileToSession, timestamp: Date.now() });
        return fileToSession;
    })();

    sessionFilesInFlight.set(cacheKey, queryPromise);
    try {
        return await queryPromise;
    } finally {
        sessionFilesInFlight.delete(cacheKey);
    }
}

/**
 * Get the set of session IDs that have ever edited any file in a workspace.
 *
 * Used by sessions:get-uncommitted-counts to seed zero counts so a session
 * whose files have all just been committed correctly drops to 0 in the UI
 * (rather than retaining a stale count). Bounded by session count, much
 * smaller than the per-file edit history.
 */
async function getSessionIdsWithEdits(workspacePath: string): Promise<Set<string>> {
    const cached = sessionEditorsCache.get(workspacePath);
    if (cached && Date.now() - cached.timestamp < SESSION_FILES_CACHE_TTL_MS) {
        return cached.ids;
    }

    const inFlight = sessionEditorsInFlight.get(workspacePath);
    if (inFlight) return inFlight;

    const queryPromise = (async () => {
        const { database } = await import('../database/PGLiteDatabaseWorker');
        const { rows } = await database.query<{ session_id: string }>(
            `SELECT DISTINCT session_id
             FROM session_files
             WHERE workspace_id = $1 AND link_type = 'edited'`,
            [workspacePath]
        );
        const ids = new Set(rows.map(r => r.session_id));
        sessionEditorsCache.set(workspacePath, { ids, timestamp: Date.now() });
        return ids;
    })();

    sessionEditorsInFlight.set(workspacePath, queryPromise);
    try {
        return await queryPromise;
    } finally {
        sessionEditorsInFlight.delete(workspacePath);
    }
}

/**
 * Invalidate session files caches for a workspace.
 * Call this when files are edited to ensure fresh data on next query.
 */
export function invalidateSessionFilesCache(workspacePath: string): void {
    const prefix = `${workspacePath}::`;
    for (const key of sessionFilesCache.keys()) {
        if (key.startsWith(prefix)) {
            sessionFilesCache.delete(key);
        }
    }
    sessionEditorsCache.delete(workspacePath);
}

/**
 * Get uncommitted files with caching.
 * Avoids spawning git status multiple times in rapid succession.
 */
async function getCachedUncommittedFiles(workspacePath: string): Promise<Set<string>> {
    // Non-git workspaces have no uncommitted files
    if (!existsSync(path.join(workspacePath, '.git'))) {
        return new Set();
    }

    const cached = gitStatusCache.get(workspacePath);
    if (cached && Date.now() - cached.timestamp < GIT_STATUS_CACHE_TTL_MS) {
        return cached.uncommittedFiles;
    }

    const inFlight = gitStatusInFlight.get(workspacePath);
    if (inFlight) return inFlight;

    const queryPromise = (async () => {
        const simpleGit = (await import('simple-git')).default;
        const git = simpleGit(workspacePath);
        const status = await git.status();

        const uncommittedFiles = new Set([
            ...status.modified,
            ...status.created,
            ...status.not_added,
            ...status.deleted,
            ...status.renamed.map(r => r.to),
            ...status.staged
        ]);

        gitStatusCache.set(workspacePath, {
            uncommittedFiles,
            timestamp: Date.now()
        });

        return uncommittedFiles;
    })();

    gitStatusInFlight.set(workspacePath, queryPromise);
    try {
        return await queryPromise;
    } finally {
        gitStatusInFlight.delete(workspacePath);
    }
}

export async function registerSessionHandlers() {
    if (handlersRegistered) {
        console.log('[SessionHandlers] Handlers already registered, skipping');
        return;
    }

    // Initialize session manager
    await sessionManager.initialize();

    // Create session
    safeHandle('session:create', async (event, filePath: string, type: string, source?: any) => {
        const documentContext = filePath ? { content: '', filePath } : undefined;
        return await sessionManager.createSession(type as any, documentContext, source);
    });

    // Create session (new format for agentic coding)
    safeHandle('sessions:create', async (event, payload: { session: any; workspaceId: string }): Promise<SessionCreateResult> => {
        try {
            const { session, workspaceId } = payload;

            // Extract and sync provider from model ID if model follows "provider:model" format
            let provider = session.provider as AIProviderType;
            let model = session.model;

            if (model) {
                const modelId = ModelIdentifier.tryParse(model);
                if (modelId) {
                    provider = modelId.provider;
                }
            } else {
                // No model provided - get default for the provider using ModelIdentifier
                model = ModelIdentifier.getDefaultModelId(provider);
                console.log(`[SessionHandlers] No model provided, using default: ${model}`);
            }

            const createPayload = {
                id: session.id,
                provider,
                model,
                title: session.title || 'Untitled',
                workspaceId: workspaceId,
                providerConfig: session.providerConfig,
                providerSessionId: session.providerSessionId,
                worktreeId: session.worktreeId || null,
                agentRole: session.agentRole || 'standard',
                createdBySessionId: session.createdBySessionId || null,
            };
            // console.log('[SessionHandlers] Creating session with payload:', JSON.stringify(createPayload));

            await AISessionsRepository.create(createPayload);
            trackCreateAISession(provider, {
                worktreeId: createPayload.worktreeId,
                parentSessionId: (session.parentSessionId as string | null | undefined) ?? null,
                agentRole: createPayload.agentRole,
            });

            // Update with full metadata
            if (session.metadata) {
                await AISessionsRepository.updateMetadata(session.id, { metadata: session.metadata });
            }

            return { success: true, id: session.id };
        } catch (error) {
            console.error('[SessionHandlers] Error creating session:', error);
            return { success: false, error: String(error) };
        }
    });

    handlersRegistered = true;

    // Load session
    safeHandle('session:load', async (event, sessionId: string) => {
        return await sessionManager.loadSession(sessionId);
    });

    // Save session - maps to updateSessionMessages
    safeHandle('session:save', async (event, session: any) => {
        if (session?.id && session?.messages) {
            await sessionManager.updateSessionMessages(session.id, session.messages);
        }
    });

    // Delete session
    safeHandle('session:delete', async (event, sessionId: string) => {
        await sessionManager.deleteSession(sessionId);
    });

    // Update session title
    safeHandle('sessions:update-title', async (event, sessionId: string, title: string) => {
        await sessionManager.updateSessionTitle(sessionId, title, {
            force: true,
            markAsNamed: true,
        });
    });

    // Update session model
    safeHandle('sessions:update-model', async (event, sessionId: string, model: string) => {
        await sessionManager.updateSessionModel(sessionId, model);
    });

    // Update session provider and model (when switching between providers)
    safeHandle('sessions:update-provider-and-model', async (event, sessionId: string, provider: string, model: string) => {
        await sessionManager.updateSessionProviderAndModel(sessionId, provider, model);
    });

    // Update session draft input
    safeHandle('sessions:update-draft-input', async (event, sessionId: string, draftInput: string) => {
        await sessionManager.updateSessionDraftInput(sessionId, draftInput);
    });

    // Update session metadata (including mode, isArchived, etc.)
    safeHandle('sessions:update-metadata', async (event, sessionId: string, updates: UpdateSessionMetadataPayload) => {
        try {
            const currentSession = await AISessionsRepository.get(sessionId);
            if (!currentSession) {
                throw new Error('Session not found');
            }

            // When model is updated, extract and sync the provider from the model ID
            // Model IDs follow the format "provider:model-name" (e.g., "claude-code:opus", "openai:gpt-4o")
            let providerType: AIProviderType | undefined;
            if (updates.model) {
                const modelId = ModelIdentifier.tryParse(updates.model);
                if (modelId) {
                    updates.provider = modelId.provider;
                    providerType = modelId.provider;
                }
            }

            if (
                updates.provider &&
                shouldBlockStartedSessionProviderSwitch(
                    currentSession.provider,
                    updates.provider,
                    currentSession.messages.length > 0
                )
            ) {
                throw new Error(
                    `Cannot switch started session from ${currentSession.provider} to ${updates.provider}. Start a new session instead.`
                );
            }

            if (updates.model) {
                // Invalidate the cached provider so it gets re-created with the new model
                // on the next message. This ensures model changes take effect immediately.
                if (providerType) {
                    console.log(`[SessionHandlers] Model changed to ${updates.model}, invalidating provider for session ${sessionId}`);
                    ProviderFactory.destroyProvider(sessionId, providerType);
                } else {
                    // If we couldn't parse the provider, destroy all providers for this session
                    console.log(`[SessionHandlers] Model changed to ${updates.model}, invalidating all providers for session ${sessionId}`);
                    ProviderFactory.destroyProvider(sessionId);
                }
            }

            await AISessionsRepository.updateMetadata(sessionId, updates);

            // Notify renderer windows so session list state stays in sync without waiting for full refresh.
            // This covers model/provider/title updates from SessionTranscript and similar paths.
            const rendererUpdate: Record<string, unknown> = {};
            if (updates.title !== undefined) rendererUpdate.title = updates.title;
            if (updates.provider !== undefined) rendererUpdate.provider = updates.provider;
            if (updates.model !== undefined) rendererUpdate.model = updates.model;
            if (updates.sessionType !== undefined) rendererUpdate.sessionType = updates.sessionType;
            if (updates.parentSessionId !== undefined) rendererUpdate.parentSessionId = updates.parentSessionId;
            if (updates.worktreeId !== undefined) rendererUpdate.worktreeId = updates.worktreeId;
            if (updates.agentRole !== undefined) rendererUpdate.agentRole = updates.agentRole;
            if (updates.createdBySessionId !== undefined) rendererUpdate.createdBySessionId = updates.createdBySessionId;
            if ((updates as any).isPinned !== undefined) rendererUpdate.isPinned = (updates as any).isPinned;
            if (updates.isArchived !== undefined) rendererUpdate.isArchived = updates.isArchived;

            if (Object.keys(rendererUpdate).length > 0) {
                for (const window of BrowserWindow.getAllWindows()) {
                    if (!window.isDestroyed()) {
                        window.webContents.send('sessions:session-updated', sessionId, rendererUpdate);
                    }
                }
            }
            return { success: true };
        } catch (error) {
            console.error('[SessionHandlers] Failed to update session metadata:', error);
            return { success: false, error: String(error) };
        }
    });

    // Update session metadata with extended fields
    safeHandle('sessions:update-session-metadata', async (event, sessionId: string, updates: any) => {
        try {
            // Extract sessionType and metadata from updates
            const { sessionType, ...metadataFields } = updates;

            // Build update payload
            const updatePayload: any = {};
            if (sessionType !== undefined) {
                updatePayload.sessionType = sessionType;
            }
            if (Object.keys(metadataFields).length > 0) {
                updatePayload.metadata = metadataFields;
            }

            await AISessionsRepository.updateMetadata(sessionId, updatePayload);

            // Notify all windows about the update
            const { BrowserWindow } = await import('electron');
            BrowserWindow.getAllWindows().forEach(window => {
                if (!window.isDestroyed()) {
                    window.webContents.send('sessions:session-updated', sessionId, metadataFields);
                }
            });

            return { success: true };
        } catch (error) {
            console.error('[SessionHandlers] Failed to update session metadata:', error);
            return { success: false, error: String(error) };
        }
    });

    // Branch a session
    safeHandle('sessions:branch', async (event, payload: {
        parentSessionId: string;
        branchPointMessageId?: number;
        workspacePath?: string;
    }) => {
        try {
            const { parentSessionId, branchPointMessageId, workspacePath } = payload;
            const branchedSession = await sessionManager.branchSession(
                parentSessionId,
                branchPointMessageId,
                workspacePath
            );

            // Notify all windows about the new branch
            const { BrowserWindow } = await import('electron');
            BrowserWindow.getAllWindows().forEach(window => {
                if (!window.isDestroyed()) {
                    window.webContents.send('sessions:session-created', branchedSession);
                }
            });

            return { success: true, session: branchedSession };
        } catch (error) {
            console.error('[SessionHandlers] Failed to branch session:', error);
            return { success: false, error: String(error) };
        }
    });

    // Get branches for a session
    safeHandle('sessions:get-branches', async (event, sessionId: string) => {
        try {
            const branches = await AISessionsRepository.getBranches(sessionId);
            return { success: true, branches };
        } catch (error) {
            console.error('[SessionHandlers] Failed to get session branches:', error);
            return { success: false, error: String(error) };
        }
    });

    // List sessions for workspace
    safeHandle('sessions:list', async (event, workspacePath: string, options?: { includeArchived?: boolean }) => {
        try {
            const startTime = performance.now();
            const entries = await AISessionsRepository.list(workspacePath, options);
            const listTime = performance.now() - startTime;
            // console.log(`[SessionHandlers] sessions:list query took ${listTime.toFixed(1)}ms for ${entries.length} sessions`);

            // Get uncommitted file counts for all sessions
            // Count files edited by each session that are currently uncommitted in git
            // Uses cached git status and a query bounded to currently-uncommitted paths
            const uncommittedMap = new Map<string, number>();
            try {
                const uncommittedFiles = await getCachedUncommittedFiles(workspacePath);

                if (uncommittedFiles.size > 0) {
                    const fileToSession = await getSessionsForUncommittedFiles(workspacePath, uncommittedFiles);
                    // Every entry is, by construction, a currently-uncommitted file
                    fileToSession.forEach((sessionId) => {
                        uncommittedMap.set(sessionId, (uncommittedMap.get(sessionId) || 0) + 1);
                    });
                }
            } catch (error) {
                console.error('[SessionHandlers] Failed to get uncommitted counts:', error);
            }

            // Use entry data directly - it already has all the info we need including updatedAt
            const sessions = entries.map(entry => {
                const uncommittedCount = uncommittedMap.get(entry.id) || 0;
                return {
                    id: entry.id,
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                    name: entry.title,
                    title: entry.title,
                    provider: entry.provider,
                    model: entry.model,
                    sessionType: entry.sessionType || 'session',
                    agentRole: entry.agentRole || 'standard',
                    createdBySessionId: entry.createdBySessionId || null,
                    messageCount: entry.messageCount || 0,
                    isArchived: entry.isArchived || false,
                    isPinned: entry.isPinned || false,  // Include isPinned from repository
                    worktreeId: entry.worktreeId,  // Include worktreeId from repository
                    parentSessionId: entry.parentSessionId || null,  // Hierarchical workstream support
                    childCount: entry.childCount || 0,  // Number of child sessions
                    uncommittedCount,  // Number of uncommitted files
                    hasUnread: entry.hasUnread || false,  // Unread state from metadata
                    hasPendingQuestion: (entry as any).hasPendingQuestion || false,  // Pending AskUserQuestion state from metadata
                    hasPendingInteractivePrompt: (entry as any).hasPendingQuestion || false,
                    // Branch tracking - SEPARATE from hierarchical parentSessionId
                    branchedFromSessionId: entry.branchedFromSessionId,
                    branchPointMessageId: entry.branchPointMessageId,
                    branchedAt: entry.branchedAt,
                    // Kanban board phase and tags
                    phase: (entry as any).phase || undefined,
                    tags: (entry as any).tags || undefined,
                    // Linked tracker item IDs
                    linkedTrackerItemIds: (entry as any).linkedTrackerItemIds || undefined,
                    metadata: {}
                };
            });

            return { success: true, sessions };
        } catch (error) {
            console.error('[SessionHandlers] Failed to list sessions:', error);
            return { success: false, error: String(error), sessions: [] };
        }
    });

    // List child sessions for a parent session
    safeHandle('sessions:list-children', async (
        event,
        parentSessionId: string,
        workspacePath: string,
        options?: { includeArchived?: boolean }
    ) => {
        try {
            const { database } = await import('../database/PGLiteDatabaseWorker');
            const includeArchived = options?.includeArchived === true;
            const archivedFilter = includeArchived
                ? ''
                : 'AND (s.is_archived = FALSE OR s.is_archived IS NULL)';

            const { rows } = await database.query<any>(
                `SELECT s.id, s.provider, s.model, s.session_type, s.mode, s.agent_role, s.created_by_session_id, s.title, s.workspace_id,
                        s.worktree_id, s.parent_session_id, s.created_at, s.updated_at, s.is_archived, s.is_pinned,
                        s.metadata,
                        COUNT(m.id) as message_count,
                        (SELECT COUNT(*) FROM ai_sessions cs WHERE cs.parent_session_id = s.id) as child_count
                 FROM ai_sessions s
                 LEFT JOIN ai_agent_messages m ON s.id = m.session_id AND m.direction = 'input' AND (m.hidden = FALSE OR m.hidden IS NULL)
                 WHERE s.parent_session_id = $1 AND s.workspace_id = $2
                   ${archivedFilter}
                 GROUP BY s.id, s.provider, s.model, s.session_type, s.mode, s.agent_role, s.created_by_session_id, s.title, s.workspace_id,
                          s.worktree_id, s.parent_session_id, s.created_at, s.updated_at, s.is_archived, s.is_pinned,
                          s.metadata
                 ORDER BY s.created_at ASC`,
                [parentSessionId, workspacePath]
            );

            // Calculate uncommitted file counts per session
            // Uses cached git status and a query bounded to currently-uncommitted paths
            const uncommittedMap = new Map<string, number>();
            try {
                const uncommittedFiles = await getCachedUncommittedFiles(workspacePath);

                if (uncommittedFiles.size > 0) {
                    // Get the session IDs we care about (children of this parent)
                    const childSessionIds = new Set(rows.map((r: any) => r.id));

                    const fileToSession = await getSessionsForUncommittedFiles(workspacePath, uncommittedFiles);
                    fileToSession.forEach((sessionId) => {
                        if (childSessionIds.has(sessionId)) {
                            uncommittedMap.set(sessionId, (uncommittedMap.get(sessionId) || 0) + 1);
                        }
                    });
                }
            } catch (error) {
                console.error('[SessionHandlers] Failed to get uncommitted counts for children:', error);
            }

            const children = rows.map((row: any) => {
                // SQLite returns TEXT columns as raw strings; PGLite returns
                // JSONB columns already parsed. Without this, phase/tags/
                // linkedTrackerItemIds silently disappear from the sidebar.
                const metadata = parseJsonObjectColumn(row.metadata);
                return {
                    id: row.id,
                    title: row.title || 'Untitled Session',
                    provider: row.provider,
                    model: row.model,
                    sessionType: row.session_type || 'session',
                    mode: row.mode || null,
                    agentRole: row.agent_role || 'standard',
                    createdBySessionId: row.created_by_session_id || null,
                    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : new Date(row.created_at).getTime(),
                    updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : new Date(row.updated_at).getTime(),
                    workspaceId: row.workspace_id,
                    worktreeId: row.worktree_id || null,
                    parentSessionId: row.parent_session_id,
                    isArchived: row.is_archived || false,
                    isPinned: row.is_pinned || false,
                    messageCount: typeof row.message_count === 'string'
                        ? parseInt(row.message_count, 10) || 0
                        : (row.message_count || 0),
                    childCount: typeof row.child_count === 'string'
                        ? parseInt(row.child_count, 10) || 0
                        : (row.child_count || 0),
                    uncommittedCount: uncommittedMap.get(row.id) || 0,
                    // Metadata fields needed by TrackerPanel, kanban, etc.
                    phase: metadata.phase || undefined,
                    tags: Array.isArray(metadata.tags) ? metadata.tags : undefined,
                    linkedTrackerItemIds: Array.isArray(metadata.linkedTrackerItemIds) ? metadata.linkedTrackerItemIds : undefined,
                };
            });

            return { success: true, children };
        } catch (error) {
            console.error('[SessionHandlers] Failed to list child sessions:', error);
            return { success: false, error: String(error), children: [] };
        }
    });

    // Create a child session under a parent
    safeHandle('sessions:create-child', async (event, payload: {
        parentSessionId: string;
        workspacePath: string;
        worktreeId?: string;
        provider?: string;
        model?: string;
    }) => {
        console.log('[SessionHandlers] sessions:create-child called with:', JSON.stringify(payload));
        try {
            const { parentSessionId, workspacePath, worktreeId, provider: rawProvider = 'claude-code', model: providedModel } = payload;
            // Use crypto.randomUUID() instead of dynamic import to avoid bundling issues
            const sessionId = crypto.randomUUID();
            console.log(`[SessionHandlers] Creating child session ${sessionId} for parent ${parentSessionId}`);

            // Extract and sync provider from model ID if model follows "provider:model" format
            // This prevents mismatches where provider and model come from different sources
            let provider = rawProvider;
            let model: string;
            if (providedModel) {
                const modelId = ModelIdentifier.tryParse(providedModel);
                if (modelId) {
                    provider = modelId.provider;
                }
                model = providedModel;
            } else {
                model = ModelIdentifier.getDefaultModelId(provider as AIProviderType);
            }

            const createPayload = {
                id: sessionId,
                provider,
                model,  // Include proper model ID
                title: 'New Session',
                workspaceId: workspacePath,
                parentSessionId,  // Link to parent
                worktreeId: worktreeId || null,  // Inherit from parent if provided
            };

            await AISessionsRepository.create(createPayload as any);
            trackCreateAISession(provider as AIProviderType, {
                worktreeId: createPayload.worktreeId,
                parentSessionId,
            });
            console.log(`[SessionHandlers] Child session ${sessionId} created successfully with model: ${model}`);

            return { success: true, sessionId };
        } catch (error) {
            console.error('[SessionHandlers] Failed to create child session:', error);
            return { success: false, error: String(error) };
        }
    });

    // Set parent for a session (reparent operation for drag-drop)
    safeHandle('sessions:set-parent', async (event, payload: {
        sessionId: string;
        newParentId: string | null;
        workspacePath: string;
    }) => {
        try {
            const { sessionId, newParentId, workspacePath } = payload;

            // Validate session exists
            const session = await AISessionsRepository.get(sessionId);
            if (!session) {
                return { success: false, error: 'Session not found' };
            }

            // Validate session belongs to the workspace
            if (session.workspacePath !== workspacePath) {
                return { success: false, error: 'Session does not belong to this workspace' };
            }

            // If setting a parent, validate the parent exists and is in same workspace
            if (newParentId) {
                const parent = await AISessionsRepository.get(newParentId);
                if (!parent) {
                    return { success: false, error: 'Parent session not found' };
                }
                if (parent.workspacePath !== workspacePath) {
                    return { success: false, error: 'Parent session is in a different workspace' };
                }

                // Parent must not itself be a child session (no nested workstreams)
                if (parent.parentSessionId) {
                    return { success: false, error: 'Cannot nest workstreams: parent is already a child session' };
                }
            }

            // Update parent_session_id
            await AISessionsRepository.updateMetadata(sessionId, { parentSessionId: newParentId });

            return { success: true };
        } catch (error) {
            console.error('[SessionHandlers] Failed to set session parent:', error);
            return { success: false, error: String(error) };
        }
    });

    // Search sessions for workspace (full content search)
    safeHandle('sessions:search', async (event, workspacePath: string, query: string, options?: {
        includeArchived?: boolean;
        timeRange?: '7d' | '30d' | '90d' | 'all';
        direction?: 'all' | 'input' | 'output';
    }) => {
        try {
            const entries = await AISessionsRepository.search(workspacePath, query, options);

            // Use batch query instead of N individual get() calls
            const sessionIds = entries.map(e => e.id);
            const sessionsData = await AISessionsRepository.getMany(sessionIds);

            // Create a map for O(1) lookups to merge with entry data
            const sessionMap = new Map(sessionsData.map(s => [s.id, s]));

            const sessions = entries
                .map(entry => {
                    const session = sessionMap.get(entry.id);
                    if (!session) return null;
                    return {
                        id: session.id,
                        createdAt: session.createdAt,
                        updatedAt: session.updatedAt,
                        name: session.title,
                        title: session.title,
                        provider: session.provider,
                        model: session.model,
                        sessionType: session.sessionType || 'session',
                        messageCount: entry.messageCount || 0,
                        isArchived: entry.isArchived || false,
                        worktreeId: session.worktreeId,
                        metadata: session.metadata || {}
                    };
                })
                .filter((s): s is NonNullable<typeof s> => s !== null);

            return { success: true, sessions };
        } catch (error) {
            console.error('[SessionHandlers] Failed to search sessions:', error);
            return { success: false, error: String(error), sessions: [] };
        }
    });

    // Delete session
    safeHandle('sessions:delete', async (event, sessionId: string) => {
        try {
            // Destroy any active provider (aborts lead query and kills all teammates)
            ProviderFactory.destroyProvider(sessionId);

            await AISessionsRepository.delete(sessionId);
            return { success: true };
        } catch (error) {
            console.error('[SessionHandlers] Failed to delete session:', error);
            return { success: false, error: String(error) };
        }
    });

    // Update session pinned status
    safeHandle('sessions:update-pinned', async (_event, sessionId: string, isPinned: boolean) => {
        try {
            await AISessionsRepository.updateMetadata(sessionId, { isPinned } as any);
            return { success: true };
        } catch (error) {
            console.error('[SessionHandlers] Failed to update session pinned status:', error);
            return { success: false, error: String(error) };
        }
    });

    // Migrate unassigned sessions to a workspace
    safeHandle('sessions:migrate-unassigned', async (event, workspacePath: string) => {
        try {
            const { migrateUnassignedSessions, countUnassignedSessions } = await import('../services/migrateUnassignedSessions');
            const { getDatabase } = await import('../services/PGLiteSessionStore');
            const db = getDatabase();

            if (!db) {
                return { success: false, error: 'Database not initialized' };
            }

            const countBefore = await countUnassignedSessions(db);
            const result = await migrateUnassignedSessions(db, workspacePath);

            console.log(`[SessionHandlers] Migrated ${result.migrated} sessions to workspace: ${workspacePath}`);

            return {
                success: true,
                migrated: result.migrated,
                countBefore
            };
        } catch (error) {
            console.error('[SessionHandlers] Failed to migrate sessions:', error);
            return { success: false, error: String(error) };
        }
    });

    // Mark session as read (update read state)
    safeHandle('sessions:mark-read', async (event, sessionId: string, lastMessageTimestamp: number | null) => {
        try {
            const { database } = await import('../database/PGLiteDatabaseWorker');
            // Store timestamp using to_timestamp() to avoid timezone issues
            if (lastMessageTimestamp) {
                await database.query(
                    `UPDATE ai_sessions
                     SET last_read_timestamp = to_timestamp($1 / 1000.0), last_read_message_id = NULL
                     WHERE id = $2`,
                    [lastMessageTimestamp, sessionId]
                );
            } else {
                await database.query(
                    `UPDATE ai_sessions
                     SET last_read_timestamp = NULL, last_read_message_id = NULL
                     WHERE id = $1`,
                    [sessionId]
                );
            }
            return { success: true };
        } catch (error) {
            console.error('[SessionHandlers] Error marking session as read:', error);
            return { success: false, error: String(error) };
        }
    });

    // Get active session - not implemented, returns null
    safeHandle('session:get-active', async (event, filePath: string) => {
        // This API doesn't exist in current SessionManager
        // Would need to track active sessions per file separately
        return null;
    });

    // Set active session - not implemented, no-op
    safeHandle('session:set-active', async (event, filePath: string, sessionId: string, type: string) => {
        // This API doesn't exist in current SessionManager
        // Would need to track active sessions per file separately
    });

    // Check conflicts - not implemented, returns no conflicts
    safeHandle('session:check-conflicts', async (event, session: any, currentMarkdownHash: string) => {
        // Conflict checking isn't implemented in current system
        return { hasConflicts: false };
    });

    // Resolve conflict - not implemented, no-op
    safeHandle('session:resolve-conflict', async (event, session: any, resolution: string, newBaseHash?: string) => {
        // Conflict resolution isn't implemented in current system
    });

    // Create checkpoint - not implemented, no-op
    safeHandle('session:create-checkpoint', async (event, sessionId: string, state: string) => {
        // Checkpoints aren't implemented in current system
    });

    // Get sessions by file path (cross-worktree aware)
    safeHandle('sessions:get-by-file', async (event, workspaceId: string, filePath: string) => {
        try {
            const { database } = await import('../database/PGLiteDatabaseWorker');
            const { resolveProjectPath, isWorktreePath } = await import('../utils/workspaceDetection');

            // Compute relative path for cross-workspace matching
            const relativePath = filePath.startsWith(workspaceId)
                ? filePath.slice(workspaceId.length) // includes leading /
                : null;

            const projectPath = resolveProjectPath(workspaceId);

            let fileLinksResult;
            if (relativePath) {
                // Query across all related workspaces using relative path suffix
                // This handles: worktree -> main project, main project -> worktrees,
                // and worktree -> other worktrees
                // Escape SQL LIKE wildcards in the path to prevent unintended pattern matching
                const escapedRelativePath = relativePath.replace(/[%_\\]/g, '\\$&');
                const escapedProjectPath = projectPath.replace(/[%_\\]/g, '\\$&');
                fileLinksResult = await database.query(
                    `SELECT DISTINCT session_id FROM session_files
                     WHERE file_path LIKE '%' || $1 ESCAPE '\\'
                     AND (workspace_id = $2 OR workspace_id = $3 OR workspace_id LIKE $4 ESCAPE '\\')`,
                    [escapedRelativePath, workspaceId, projectPath, escapedProjectPath + '_worktrees/%']
                );
            } else {
                // Fallback: exact match only
                fileLinksResult = await database.query(
                    `SELECT DISTINCT session_id FROM session_files
                     WHERE workspace_id = $1 AND file_path = $2`,
                    [workspaceId, filePath]
                );
            }

            if (!fileLinksResult.rows || fileLinksResult.rows.length === 0) {
                return [];
            }

            const sessionIds = fileLinksResult.rows.map((row: any) => row.session_id);

            // Get list entries with messageCount (only available for current workspace sessions)
            const listEntries = await AISessionsRepository.list(workspaceId);
            const entriesMap = new Map(listEntries.map(entry => [entry.id, entry]));

            // Use batch query instead of N individual get() calls
            const sessionsData = await AISessionsRepository.getMany(sessionIds);

            // Map and enrich with entry data
            // Sort: current workspace sessions first, then others by updatedAt desc
            const sessions = sessionsData
                .map(session => {
                    const entry = entriesMap.get(session.id);
                    const sessionWorkspaceId = session.workspacePath || '';
                    // Worktree-aware matching: when viewing from a worktree, match
                    // sessions whose worktreePath equals this worktree. When viewing
                    // from the main project, match sessions with no worktree association.
                    const isCurrentWs = isWorktreePath(workspaceId)
                        ? session.worktreePath === workspaceId
                        : !session.worktreePath && sessionWorkspaceId === workspaceId;
                    return {
                        id: session.id,
                        title: session.title || 'Untitled Session',
                        provider: session.provider,
                        model: session.model,
                        createdAt: session.createdAt,
                        updatedAt: session.updatedAt,
                        messageCount: entry?.messageCount || 0,
                        worktreeId: (session as any).worktreeId || null,
                        isCurrentWorkspace: isCurrentWs
                    };
                })
                .sort((a, b) => {
                    // Current workspace sessions first
                    if (a.isCurrentWorkspace !== b.isCurrentWorkspace) {
                        return a.isCurrentWorkspace ? -1 : 1;
                    }
                    return (b.updatedAt || 0) - (a.updatedAt || 0);
                });

            return sessions;
        } catch (error) {
            console.error('[SessionHandlers] Error getting sessions by file:', error);
            return [];
        }
    });

    // Test-only: Query database directly (for e2e tests and debugging)
    // This handler is safe to leave registered as it's read-only
    safeHandle('test:query-db', async (event, sql: string, params?: any[]) => {
        try {
            const { database } = await import('../database/PGLiteDatabaseWorker');
            const result = await database.query(sql, params);
            return result;
        } catch (error) {
            console.error('[SessionHandlers] Test query error:', error);
            return { error: String(error) };
        }
    });

    // ============================================================
    // Test-only handlers for E2E testing without AI agent
    // These allow inserting mock sessions and messages for testing
    // interactive prompt widgets in isolation.
    // SECURITY: Only registered in development/test environments.
    // ============================================================

    const isTestEnv = process.env.NODE_ENV === 'development' ||
                      process.env.NODE_ENV === 'test' ||
                      process.env.PLAYWRIGHT === '1' ||
                      process.env.PLAYWRIGHT_TEST === 'true';

    if (!isTestEnv) {
        console.log('[SessionHandlers] Skipping test handlers in production');
    }

    /**
     * Test-only: Create a test session directly in the database.
     * Used for E2E testing interactive prompts without invoking the AI agent.
     */
    if (isTestEnv) safeHandle('test:insert-session', async (event, payload: {
        id: string;
        workspaceId: string;
        provider?: string;
        model?: string;
        title?: string;
        agentRole?: 'standard' | 'meta-agent';
        createdBySessionId?: string | null;
        status?: 'idle' | 'running' | 'waiting_for_input' | 'error' | 'interrupted';
        createdAt?: number;
        updatedAt?: number;
        lastActivity?: number;
    }) => {
        try {
            const { database } = await import('../database/PGLiteDatabaseWorker');
            const {
                id,
                workspaceId,
                provider = 'claude-code',
                model = 'opus',
                title = 'Test Session',
                agentRole = 'standard',
                createdBySessionId = null,
                status = 'idle',
                createdAt,
                updatedAt,
                lastActivity,
            } = payload;

            const createdAtDate = createdAt ? new Date(createdAt) : new Date();
            const updatedAtDate = updatedAt ? new Date(updatedAt) : createdAtDate;
            const lastActivityDate = lastActivity ? new Date(lastActivity) : updatedAtDate;

            await database.query(
                `INSERT INTO ai_sessions (
                    id, workspace_id, provider, model, title, session_type, agent_role, created_by_session_id, status, created_at, updated_at, last_activity
                 ) VALUES ($1, $2, $3, $4, $5, 'session', $6, $7, $8, $9, $10, $11)`,
                [id, workspaceId, provider, model, title, agentRole, createdBySessionId, status, createdAtDate, updatedAtDate, lastActivityDate]
            );

            // Notify renderer to refresh session list
            event.sender.send('sessions:refresh-list', {
                workspacePath: workspaceId,
                sessionId: id
            });

            return { success: true, id };
        } catch (error) {
            console.error('[SessionHandlers] test:insert-session error:', error);
            return { success: false, error: String(error) };
        }
    });

    /**
     * Test-only: Insert a message directly into ai_agent_messages.
     * Used for E2E testing interactive prompts without invoking the AI agent.
     */
    if (isTestEnv) safeHandle('test:insert-message', async (event, payload: {
        sessionId: string;
        direction: 'input' | 'output';
        content: string;
        source?: string;
        metadata?: any;
    }) => {
        try {
            const { database } = await import('../database/PGLiteDatabaseWorker');
            const { sessionId, direction, content, source = 'nimbalyst', metadata } = payload;

            const { rows } = await database.query<{ id: string }>(
                `INSERT INTO ai_agent_messages (session_id, source, direction, content, metadata, created_at, hidden)
                 VALUES ($1, $2, $3, $4, $5, NOW(), false)
                 RETURNING id`,
                [sessionId, source, direction, content, metadata ? JSON.stringify(metadata) : null]
            );
            return { success: true, id: rows[0].id };
        } catch (error) {
            console.error('[SessionHandlers] test:insert-message error:', error);
            return { success: false, error: String(error) };
        }
    });

    /**
     * Test-only: Clean up test sessions for a workspace.
     * Removes sessions with titles starting with 'Test Session'.
     */
    if (isTestEnv) safeHandle('test:clear-test-sessions', async (event, workspaceId: string) => {
        try {
            const { database } = await import('../database/PGLiteDatabaseWorker');

            // Delete messages first (foreign key constraint)
            await database.query(
                `DELETE FROM ai_agent_messages WHERE session_id IN (
                   SELECT id FROM ai_sessions WHERE workspace_id = $1 AND title LIKE 'Test Session%'
                 )`,
                [workspaceId]
            );

            // Then delete sessions
            await database.query(
                `DELETE FROM ai_sessions WHERE workspace_id = $1 AND title LIKE 'Test Session%'`,
                [workspaceId]
            );

            return { success: true };
        } catch (error) {
            console.error('[SessionHandlers] test:clear-test-sessions error:', error);
            return { success: false, error: String(error) };
        }
    });



    // Get uncommitted file counts per session (lightweight, for updating after git commits)
    // Returns counts for ALL sessions that have edited files, including 0 for fully
    // committed sessions -- the caller relies on the explicit 0 to reset stale UI badges.
    safeHandle('sessions:get-uncommitted-counts', async (event, workspacePath: string) => {
        try {
            const uncommittedFiles = await getCachedUncommittedFiles(workspacePath);

            // Seed every session that has ever edited a file with 0 so callers
            // reset previously-non-zero badges to 0 when files get committed.
            const editorIds = await getSessionIdsWithEdits(workspacePath);
            const counts: Record<string, number> = {};
            editorIds.forEach(sessionId => {
                counts[sessionId] = 0;
            });

            if (uncommittedFiles.size > 0) {
                const fileToSession = await getSessionsForUncommittedFiles(workspacePath, uncommittedFiles);
                fileToSession.forEach((sessionId) => {
                    counts[sessionId] = (counts[sessionId] || 0) + 1;
                });
            }

            return { success: true, counts };
        } catch (error) {
            console.error('[SessionHandlers] Failed to get uncommitted counts:', error);
            return { success: false, error: String(error), counts: {} };
        }
    });

    // ============================================================
    // Interactive Prompts - Durable AI-to-User Interactions
    // These handlers support the durable interactive prompts architecture
    // where the database is the source of truth for pending prompts.
    // ============================================================


    /**
     * Respond to an interactive prompt.
     * Creates a response message and optionally updates the request status.
     */
    safeHandle('messages:respond-to-prompt', async (event, params: {
        sessionId: string;
        promptId: string;
        promptType: 'permission_request' | 'ask_user_question_request' | 'exit_plan_mode_request' | 'git_commit_proposal_request' | 'request_user_input_request';
        response: any;
        respondedBy: 'desktop' | 'mobile';
    }) => {
        try {
            const { sessionId, promptId, promptType, response, respondedBy } = params;
            const { database } = await import('../database/PGLiteDatabaseWorker');
            const timestamp = Date.now();
            const requestUserInputTargets = promptType === 'request_user_input_request'
                ? resolveRequestUserInputPromptTargets(promptId)
                : null;
            const canonicalPromptId = promptType === 'git_commit_proposal_request'
                ? await resolveGitCommitProposalPromptId(sessionId, promptId)
                : promptId;

            // Determine response type and content
            let responseContent: any;
            if (promptType === 'permission_request') {
                responseContent = {
                    type: 'permission_response',
                    requestId: canonicalPromptId,
                    decision: response.decision,
                    scope: response.scope,
                    respondedAt: timestamp,
                    respondedBy,
                };
            } else if (promptType === 'ask_user_question_request') {
                responseContent = {
                    type: 'ask_user_question_response',
                    questionId: canonicalPromptId,
                    answers: response.answers || response,
                    cancelled: response.cancelled || false,
                    respondedAt: timestamp,
                    respondedBy,
                };
            } else if (promptType === 'exit_plan_mode_request') {
                responseContent = {
                    type: 'exit_plan_mode_response',
                    requestId: canonicalPromptId,
                    approved: response.approved,
                    clearContext: response.clearContext,
                    feedback: response.feedback,
                    respondedAt: timestamp,
                    respondedBy,
                };
            } else if (promptType === 'git_commit_proposal_request') {
                responseContent = {
                    type: 'git_commit_proposal_response',
                    proposalId: canonicalPromptId,
                    action: response.action,
                    commitHash: response.commitHash,
                    commitDate: response.commitDate,
                    error: response.error,
                    filesCommitted: response.filesCommitted,
                    commitMessage: response.commitMessage,
                    respondedAt: timestamp,
                    respondedBy,
                };
            } else if (promptType === 'request_user_input_request') {
                responseContent = {
                    type: 'request_user_input_response',
                    promptId: canonicalPromptId,
                    ...(requestUserInputTargets?.rawPromptId ? { rawPromptId: requestUserInputTargets.rawPromptId } : {}),
                    answers: response.answers || {},
                    cancelled: response.cancelled === true,
                    respondedAt: timestamp,
                    respondedBy,
                };
            }

            // Insert response message
            await database.query(
                `INSERT INTO ai_agent_messages (session_id, source, direction, content, created_at, hidden)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    sessionId,
                    'nimbalyst',
                    'output',
                    JSON.stringify(responseContent),
                    new Date(timestamp),
                    false,
                ]
            );

            // Codex currently may not emit a follow-up item.completed event for
            // long-blocking MCP tools after interactive approval. Persist a
            // synthetic completion event so transcript replay shows committed state.
            if (promptType === 'git_commit_proposal_request') {
                const codexLookupId = parseCodexToolLookupId(promptId);
                if (codexLookupId) {
                    try {
                        const session = await AISessionsRepository.get(sessionId);
                        if (session?.provider === 'openai-codex') {
                            const { rows: existingCompletionRows } = await database.query(
                                `SELECT id
                                 FROM ai_agent_messages
                                 WHERE session_id = $1
                                   AND metadata ->> 'codexProvider' = 'true'
                                   AND metadata ->> 'eventType' = 'item.completed'
                                   AND content LIKE $2
                                 LIMIT 1`,
                                [sessionId, `%"id":"${codexLookupId.itemId}"%`]
                            );

                            if (existingCompletionRows.length === 0) {
                                const hasError = !!response.error || response.action !== 'committed' || !response.commitHash;
                                const rawCompletionEvent = {
                                    type: 'item.completed',
                                    item: {
                                        id: codexLookupId.itemId,
                                        type: 'mcp_tool_call',
                                        server: 'nimbalyst-mcp',
                                        tool: 'developer_git_commit_proposal',
                                        result: {
                                            action: response.action,
                                            commitHash: response.commitHash,
                                            commitDate: response.commitDate,
                                            filesCommitted: response.filesCommitted,
                                            commitMessage: response.commitMessage,
                                            ...(response.error ? { error: response.error } : {}),
                                        },
                                        error: hasError ? (response.error || 'Commit proposal cancelled') : null,
                                        status: hasError ? 'failed' : 'completed',
                                    },
                                };

                                await database.query(
                                    `INSERT INTO ai_agent_messages (session_id, source, direction, content, metadata, created_at, hidden)
                                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                                    [
                                        sessionId,
                                        'openai-codex',
                                        'output',
                                        JSON.stringify(rawCompletionEvent),
                                        JSON.stringify({
                                            eventType: 'item.completed',
                                            codexProvider: true,
                                            syntheticCommitCompletion: true,
                                        }),
                                        new Date(timestamp + 1),
                                        false,
                                    ]
                                );
                            }
                        }
                    } catch (error) {
                        console.warn('[SessionHandlers] Failed to persist synthetic Codex commit completion event:', error);
                    }
                }
            }

            // For request_user_input, emit to the session-scoped MCP waiter channel
            // so the MCP handler resolves immediately. (The DB row above is the
            // durable fallback for cases where the MCP transport drops.)
            if (promptType === 'request_user_input_request') {
                const { ipcMain } = await import('electron');
                const {
                    getRequestUserInputResponseChannel,
                    getRequestUserInputFallbackResponseChannel,
                } = await import('../mcp/tools/interactiveToolHandlers');
                const waiterPromptIds = requestUserInputTargets?.waiterPromptIds ?? [canonicalPromptId];
                let notifiedWaiter = false;

                for (const waiterPromptId of waiterPromptIds) {
                    const channel = getRequestUserInputResponseChannel(sessionId, waiterPromptId);
                    if (ipcMain.listenerCount(channel) > 0) {
                        notifiedWaiter = true;
                        ipcMain.emit(channel, null, {
                            answers: response.answers,
                            cancelled: response.cancelled === true,
                            respondedBy,
                        });
                    }
                }

                const fallbackChannel = getRequestUserInputFallbackResponseChannel(sessionId);
                if (!notifiedWaiter && ipcMain.listenerCount(fallbackChannel) > 0) {
                    notifiedWaiter = true;
                    ipcMain.emit(fallbackChannel, null, {
                        promptId: canonicalPromptId,
                        ...(requestUserInputTargets?.rawPromptId ? { rawPromptId: requestUserInputTargets.rawPromptId } : {}),
                        answers: response.answers,
                        cancelled: response.cancelled === true,
                        respondedBy,
                    });
                }

                if (!notifiedWaiter) {
                    console.warn(
                        `[SessionHandlers] No MCP waiter for RequestUserInput on channels: ${waiterPromptIds.join(', ')}. ` +
                        `Response was persisted to DB; the handler may have already resolved or the subprocess exited.`,
                    );
                }
                event.sender.send('ai:requestUserInputResolved', { sessionId, promptId: canonicalPromptId });
                TrayManager.getInstance().onPromptResolved(sessionId);
            }

            // For git_commit_proposal, emit to the session-scoped MCP waiter channel
            // and notify renderer to clear the pending interactive prompt indicator
            if (promptType === 'git_commit_proposal_request') {
                const { ipcMain } = await import('electron');
                const responseChannel = getGitCommitProposalResponseChannel(sessionId, canonicalPromptId);
                const hasWaiter = ipcMain.listenerCount(responseChannel) > 0;
                if (hasWaiter) {
                    ipcMain.emit(responseChannel, null, response);
                } else {
                    // The MCP server's ipcMain.once() listener is gone — the Claude Code
                    // subprocess likely died or the app restarted since the proposal was
                    // created.  The response was already persisted to DB above, so it's
                    // durable. Mark the session as idle so it doesn't appear stuck forever.
                    console.warn(
                        `[SessionHandlers] No MCP waiter for git commit proposal response on channel: ${responseChannel}. ` +
                        `The Claude Code subprocess may have exited. Session: ${sessionId}, proposalId: ${canonicalPromptId}. ` +
                        `Marking session as idle.`
                    );
                    try {
                        const { getSessionStateManager } = await import('@nimbalyst/runtime/ai/server/SessionStateManager');
                        const stateManager = getSessionStateManager();
                        await stateManager.endSession(sessionId);
                    } catch (cleanupErr) {
                        console.warn('[SessionHandlers] Failed to mark orphaned session as idle:', cleanupErr);
                    }
                }
                event.sender.send('ai:gitCommitProposalResolved', { sessionId, proposalId: canonicalPromptId });
                TrayManager.getInstance().onPromptResolved(sessionId);
            }

            return { success: true, responseContent };
        } catch (error) {
            console.error('[SessionHandlers] Failed to respond to prompt:', error);
            return { success: false, error: String(error) };
        }
    });
    // Link a tracker item or file to a session
    // trackerId can be a DB tracker item ID or "file:path/to/file.md" for file-based items
    safeHandle('tracker:link-session', async (_event, payload: { trackerId: string; sessionId: string }) => {
        try {
            if (payload.trackerId.startsWith('file:')) {
                // File-based link: only write to session metadata (no tracker_items row to update)
                const { getDatabase } = await import('../database/initialize');
                const db = getDatabase();
                const fileRef = payload.trackerId;
                const sessionResult = await db.query<any>(
                    `SELECT metadata FROM ai_sessions WHERE id = $1`,
                    [payload.sessionId]
                );
                if (sessionResult.rows.length > 0) {
                    const metadata = sessionResult.rows[0].metadata ?? {};
                    const linkedTrackerItemIds: string[] = metadata.linkedTrackerItemIds || [];
                    if (!linkedTrackerItemIds.includes(fileRef)) {
                        linkedTrackerItemIds.push(fileRef);
                        await db.query(
                            `UPDATE ai_sessions SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
                            [JSON.stringify({ linkedTrackerItemIds }), payload.sessionId]
                        );
                    }
                }
            } else {
                // DB tracker item: bidirectional link
                const { createBidirectionalLink } = await import('../mcp/tools/trackerToolHandlers');
                await createBidirectionalLink(payload.trackerId, payload.sessionId);
            }
            return { success: true };
        } catch (error) {
            console.error('[SessionHandlers] Failed to link tracker item to session:', error);
            return { success: false, error: String(error) };
        }
    });

    // ============================================================
    // Canonical transcript queries
    // ============================================================

    safeHandle('transcript:list-user-prompts', async (_event, workspacePath: string, limit: number = 2000) => {
        const { database } = await import('../database/PGLiteDatabaseWorker');
        const { rows } = await database.query(`
            SELECT t.id, t.session_id, t.searchable_text, t.created_at,
                   s.title, s.provider, s.parent_session_id
            FROM ai_transcript_events t
            JOIN ai_sessions s ON t.session_id = s.id
            WHERE t.event_type = 'user_message'
              AND t.searchable = TRUE
              AND s.workspace_id = $1
            ORDER BY t.created_at DESC
            LIMIT $2
        `, [workspacePath, limit]);
        return {
            success: true,
            prompts: rows.map((row: any) => ({
                id: String(row.id),
                sessionId: row.session_id,
                content: row.searchable_text || '',
                createdAt: row.created_at instanceof Date ? row.created_at.getTime() : new Date(row.created_at).getTime(),
                sessionTitle: row.title || 'Untitled Session',
                provider: row.provider,
                parentSessionId: row.parent_session_id,
            })),
        };
    });

    safeHandle('transcript:get-tail-messages', async (_event, sessionId: string, count: number = 10) => {
        if (!TranscriptMigrationRepository.hasService()) return [];

        const session = await AISessionsRepository.get(sessionId);
        if (!session) return [];

        // Use efficient tail query instead of loading all events
        const migrationService = TranscriptMigrationRepository.getService();
        const tailEvents = await migrationService.getTailEvents(
            sessionId,
            session.provider ?? 'unknown',
            count,
            { excludeEventTypes: ['tool_progress'] },
        );

        const viewModel = TranscriptProjector.project(tailEvents);
        return await enrichTranscriptMessagesWithToolCallDiffs(sessionId, viewModel.messages);
    });

    // DEV/TESTING ONLY: Force a single session's canonical events to be
    // dropped and reparsed from raw messages. Used when iterating on parser
    // fixes to verify against an existing session WITHOUT bumping
    // TranscriptTransformer.CURRENT_VERSION (which would reparse every
    // session in the database).
    //
    // Destructive (drops and rewrites canonical events) -- gated on dev mode
    // so it cannot be invoked from a packaged build.
    safeHandle('transcript:force-reparse-session', async (_event, sessionId: string) => {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('transcript:force-reparse-session is dev-only');
        }
        if (!sessionId) {
            throw new Error('sessionId is required');
        }
        if (!TranscriptMigrationRepository.hasService()) {
            throw new Error('TranscriptMigrationService not initialized');
        }

        const session = await AISessionsRepository.get(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const provider = session.provider ?? 'unknown';
        const migrationService = TranscriptMigrationRepository.getService();
        await migrationService.forceReparseSession(sessionId, provider);

        // Nudge any open renderer view of this session to reload from DB so the
        // user sees the reparse result without manually switching sessions.
        // Use a transcript-specific signal rather than faking ai:message-logged,
        // which would incorrectly mutate unread/activity UI.
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send('transcript:session-reparsed', {
                    sessionId,
                    workspacePath: session.workspacePath,
                });
            }
        }

        return { success: true, sessionId, provider };
    });
}

export { sessionManager };
