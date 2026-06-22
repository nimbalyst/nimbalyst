import { BrowserWindow } from "electron";
import { findWindowByWorkspace } from "../window/WindowManager";

// Store document state PER SESSION to avoid cross-window contamination
export const documentStateBySession = new Map<string, any>();

// Map workspace paths to window IDs for routing
// This is populated when we receive document state updates
export const workspaceToWindowMap = new Map<string, number>();

// Cache for worktree path -> project path resolution
// This avoids repeated database lookups for the same worktree
const worktreeToProjectPathCache = new Map<string, string | null>();

// Extension tools registered from renderer
export interface ExtensionToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  extensionId: string;
  scope: "global" | "editor";
  editorFilePatterns?: string[];
}
const extensionToolsByWorkspace = new Map<string, ExtensionToolDefinition[]>();

/**
 * Find the window ID for a given workspace path, resolving worktree paths to their parent project.
 *
 * When Claude Code runs in a worktree, the workspacePath is the worktree directory
 * (e.g., /Users/foo/repo_worktrees/gentle-flame), but the window is registered under
 * the parent project path (e.g., /Users/foo/repo). This function handles that resolution.
 *
 * @param workspacePath The workspace path (may be a worktree path or regular workspace)
 * @returns The window ID if found, or null if no window is found
 */
export async function findWindowIdForWorkspacePath(
  workspacePath: string
): Promise<number | null> {
  // First try direct lookup - this works for regular workspaces
  let windowId = workspaceToWindowMap.get(workspacePath);
  if (windowId !== undefined) {
    return windowId;
  }

  // Try findWindowByWorkspace directly
  let targetWindow = findWindowByWorkspace(workspacePath);
  if (targetWindow && !targetWindow.isDestroyed()) {
    // Cache the mapping for future lookups
    workspaceToWindowMap.set(workspacePath, targetWindow.id);
    return targetWindow.id;
  }

  // Check if this might be a worktree path
  // First check cache to avoid repeated DB lookups
  if (worktreeToProjectPathCache.has(workspacePath)) {
    const cachedProjectPath = worktreeToProjectPathCache.get(workspacePath);
    if (cachedProjectPath) {
      windowId = workspaceToWindowMap.get(cachedProjectPath);
      if (windowId !== undefined) {
        return windowId;
      }
      targetWindow = findWindowByWorkspace(cachedProjectPath);
      if (targetWindow && !targetWindow.isDestroyed()) {
        workspaceToWindowMap.set(cachedProjectPath, targetWindow.id);
        return targetWindow.id;
      }
    }
    // cachedProjectPath is null means we already checked and it's not a worktree
    return null;
  }

  // Query the database to check if this is a worktree path
  try {
    const { getDatabase } = await import("../database/initialize");
    const { createWorktreeStore } = await import("../services/WorktreeStore");
    const db = getDatabase();
    const worktreeStore = createWorktreeStore(db);
    const worktree = await worktreeStore.getByPath(workspacePath);

    if (worktree) {
      // It's a worktree - use the project path
      const projectPath = worktree.projectPath;
      worktreeToProjectPathCache.set(workspacePath, projectPath);
      console.log(
        `[MCP Server] Resolved worktree path ${workspacePath} -> project path ${projectPath}`
      );

      windowId = workspaceToWindowMap.get(projectPath);
      if (windowId !== undefined) {
        return windowId;
      }
      targetWindow = findWindowByWorkspace(projectPath);
      if (targetWindow && !targetWindow.isDestroyed()) {
        workspaceToWindowMap.set(projectPath, targetWindow.id);
        return targetWindow.id;
      }
    } else {
      // Not a worktree - cache the negative result
      worktreeToProjectPathCache.set(workspacePath, null);
    }
  } catch (error) {
    console.warn("[MCP Server] Error checking worktree path:", error);
    // Don't cache errors - they might be transient
  }

  return null;
}

/**
 * Find the correct window for a given file path by matching the workspace
 * This is critical for multi-window support - we need to send IPC to the window that has the file open
 *
 * Uses workspace path as the canonical identifier since it's stable across app restarts,
 * unlike windowId which changes every time.
 */
export async function findWindowForFilePath(
  filePath: string | undefined
): Promise<BrowserWindow | null> {
  if (!filePath) {
    throw new Error(
      "[MCP Server] CRITICAL: No file path provided to findWindowForFilePath, cannot determine target window"
    );
  }

  // First, find which workspace this file belongs to
  let targetWorkspacePath: string | undefined;
  for (const [sessionId, state] of documentStateBySession.entries()) {
    if (state?.filePath === filePath) {
      if (!state?.workspacePath) {
        // This should never happen because updateDocumentState throws if workspacePath is missing
        throw new Error(
          `[MCP Server] CRITICAL: Found matching file ${filePath} but NO WORKSPACE PATH in state! This should be impossible - updateDocumentState should have thrown. State keys: ${Object.keys(
            state || {}
          ).join(", ")}`
        );
      }

      targetWorkspacePath = state.workspacePath;
      break;
    }
  }

  if (!targetWorkspacePath) {
    const availableSessions = Array.from(documentStateBySession.entries())
      .map(([id, state]) => `${id}: ${state?.filePath || "NO FILE"}`)
      .join(", ");
    throw new Error(
      `[MCP Server] CRITICAL: Could not determine workspace for file: ${filePath}. Available sessions (${documentStateBySession.size}): ${availableSessions}`
    );
  }

  // Look up the window ID for this workspace path (resolves worktree paths to parent project)
  const windowId = await findWindowIdForWorkspacePath(targetWorkspacePath);
  if (!windowId) {
    const availableWorkspaces = Array.from(workspaceToWindowMap.entries())
      .map(([path, id]) => `${path} -> window ${id}`)
      .join(", ");
    throw new Error(
      `[MCP Server] CRITICAL: No window registered for workspace: ${targetWorkspacePath}. Available workspaces: ${
        availableWorkspaces || "NONE"
      }`
    );
  }

  // Get the window by ID
  const window = BrowserWindow.fromId(windowId);
  if (!window) {
    // Clean up stale mapping
    workspaceToWindowMap.delete(targetWorkspacePath);
    throw new Error(
      `[MCP Server] CRITICAL: Window ${windowId} for workspace ${targetWorkspacePath} no longer exists (window was closed)`
    );
  }

  return window;
}

/**
 * Update document state for a session. Validates workspacePath is present.
 * Notifies MCP client to re-fetch tools if file path changed.
 */
export function updateDocumentState(
  state: any,
  sessionId: string | undefined,
  serverByNimbalystSession: Map<string, any>
) {
  if (!sessionId) {
    sessionId = "default";
  }

  // CRITICAL: Workspace path is REQUIRED for routing
  if (!state?.workspacePath) {
    const error = new Error(
      `[MCP Server] CRITICAL: No workspacePath in document state for session ${sessionId}! Cannot route MCP tools without workspace path. State keys: ${Object.keys(
        state || {}
      ).join(", ")}`
    );
    console.error(error.message);
    throw error;
  }

  // Check if file path changed - if so, the available editor-scoped tools may have changed
  const previousState = documentStateBySession.get(sessionId);
  const filePathChanged = previousState?.filePath !== state?.filePath;

  // Store state with sessionId included so handlers can access it from the value
  documentStateBySession.set(sessionId, { ...state, sessionId });

  // Notify the MCP client that the tool list may have changed
  if (filePathChanged) {
    const server = serverByNimbalystSession.get(sessionId);
    if (server) {
      server.sendToolListChanged().catch(() => {
        // Ignore errors - client may have disconnected
      });
    }
  }
}

/**
 * Register a workspace path to window mapping
 */
export function registerWorkspaceWindow(
  workspacePath: string,
  windowId: number
) {
  const isNew = !workspaceToWindowMap.has(workspacePath);
  workspaceToWindowMap.set(workspacePath, windowId);

  // First time we see a window for this workspace? Re-check any wakeups
  // that were waiting for it. Imported lazily to avoid circular imports
  // between the MCP layer and the services layer.
  if (isNew) {
    void (async () => {
      try {
        const { SessionWakeupScheduler } = await import('../services/SessionWakeupScheduler');
        await SessionWakeupScheduler.getInstance().onWorkspaceOpened(workspacePath);
      } catch {
        // Scheduler may not be configured yet during early startup; safe to ignore.
      }
    })();
  }
}

/**
 * Remove a window from the workspace mapping when it's closed
 */
export function unregisterWindow(windowId: number) {
  for (const [
    workspacePath,
    mappedWindowId,
  ] of workspaceToWindowMap.entries()) {
    if (mappedWindowId === windowId) {
      workspaceToWindowMap.delete(workspacePath);
    }
  }
}

/**
 * Register extension tools from a workspace window.
 * Notifies all connected MCP sessions for this workspace to re-fetch their tool list.
 * This includes sessions connected via worktree paths that resolve to this workspace.
 */
export function registerExtensionTools(
  workspacePath: string,
  tools: ExtensionToolDefinition[],
  serversByWorkspace: Map<string, Set<any>>
) {
  extensionToolsByWorkspace.set(workspacePath, tools);

  // Notify connected MCP sessions that the tool list has changed.
  for (const [connectedPath, servers] of serversByWorkspace) {
    const resolvedPath = resolveExtensionToolsWorkspacePathSync(connectedPath);
    if (resolvedPath === workspacePath) {
      for (const server of servers) {
        server.sendToolListChanged().catch(() => {
          // Ignore errors - client may have disconnected
        });
      }
    }
  }
}

/**
 * Unregister extension tools for a workspace (when window closes)
 */
export function unregisterExtensionTools(workspacePath: string) {
  extensionToolsByWorkspace.delete(workspacePath);
}

/**
 * Resolve a workspace path to the path under which extension tools are registered (sync).
 */
function resolveExtensionToolsWorkspacePathSync(
  workspacePath: string
): string {
  // Direct lookup first
  if (extensionToolsByWorkspace.has(workspacePath)) {
    return workspacePath;
  }

  // Check if this is a worktree path that maps to a project path
  const projectPath = worktreeToProjectPathCache.get(workspacePath);
  if (projectPath && extensionToolsByWorkspace.has(projectPath)) {
    return projectPath;
  }

  return workspacePath;
}

/**
 * Resolve a workspace path to the path under which extension tools are registered.
 * Falls back to async database lookup if the cache doesn't have the mapping yet.
 */
async function resolveExtensionToolsWorkspacePath(
  workspacePath: string
): Promise<string> {
  // Try synchronous resolution first (cache hit)
  const syncResolved = resolveExtensionToolsWorkspacePathSync(workspacePath);
  if (syncResolved !== workspacePath || extensionToolsByWorkspace.has(workspacePath)) {
    return syncResolved;
  }

  // Cache miss - try async DB lookup for worktree resolution
  try {
    const { getDatabase } = await import("../database/initialize");
    const { createWorktreeStore } = await import("../services/WorktreeStore");
    const db = getDatabase();
    const worktreeStore = createWorktreeStore(db);
    const worktree = await worktreeStore.getByPath(workspacePath);

    if (worktree) {
      const projectPath = worktree.projectPath;
      worktreeToProjectPathCache.set(workspacePath, projectPath);
      if (extensionToolsByWorkspace.has(projectPath)) {
        return projectPath;
      }
    } else {
      worktreeToProjectPathCache.set(workspacePath, null);
    }
  } catch (error) {
    // Don't fail tool listing because of DB errors
  }

  return workspacePath;
}

/**
 * Get available extension tools for a given file path.
 * Filters based on scope and file patterns.
 */
export async function getAvailableExtensionTools(
  workspacePath: string | undefined,
  filePath: string | undefined
): Promise<ExtensionToolDefinition[]> {
  if (!workspacePath) {
    console.log(
      "[MCP Server] getAvailableExtensionTools: No workspacePath provided, returning empty array"
    );
    return [];
  }

  // Resolve worktree paths to the project path where tools are registered
  const resolvedPath = await resolveExtensionToolsWorkspacePath(workspacePath);
  const tools = extensionToolsByWorkspace.get(resolvedPath) || [];

  if (tools.length === 0) {
    console.log(
      `[MCP Server] getAvailableExtensionTools: No tools registered for workspace: ${workspacePath}${resolvedPath !== workspacePath ? ` (resolved to: ${resolvedPath})` : ""}`
    );
    return [];
  }

  // Return all tools -- both global and editor-scoped.
  // Inject a `filePath` parameter so the agent can target any file,
  // not just the currently active one.
  const enriched = tools.map((tool) => {
    // Inject filePath parameter if not already present
    const hasFilePath = tool.inputSchema.properties?.filePath;
    if (hasFilePath) {
      return tool;
    }

    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          filePath: {
            type: "string",
            description:
              "Absolute path to the file to operate on.",
          },
        },
        required: [...(tool.inputSchema.required || []), "filePath"],
      },
    };
  });

  return enriched;
}

/**
 * Distinct short-names of extensions that currently contribute MCP tools for a
 * workspace (e.g. `['excalidraw', 'slides']`). Each becomes its own deferred
 * `nimbalyst-<ext>` MCP server (MCP consolidation Phase 3).
 *
 * Synchronous (reads the in-memory registry) so it can be called from
 * `getMcpServersConfig`. Resolves worktree paths to their project path via the
 * sync cache; an un-cached worktree returns the project's tools only after the
 * first async resolution elsewhere has warmed the cache.
 */
export function getActiveExtensionShortNames(
  workspacePath: string | undefined
): string[] {
  if (!workspacePath) return [];
  const resolvedPath = resolveExtensionToolsWorkspacePathSync(workspacePath);
  const tools = extensionToolsByWorkspace.get(resolvedPath) || [];
  const shortNames = new Set<string>();
  for (const tool of tools) {
    const parts = tool.extensionId.split(".");
    const shortName = parts[parts.length - 1] || tool.extensionId;
    if (shortName) shortNames.add(shortName);
  }
  return Array.from(shortNames);
}

/**
 * Register workspace mapping for a new connection (fire-and-forget).
 */
export function registerWorkspaceMappingForConnection(
  workspacePath: string | undefined
): void {
  if (!workspacePath) {
    return;
  }

  findWindowIdForWorkspacePath(workspacePath)
    .then((windowId) => {
      if (windowId) {
        workspaceToWindowMap.set(workspacePath, windowId);
      }
    })
    .catch((err) => {
      console.warn(
        "[MCP Server] Failed to register workspace window mapping:",
        err
      );
    });
}
