import { app, BrowserWindow, ipcMain } from "electron";
import { isAbsolute } from "path";
import { existsSync } from "fs";
import {
  AISessionsRepository,
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
        "Capture a screenshot of any editor view (all file types, including custom editors like Excalidraw, CSV, and mockups). Use to visually verify UI, diagrams, or editor content.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description:
              "Absolute path of the file to capture (defaults to the active file)",
          },
          selector: {
            type: "string",
            description:
              "CSS selector for a specific element (defaults to the full editor area)",
          },
          theme: {
            type: "string",
            enum: ["dark", "light"],
            description:
              "Theme for the screenshot (defaults to the app's current theme)",
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
    {
      name: "readCollabDocComments",
      description:
        "Read inline comment threads from a collaborative document. Returns structured user/agent authorship, reply targets, resolved state, and anchor attachment state. This does not read the document body.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "The collab:// URI of the shared document.",
          },
          cursor: {
            type: "string",
            description: "Opaque pagination cursor returned by a previous call.",
          },
          limit: {
            type: "number",
            minimum: 1,
            maximum: 100,
            description: "Maximum number of threads to return (default 100).",
          },
          includeResolved: {
            type: "boolean",
            description: "Include resolved threads (default true).",
          },
        },
        required: ["filePath"],
      },
    },
    {
      name: "replyToCollabDocComment",
      description:
        "Reply to an existing inline comment thread under this agent session's identity. The app derives the session identity and human authorizer; callers cannot supply either. Use replyToCommentId to preserve which comment is being answered.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "The collab:// URI of the shared document.",
          },
          threadId: {
            type: "string",
            description: "Stable thread id from readCollabDocComments.",
          },
          replyToCommentId: {
            type: "string",
            description: "Optional comment id in the same thread being answered.",
          },
          body: {
            type: "string",
            description: "Reply body, up to 32 KiB encoded.",
          },
          clientMutationId: {
            type: "string",
            description:
              "Stable caller-generated idempotency key. Reuse it when retrying the same mutation.",
          },
          mentionedUserIds: {
            type: "array",
            maxItems: 50,
            items: { type: "string" },
            description: "Explicit organization user ids mentioned in the reply.",
          },
        },
        required: ["filePath", "threadId", "body", "clientMutationId"],
      },
    },
    {
      name: "createCollabDocComment",
      description:
        "Create an inline comment under this agent session's identity, anchored by exact visible text plus optional prefix/suffix context. Ambiguous or stale anchors fail instead of guessing.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "The collab:// URI of the shared document.",
          },
          anchor: {
            type: "object",
            properties: {
              exact: {
                type: "string",
                description: "Exact selected text, up to 4 KiB encoded.",
              },
              prefix: {
                type: "string",
                description: "Optional immediately preceding context, up to 512 bytes.",
              },
              suffix: {
                type: "string",
                description: "Optional immediately following context, up to 512 bytes.",
              },
            },
            required: ["exact"],
          },
          body: {
            type: "string",
            description: "Comment body, up to 32 KiB encoded.",
          },
          clientMutationId: {
            type: "string",
            description:
              "Stable caller-generated idempotency key. Reuse it when retrying the same mutation.",
          },
          mentionedUserIds: {
            type: "array",
            maxItems: 50,
            items: { type: "string" },
            description: "Explicit organization user ids mentioned in the comment.",
          },
        },
        required: ["filePath", "anchor", "body", "clientMutationId"],
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

type CollabCommentOperation = "list" | "reply" | "createAnchored";

async function resolveAgentIdentity(
  sessionId: string | undefined,
  workspacePath: string | undefined,
): Promise<{ sessionId: string; sessionName: string }> {
  if (!sessionId) {
    throw new Error("SESSION_REQUIRED: Comment mutations require an active agent session.");
  }
  const session = await AISessionsRepository.get(sessionId);
  if (!session) {
    throw new Error("SESSION_NOT_FOUND: The active agent session no longer exists.");
  }
  if (workspacePath) {
    const sessionWorkspaces = new Set(
      [session.workspacePath, session.worktreePath, session.worktreeProjectPath].filter(
        (value): value is string => Boolean(value),
      ),
    );
    const workspaceMatches = [...sessionWorkspaces].some(
      (candidate) =>
        candidate === workspacePath ||
        isFileInWorkspaceOrWorktree(candidate, workspacePath) ||
        isFileInWorkspaceOrWorktree(workspacePath, candidate),
    );
    if (sessionWorkspaces.size > 0 && !workspaceMatches) {
      throw new Error(
        "WORKSPACE_MISMATCH: The agent session is not authorized by this workspace.",
      );
    }
  }
  return {
    sessionId: session.id,
    sessionName: session.title?.trim() || `Agent ${session.id.slice(0, 8)}`,
  };
}

async function handleCollabCommentOperation(
  operation: CollabCommentOperation,
  args: any,
  sessionId?: string,
  workspacePath?: string,
): Promise<McpToolResult> {
  const targetFilePath = args?.filePath;
  if (!isCollabUri(targetFilePath)) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: {
            code: "INVALID_COLLAB_URI",
            message: `A collab:// URI is required. Got: ${targetFilePath ?? "(missing)"}.`,
          },
        }),
      }],
      isError: true,
    };
  }

  let targetWindow: BrowserWindow | null = null;
  try {
    targetWindow = await findWindowForFilePath(targetFilePath);
  } catch {
    // A closed collab:// document has no mounted document-state entry. Fall
    // through to the workspace window so renderer can use the headless path.
  }
  if (!targetWindow && workspacePath) {
    const workspaceWindowId =
      await findWindowIdForWorkspacePath(workspacePath);
    targetWindow = workspaceWindowId === null
      ? null
      : BrowserWindow.fromId(workspaceWindowId);
  }
  if (!targetWindow) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: {
            code: "DOCUMENT_NOT_MOUNTED",
            message: `No mounted collaborative editor is available for ${targetFilePath}. Open the document and retry.`,
          },
        }),
      }],
      isError: true,
    };
  }

  let agent: { sessionId: string; sessionName: string } | undefined;
  if (operation !== "list") {
    try {
      agent = await resolveAgentIdentity(sessionId, workspacePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const separator = message.indexOf(":");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: {
              code: separator > 0 ? message.slice(0, separator) : "SESSION_REQUIRED",
              message: separator > 0 ? message.slice(separator + 1).trim() : message,
            },
          }),
        }],
        isError: true,
      };
    }
  }

  const resultChannel = `mcp-result-${Date.now()}-${Math.random()}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ipcMain.removeAllListeners(resultChannel);
      resolve({
        content: [{
          type: "text",
          text: JSON.stringify({
            error: {
              code: "SYNC_TIMEOUT",
              message: "Timed out while waiting for the collaborative comment operation.",
            },
          }),
        }],
        isError: true,
      });
    }, 20000);

    ipcMain.once(resultChannel, (_event, result: {
      success: boolean;
      result?: unknown;
      code?: string;
      error?: string;
    }) => {
      clearTimeout(timeout);
      resolve({
        content: [{
          type: "text",
          text: JSON.stringify(
            result?.success
              ? result.result
              : {
                  error: {
                    code: result?.code || "COMMENT_OPERATION_FAILED",
                    message: result?.error || "Unknown collaborative comment error.",
                  },
                },
            null,
            2,
          ),
        }],
        isError: !result?.success,
      });
    });

    const channel = operation === "list"
      ? "mcp:readCollabDocComments"
      : operation === "reply"
        ? "mcp:replyToCollabDocComment"
        : "mcp:createCollabDocComment";
    targetWindow.webContents.send(channel, {
      targetFilePath,
      input: args,
      agent,
      workspacePath,
      resultChannel,
    });
  });
}

export function handleReadCollabDocComments(
  args: any,
  workspacePath?: string,
): Promise<McpToolResult> {
  return handleCollabCommentOperation("list", args, undefined, workspacePath);
}

export function handleReplyToCollabDocComment(
  args: any,
  sessionId?: string,
  workspacePath?: string,
): Promise<McpToolResult> {
  return handleCollabCommentOperation(
    "reply",
    args,
    sessionId,
    workspacePath,
  );
}

export function handleCreateCollabDocComment(
  args: any,
  sessionId?: string,
  workspacePath?: string,
): Promise<McpToolResult> {
  return handleCollabCommentOperation(
    "createAnchored",
    args,
    sessionId,
    workspacePath,
  );
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
