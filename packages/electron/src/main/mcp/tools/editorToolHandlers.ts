import { app, BrowserWindow, ipcMain } from "electron";
import { isAbsolute } from "path";
import { existsSync } from "fs";
import {
  SessionFilesRepository,
} from "@nimbalyst/runtime";
import { findWindowForFilePath, findWindowIdForWorkspacePath, workspaceToWindowMap, documentStateBySession } from "../mcpWorkspaceResolver";
import { compressImageIfNeeded } from "../mcpImageCompression";
import { isFileInWorkspaceOrWorktree } from "../../utils/workspaceDetection";

type McpToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError: boolean;
};

const COLLAB_URI_PREFIX = "collab://";

function isCollabUri(path: string | undefined): path is string {
  return !!path && path.startsWith(COLLAB_URI_PREFIX);
}

export function getEditorToolSchemas(sessionId: string | undefined) {
  const tools: Array<{ name: string; description: string; inputSchema: any }> = [
    {
      name: "capture_editor_screenshot",
      description:
        "Capture a screenshot of any editor view. Works with all file types including custom editors (Excalidraw, CSV, mockups), markdown, code, etc. Use this to visually verify UI, diagrams, or any editor content.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description:
              "The absolute path to the file being edited (optional, uses active file if not specified)",
          },
          selector: {
            type: "string",
            description:
              "CSS selector to capture a specific element (optional, captures full editor area if not specified)",
          },
          theme: {
            type: "string",
            enum: ["dark", "light"],
            description:
              "Theme to use for the screenshot (optional, uses the app's current theme if not specified). Useful for capturing both dark and light mode versions.",
          },
        },
      },
    },
    {
      name: "readCollabDoc",
      description:
        "Read the current contents of a shared collaborative document (collab:// URI). Use this whenever you need to see the document text — the filesystem Read tool does NOT work for collab:// URIs because the document lives in Yjs, not on disk. Returns the live Lexical/Yjs content the user is currently looking at.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "The collab:// URI of the shared document to read (e.g. 'collab://org:abc:doc:xyz').",
          },
        },
        required: ["filePath"],
      },
    },
    {
      name: "applyCollabDocEdit",
      description:
        "Apply text replacements to a collaborative shared document (collab:// URI). Use this when the active document is a shared/collaborative document — filesystem Edit/Write will NOT propagate via Yjs and will not reach other collaborators. Replacements are applied through the live Lexical/Yjs editor so other connected users see the change in realtime. Call readCollabDoc first to see the current content before editing.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "The collab:// URI of the shared document to modify (e.g. 'collab://org:abc:doc:xyz').",
          },
          replacements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                oldText: {
                  type: "string",
                  description:
                    "Text to replace (must match the document content exactly).",
                },
                newText: {
                  type: "string",
                  description: "Replacement text.",
                },
              },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["filePath", "replacements"],
      },
    },
  ];

  // The editor `open_workspace` tool is retired (MCP consolidation): the
  // collision with the settings `workspace_open` was resolved in favor of
  // `workspace_open` (on `nimbalyst-host`), which routes through
  // SettingsControlService (allow-list / audit). See mcpTopology.

  if (sessionId) {
    tools.push({
      name: "get_session_edited_files",
      description:
        "Get the list of files that were edited during this AI session. Use this when you need to know which files have been modified as part of the current session, for example when preparing a git commit. Returns file paths relative to the workspace.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    });
  }

  return tools;
}

export async function handleApplyDiff(args: any): Promise<McpToolResult> {
  const typedArgs = args as
    | { filePath?: string; replacements?: any[] }
    | undefined;
  const targetFilePath = typedArgs?.filePath;

  if (!targetFilePath) {
    return {
      content: [{ type: "text", text: "Error: filePath is required for applyDiff" }],
      isError: true,
    };
  }

  const targetWindow = await findWindowForFilePath(targetFilePath);
  if (targetWindow) {
    // applyDiff supports markdown files on disk (.md) and collaborative
    // shared documents addressed by collab:// URIs (which are always markdown
    // and live in Yjs, not on disk).
    if (!targetFilePath.endsWith(".md") && !isCollabUri(targetFilePath)) {
      return {
        content: [
          {
            type: "text",
            text: `Error: applyDiff can only modify markdown files (.md) or collaborative documents (collab:// URIs). Attempted to modify: ${targetFilePath}`,
          },
        ],
        isError: true,
      };
    }

    const resultChannel = `mcp-result-${Date.now()}-${Math.random()}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ipcMain.removeHandler(resultChannel);
        resolve({
          content: [{ type: "text", text: "Timed out while waiting for diff to apply. The operation may still be in progress." }],
          isError: true,
        });
      }, 30000);

      ipcMain.once(resultChannel, (event, result) => {
        clearTimeout(timeout);
        const success = result?.success ?? false;
        const error = result?.error;
        resolve({
          content: [
            {
              type: "text",
              text: success
                ? `Successfully applied diff to ${targetFilePath}`
                : `Failed to apply diff: ${error || "Unknown error"}`,
            },
          ],
          isError: !success,
        });
      });

      targetWindow.webContents.send("mcp:applyDiff", {
        replacements: typedArgs?.replacements,
        resultChannel,
        targetFilePath,
      });
    });
  }
  return {
    content: [{ type: "text", text: "Error: No window available for target file" }],
    isError: true,
  };
}

/**
 * readCollabDoc — return the current text of a shared collaborative document
 * by asking the renderer to pull it directly out of the live Lexical/Yjs
 * editor. Filesystem Read does not work for collab:// URIs.
 */
export async function handleReadCollabDoc(args: any): Promise<McpToolResult> {
  const targetFilePath = args?.filePath;
  if (!isCollabUri(targetFilePath)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: readCollabDoc requires a collab:// URI. Got: ${targetFilePath ?? "(missing)"}.`,
        },
      ],
      isError: true,
    };
  }

  const targetWindow = await findWindowForFilePath(targetFilePath);
  if (!targetWindow) {
    return {
      content: [{ type: "text", text: `Error: No window available for ${targetFilePath}` }],
      isError: true,
    };
  }

  const resultChannel = `mcp-result-${Date.now()}-${Math.random()}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ipcMain.removeAllListeners(resultChannel);
      resolve({
        content: [{ type: "text", text: "Timed out while reading collab document." }],
        isError: true,
      });
    }, 10000);

    ipcMain.once(resultChannel, (_event, result: { success: boolean; content?: string; error?: string }) => {
      clearTimeout(timeout);
      if (!result?.success) {
        resolve({
          content: [{ type: "text", text: `Failed to read collab doc: ${result?.error || "Unknown error"}` }],
          isError: true,
        });
        return;
      }
      resolve({
        content: [{ type: "text", text: result.content ?? "" }],
        isError: false,
      });
    });

    targetWindow.webContents.send("mcp:readCollabDoc", {
      targetFilePath,
      resultChannel,
    });
  });
}

/**
 * applyCollabDocEdit — collab-only alias for applyDiff.
 *
 * Validates that the target is a collab:// URI and then delegates to the
 * shared applyDiff handler. Exposed as a distinct MCP tool so transcripts
 * make it clear when the agent is editing the live shared document, and so
 * the system preamble can call out a single canonical name.
 */
export async function handleApplyCollabDocEdit(args: any): Promise<McpToolResult> {
  const targetFilePath = args?.filePath;
  if (!isCollabUri(targetFilePath)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: applyCollabDocEdit requires a collab:// URI. Got: ${targetFilePath ?? "(missing)"}. For filesystem files, use Edit instead.`,
        },
      ],
      isError: true,
    };
  }
  return handleApplyDiff(args);
}

export async function handleStreamContent(args: any): Promise<McpToolResult> {
  const typedArgs = args as
    | { filePath?: string; content?: string; position?: string; insertAfter?: string }
    | undefined;
  const targetFilePath = typedArgs?.filePath;

  if (!targetFilePath) {
    return {
      content: [{ type: "text", text: "Error: filePath is required for streamContent" }],
      isError: true,
    };
  }

  const targetWindow = await findWindowForFilePath(targetFilePath);
  if (targetWindow) {
    const streamId = `mcp-stream-${Date.now()}-${Math.random()}`;
    const resultChannel = `mcp-result-${Date.now()}-${Math.random()}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ipcMain.removeHandler(resultChannel);
        resolve({
          content: [{ type: "text", text: "Timed out while waiting for content to stream. The operation may still be in progress." }],
          isError: true,
        });
      }, 30000);

      ipcMain.once(resultChannel, (event, result) => {
        clearTimeout(timeout);
        const success = result?.success ?? false;
        const error = result?.error;
        resolve({
          content: [
            {
              type: "text",
              text: success
                ? `Successfully streamed content to ${targetFilePath}`
                : `Failed to stream content: ${error || "Unknown error"}`,
            },
          ],
          isError: !success,
        });
      });

      targetWindow.webContents.send("mcp:streamContent", {
        streamId,
        content: typedArgs?.content,
        position: typedArgs?.position || "end",
        insertAfter: typedArgs?.insertAfter,
        targetFilePath,
        resultChannel,
      });
    });
  }
  return {
    content: [{ type: "text", text: "Error: No window available for target file" }],
    isError: true,
  };
}

export async function handleCaptureEditorScreenshot(
  args: any,
): Promise<McpToolResult> {
  const filePath = args?.file_path as string | undefined;
  const selector = args?.selector as string | undefined;
  const theme = args?.theme as string | undefined;

  if (!filePath) {
    return {
      content: [{ type: "text", text: "Error: file_path is required for capture_editor_screenshot" }],
      isError: true,
    };
  }

  try {
    // Find which workspace contains this file path
    let fileWorkspacePath: string | undefined;

    for (const wsPath of workspaceToWindowMap.keys()) {
      if (isFileInWorkspaceOrWorktree(filePath, wsPath)) {
        if (!fileWorkspacePath || wsPath.length > fileWorkspacePath.length) {
          fileWorkspacePath = wsPath;
        }
      }
    }

    // Fallback: Check all session workspaces
    if (!fileWorkspacePath) {
      for (const state of documentStateBySession.values()) {
        const wsPath = state.workspacePath;
        if (wsPath && isFileInWorkspaceOrWorktree(filePath, wsPath)) {
          if (!fileWorkspacePath || wsPath.length > fileWorkspacePath.length) {
            fileWorkspacePath = wsPath;
          }
        }
      }
    }

    if (!fileWorkspacePath) {
      const registeredWorkspaces = Array.from(workspaceToWindowMap.keys());
      const sessionWorkspaces = Array.from(documentStateBySession.values())
        .map((s) => s.workspacePath)
        .filter(Boolean);
      const allWorkspaces = [
        ...new Set([...registeredWorkspaces, ...sessionWorkspaces]),
      ];
      const availableWorkspaces = allWorkspaces.join(", ") || "none";
      return {
        content: [
          {
            type: "text",
            text: `Error: File "${filePath}" does not belong to any open workspace. Available workspaces: ${availableWorkspaces}`,
          },
        ],
        isError: true,
      };
    }

    // Use offscreen editor system for screenshot
    const { OffscreenEditorManager } = await import(
      "../../services/OffscreenEditorManager"
    );
    const manager = OffscreenEditorManager.getInstance();

    const imageBuffer = await manager.captureScreenshot(
      filePath,
      fileWorkspacePath,
      selector,
      theme
    );
    const imageBase64 = imageBuffer.toString("base64");

    // Validate that we actually got image data
    if (!imageBase64 || imageBase64.length === 0) {
      console.error(
        "[MCP Server] Editor screenshot returned empty base64 data"
      );
      return {
        content: [
          {
            type: "text",
            text: "Error: Screenshot capture returned empty image data. The editor element may not have rendered properly or the capture failed silently.",
          },
        ],
        isError: true,
      };
    }

    // Compress image if needed
    const compressed = compressImageIfNeeded(imageBase64, "image/png");

    return {
      content: [
        {
          type: "image",
          data: compressed.data,
          mimeType: compressed.mimeType,
        },
      ],
      isError: false,
    };
  } catch (error) {
    console.error("[MCP Server] Failed to capture editor screenshot:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [{ type: "text", text: `Error capturing editor screenshot: ${errorMessage}` }],
      isError: true,
    };
  }
}

export async function handleGetSessionEditedFiles(
  sessionId: string | undefined
): Promise<McpToolResult> {
  if (!sessionId) {
    return {
      content: [
        {
          type: "text",
          text: "Error: No session ID available. This tool is only available during an active AI session.",
        },
      ],
      isError: true,
    };
  }

  try {
    const files = await SessionFilesRepository.getFilesBySession(
      sessionId,
      "edited"
    );
    const filePaths = files.map((f) => f.filePath);

    if (filePaths.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No files have been edited in this session yet.",
          },
        ],
        isError: false,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Files edited in this session (${
            filePaths.length
          }):\n${filePaths.map((p) => `- ${p}`).join("\n")}`,
        },
      ],
      isError: false,
    };
  } catch (error) {
    console.error("[MCP Server] Failed to get session edited files:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error getting session files: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
      isError: true,
    };
  }
}
