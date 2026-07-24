import { BrowserWindow, ipcMain } from "electron";
import { findWindowIdForWorkspacePath } from "../mcpWorkspaceResolver";
import { getMostRecentlyFocusedWorkspaceWindow } from "../../window/WindowManager";

type McpToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError: boolean;
};

/**
 * Shared-index (first-class shared folders + documents) MCP tools.
 *
 * These mutate the team's shared-folder tree and doc index through the SAME
 * renderer functions a person uses (createSharedFolder, moveSharedDocument,
 * registerDocumentInIndex, …). The TeamSyncProvider that owns that state lives
 * in the renderer, so — exactly like readCollabDoc — each tool round-trips to a
 * window over a unique resultChannel and the renderer replies once.
 */

// How long we wait for the renderer to complete a shared-index mutation before
// giving up. Folder/doc registration hits the TeamSyncProvider (a WebSocket
// send), so allow a little slack over an in-memory operation.
const ROUND_TRIP_TIMEOUT_MS = 15000;

export function getCollabIndexToolSchemas() {
  const tools: Array<{ name: string; description: string; inputSchema: any }> = [
    {
      name: "createSharedDoc",
      description:
        "Create a new shared collaborative document in the team's shared index. Goes through the same path a person uses (registers the doc in the index, optionally filing it under a folder). Returns the new documentId. Use folderPath (e.g. 'Specs/Drafts') to place it in a folder by name — missing folders are created — or pass an explicit parentFolderId.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "The document title (leaf name; do NOT encode a folder path here — use folderPath).",
          },
          documentType: {
            type: "string",
            description: "Logical document type for editor routing. Defaults to 'markdown'.",
          },
          parentFolderId: {
            type: "string",
            description: "Id of the folder to create the doc in. Omit (or null) for the root. Ignored when folderPath is given.",
          },
          folderPath: {
            type: "string",
            description: "Human folder path (e.g. 'A/B') to file the doc under; intermediate folders are created as needed. Takes precedence over parentFolderId.",
          },
          initialContent: {
            type: "string",
            description: "Seed markdown content. Only applied when an editor for the document is already mounted; a freshly created doc is seeded when it is next opened.",
          },
        },
        required: ["title"],
      },
    },
    {
      name: "createSharedFolder",
      description:
        "Create a folder in the team's shared index (the same first-class folders a person creates in Collab mode). Returns the new folderId. Use folderPath to create nested folders by name (intermediate segments are created), or pass an explicit parentFolderId for the parent.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The folder name (leaf).",
          },
          parentFolderId: {
            type: "string",
            description: "Id of the parent folder. Omit (or null) for the root. Ignored when folderPath is given.",
          },
          folderPath: {
            type: "string",
            description: "Human folder path (e.g. 'A/B') identifying the PARENT to create the new folder under; intermediate folders are created as needed. Takes precedence over parentFolderId.",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "moveSharedItem",
      description:
        "Move a shared document or folder to a new parent folder in the shared index (null/omitted = move to root). Reparenting only — content and links are untouched. Provide the new parent via newParentFolderId or a human folderPath (created as needed).",
      inputSchema: {
        type: "object",
        properties: {
          itemId: {
            type: "string",
            description: "The documentId (kind='doc') or folderId (kind='folder') to move.",
          },
          kind: {
            type: "string",
            enum: ["doc", "folder"],
            description: "Whether itemId refers to a document or a folder.",
          },
          newParentFolderId: {
            type: "string",
            description: "Id of the destination folder. Omit (or null) to move to the root. Ignored when folderPath is given.",
          },
          folderPath: {
            type: "string",
            description: "Human folder path (e.g. 'A/B') for the destination; intermediate folders are created as needed. Takes precedence over newParentFolderId.",
          },
        },
        required: ["itemId", "kind"],
      },
    },
    {
      name: "renameSharedItem",
      description:
        "Rename a shared document or folder in place. For a doc this updates its title; for a folder it renames the folder node.",
      inputSchema: {
        type: "object",
        properties: {
          itemId: {
            type: "string",
            description: "The documentId (kind='doc') or folderId (kind='folder') to rename.",
          },
          kind: {
            type: "string",
            enum: ["doc", "folder"],
            description: "Whether itemId refers to a document or a folder.",
          },
          newName: {
            type: "string",
            description: "The new title/name (leaf; do NOT encode a folder path).",
          },
        },
        required: ["itemId", "kind", "newName"],
      },
    },
    {
      name: "deleteSharedItem",
      description:
        "Delete a shared document, or a folder and its entire subtree, from the shared index. Deleting a folder recursively removes its descendant folders and documents. Returns the number of removed folders when deleting a folder.",
      inputSchema: {
        type: "object",
        properties: {
          itemId: {
            type: "string",
            description: "The documentId (kind='doc') or folderId (kind='folder') to delete.",
          },
          kind: {
            type: "string",
            enum: ["doc", "folder"],
            description: "Whether itemId refers to a document or a folder.",
          },
        },
        required: ["itemId", "kind"],
      },
    },
  ];

  return tools;
}

/**
 * Resolve the renderer window that owns the shared index for this call. Prefers
 * the session's workspace window; falls back to the most recently focused
 * workspace window (shared-index mutations act on the window's ACTIVE
 * workspace, mirroring what the person sees).
 */
async function resolveTargetWindow(
  workspacePath: string | undefined
): Promise<BrowserWindow | null> {
  if (workspacePath) {
    const windowId = await findWindowIdForWorkspacePath(workspacePath);
    if (windowId) {
      const win = BrowserWindow.fromId(windowId);
      if (win && !win.isDestroyed()) {
        return win;
      }
    }
  }
  const focused = getMostRecentlyFocusedWorkspaceWindow();
  return focused && !focused.isDestroyed() ? focused : null;
}

/**
 * Send `payload` to `channel` on the target window and wait for the renderer's
 * one-shot reply on a unique resultChannel. Mirrors handleReadCollabDoc.
 */
function roundTripToRenderer(
  window: BrowserWindow,
  channel: string,
  payload: Record<string, unknown>
): Promise<{ success: boolean; error?: string; [key: string]: unknown }> {
  const resultChannel = `mcp-result-${Date.now()}-${Math.random()}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ipcMain.removeAllListeners(resultChannel);
      resolve({ success: false, error: "Timed out while waiting for the renderer to update the shared index." });
    }, ROUND_TRIP_TIMEOUT_MS);

    ipcMain.once(resultChannel, (_event, result: { success: boolean; error?: string; [key: string]: unknown }) => {
      clearTimeout(timeout);
      resolve(result ?? { success: false, error: "No result returned from renderer." });
    });

    window.webContents.send(channel, { ...payload, resultChannel });
  });
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function textResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: false };
}

export async function handleCreateSharedDoc(
  args: any,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  const title = typeof args?.title === "string" ? args.title.trim() : "";
  if (!title) {
    return errorResult("Error: createSharedDoc requires a non-empty title.");
  }

  const window = await resolveTargetWindow(workspacePath);
  if (!window) {
    return errorResult("Error: No open workspace window available to create the shared document.");
  }

  const result = await roundTripToRenderer(window, "mcp:createSharedDoc", {
    title,
    documentType: typeof args?.documentType === "string" ? args.documentType : undefined,
    parentFolderId: args?.parentFolderId ?? null,
    folderPath: typeof args?.folderPath === "string" ? args.folderPath : undefined,
    initialContent: typeof args?.initialContent === "string" ? args.initialContent : undefined,
  });

  if (!result.success) {
    return errorResult(`Failed to create shared document: ${result.error || "Unknown error"}`);
  }
  return textResult(`Created shared document "${title}" (documentId: ${result.documentId}).`);
}

export async function handleCreateSharedFolder(
  args: any,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  const name = typeof args?.name === "string" ? args.name.trim() : "";
  if (!name) {
    return errorResult("Error: createSharedFolder requires a non-empty name.");
  }

  const window = await resolveTargetWindow(workspacePath);
  if (!window) {
    return errorResult("Error: No open workspace window available to create the shared folder.");
  }

  const result = await roundTripToRenderer(window, "mcp:createSharedFolder", {
    name,
    parentFolderId: args?.parentFolderId ?? null,
    folderPath: typeof args?.folderPath === "string" ? args.folderPath : undefined,
  });

  if (!result.success) {
    return errorResult(`Failed to create shared folder: ${result.error || "Unknown error"}`);
  }
  return textResult(`Created shared folder "${name}" (folderId: ${result.folderId}).`);
}

export async function handleMoveSharedItem(
  args: any,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  const itemId = typeof args?.itemId === "string" ? args.itemId : "";
  const kind = args?.kind;
  if (!itemId) {
    return errorResult("Error: moveSharedItem requires an itemId.");
  }
  if (kind !== "doc" && kind !== "folder") {
    return errorResult("Error: moveSharedItem requires kind to be 'doc' or 'folder'.");
  }

  const window = await resolveTargetWindow(workspacePath);
  if (!window) {
    return errorResult("Error: No open workspace window available to move the shared item.");
  }

  const result = await roundTripToRenderer(window, "mcp:moveSharedItem", {
    itemId,
    kind,
    newParentFolderId: args?.newParentFolderId ?? null,
    folderPath: typeof args?.folderPath === "string" ? args.folderPath : undefined,
  });

  if (!result.success) {
    return errorResult(`Failed to move shared ${kind}: ${result.error || "Unknown error"}`);
  }
  return textResult(`Moved shared ${kind} ${itemId}.`);
}

export async function handleRenameSharedItem(
  args: any,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  const itemId = typeof args?.itemId === "string" ? args.itemId : "";
  const kind = args?.kind;
  const newName = typeof args?.newName === "string" ? args.newName.trim() : "";
  if (!itemId) {
    return errorResult("Error: renameSharedItem requires an itemId.");
  }
  if (kind !== "doc" && kind !== "folder") {
    return errorResult("Error: renameSharedItem requires kind to be 'doc' or 'folder'.");
  }
  if (!newName) {
    return errorResult("Error: renameSharedItem requires a non-empty newName.");
  }

  const window = await resolveTargetWindow(workspacePath);
  if (!window) {
    return errorResult("Error: No open workspace window available to rename the shared item.");
  }

  const result = await roundTripToRenderer(window, "mcp:renameSharedItem", {
    itemId,
    kind,
    newName,
  });

  if (!result.success) {
    return errorResult(`Failed to rename shared ${kind}: ${result.error || "Unknown error"}`);
  }
  return textResult(`Renamed shared ${kind} ${itemId} to "${newName}".`);
}

export async function handleDeleteSharedItem(
  args: any,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  const itemId = typeof args?.itemId === "string" ? args.itemId : "";
  const kind = args?.kind;
  if (!itemId) {
    return errorResult("Error: deleteSharedItem requires an itemId.");
  }
  if (kind !== "doc" && kind !== "folder") {
    return errorResult("Error: deleteSharedItem requires kind to be 'doc' or 'folder'.");
  }

  const window = await resolveTargetWindow(workspacePath);
  if (!window) {
    return errorResult("Error: No open workspace window available to delete the shared item.");
  }

  const result = await roundTripToRenderer(window, "mcp:deleteSharedItem", {
    itemId,
    kind,
  });

  if (!result.success) {
    return errorResult(`Failed to delete shared ${kind}: ${result.error || "Unknown error"}`);
  }
  if (kind === "folder" && typeof result.removedCount === "number") {
    return textResult(`Deleted shared folder ${itemId} and its subtree (${result.removedCount} folder(s) removed).`);
  }
  return textResult(`Deleted shared ${kind} ${itemId}.`);
}
