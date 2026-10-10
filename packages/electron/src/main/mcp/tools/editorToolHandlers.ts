import { app, BrowserWindow } from "electron";
import { isAbsolute } from "path";
import { existsSync } from "fs";
import {
  AISessionsRepository,
  SessionFilesRepository,
} from "@nimbalyst/runtime";
import { findWindowForFilePath, findWindowIdForWorkspacePath, workspaceToWindowMap, documentStateBySession } from "../mcpWorkspaceResolver";
import { compressImageIfNeeded } from "../mcpImageCompression";
import { requestFromRenderer } from "../rendererRequest";
import { isFileInWorkspaceOrWorktree } from "../../utils/workspaceDetection";
import {
  describeTypedPage,
  isAgentPageUri,
  pageUpdatedText,
  personalTypedPageError,
  typedPageItemId,
} from "./agentPageTargets";
import { teamPageLocalLinkWarning } from "./teamPageLocalLinks";
import { PAGE_TOOL_DESKTOP_PROJECT_ARG } from "@nimbalyst/collab-protocol";
import { routePageRead } from "./pageProjectReads";

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
        "Read the current contents of a shared collaborative document (collab:// URI). Use this whenever you need to see the document text — the filesystem Read tool does NOT work for collab:// URIs because the document lives in Yjs, not on disk. Works whether or not the document is open in a tab; the content comes from the shared document itself, so it reflects what every collaborator currently has. Also reads Personal pages: personal://<documentId>, and a Personal typed page's body at personal://tracker-content/<itemId>.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "The collab:// URI of the shared document to read (e.g. 'collab://org:abc:doc:xyz'), or a personal:// Personal page URI.",
          },
          includeDecisionState: {
            type: "boolean",
            description: "Include a bounded read-only snapshot of current human answers and separate agent recommendations for extant decision blocks. Supplemental state is not editable document source; default false.",
          },
          project: PAGE_TOOL_DESKTOP_PROJECT_ARG,
        },
        required: ["filePath"],
      },
    },
    {
      name: "applyCollabDocEdit",
      description:
        "Apply text replacements to a collaborative shared document (collab:// URI). Use this when the target is a shared/collaborative document — filesystem Edit/Write will NOT propagate via Yjs and will not reach other collaborators. Works whether or not the document is open in a tab, and other connected users see the change in realtime. Also edits Personal pages: personal://<documentId>, and a Personal typed page's body at personal://tracker-content/<itemId>. Call readCollabDoc first to see the current content before editing.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "The collab:// URI of the shared document to modify (e.g. 'collab://org:abc:doc:xyz'), or a personal:// Personal page URI.",
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
        "Read inline comment threads from a collaborative document. Returns structured user/agent authorship, reply targets, resolved state, and each thread's structured anchor plus its attachment state, whether or not the document is open. This does not read the document body.",
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
        "Create an inline comment under this agent session's identity. Text-quote anchors require a mounted Markdown editor; entity anchors require a mounted adapter or headless codec to confirm the target. Missing, stale, ambiguous, or rejected anchors fail instead of guessing.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "The collab:// URI of the shared document.",
          },
          anchor: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kind: {
                    type: "string",
                    enum: ["text-quote"],
                    description:
                      "Optional for compatibility; text-quote is inferred when omitted.",
                  },
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
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["entity"] },
                  entityType: {
                    type: "string",
                    description: "Stable entity type, up to 512 encoded bytes.",
                  },
                  entityId: {
                    type: "string",
                    description: "Stable entity id, up to 512 encoded bytes.",
                  },
                  field: {
                    type: "string",
                    description: "Optional stable entity field, up to 512 encoded bytes.",
                  },
                  labelSnapshot: {
                    type: "string",
                    description: "Optional presentation fallback, up to 4 KiB encoded.",
                  },
                },
                required: ["kind", "entityType", "entityId"],
              },
            ],
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

export async function handleApplyDiff(
  args: any,
  sessionId?: string,
  workspacePath?: string,
): Promise<McpToolResult> {
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

  const personalError = await personalTypedPageError(targetFilePath, workspacePath);
  if (personalError) {
    return { content: [{ type: "text", text: personalError }], isError: true };
  }

  // A page is addressable whether or not it is on screen; a file on disk still
  // has to be resolved through the window that owns it.
  const isPage = isAgentPageUri(targetFilePath);
  const targetWindow = isPage
    ? await resolveCollabDocWindow(targetFilePath, workspacePath)
    : await findWindowForFilePath(targetFilePath);
  if (targetWindow) {
    // applyDiff supports markdown files on disk (.md), collaborative shared
    // documents (collab://) and Personal pages (personal://).
    if (!targetFilePath.endsWith(".md") && !isPage) {
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

    // Presence is a courtesy to other collaborators, not a precondition for
    // the edit, so an unresolvable session identity must not fail the write.
    let agent: { sessionId: string; sessionName: string } | undefined;
    if (isCollabUri(targetFilePath) && sessionId) {
      try {
        agent = await resolveAgentIdentity(sessionId, workspacePath);
      } catch {
        agent = undefined;
      }
    }

    const outcome = await requestFromRenderer<{ success?: boolean; error?: string; title?: string }>(
      targetWindow,
      "mcp:applyDiff",
      {
        replacements: typedArgs?.replacements,
        targetFilePath,
        workspacePath,
        ...(agent ? { agent } : {}),
      },
      { timeoutMs: 30000 },
    );
    if (outcome.status === "timedOut") {
      return {
        content: [{ type: "text", text: "Timed out while waiting for diff to apply. The operation may still be in progress." }],
        isError: true,
      };
    }

    const success = outcome.response?.success ?? false;
    let successText = `Successfully applied diff to ${targetFilePath}`;
    if (success && isPage) {
      // The transcript's "Updated <page>" line reads the title from this text.
      const typedItemId = typedPageItemId(targetFilePath);
      const title = outcome.response?.title
        ?? (typedItemId ? (await describeTypedPage(typedItemId, workspacePath).catch(() => null))?.title : undefined);
      successText = pageUpdatedText(targetFilePath, title);
      const warning = teamPageLocalLinkWarning(targetFilePath, (typedArgs?.replacements ?? []).map((r: { newText?: unknown }) => r?.newText));
      if (warning) successText += `\n\n${warning}`;
    }
    return {
      content: [
        {
          type: "text",
          text: success
            ? successText
            : `Failed to apply diff: ${outcome.response?.error || "Unknown error"}`,
        },
      ],
      isError: !success,
    };
  }
  return {
    content: [{ type: "text", text: "Error: No window available for target file" }],
    isError: true,
  };
}

/**
 * Resolve the window that should service a collab:// request.
 *
 * `findWindowForFilePath` matches on a session's ACTIVE document, so it finds
 * nothing (and throws) for a document that is merely closed — or open but not
 * active. That is not a reason to refuse the request: any window on the right
 * workspace can reach the room headlessly (NIM-3754).
 */
async function resolveCollabDocWindow(
  targetFilePath: string,
  workspacePath: string | undefined,
): Promise<BrowserWindow | null> {
  try {
    const mounted = await findWindowForFilePath(targetFilePath);
    if (mounted) return mounted;
  } catch {
    // Fall through to the workspace window.
  }
  if (!workspacePath) return null;
  const workspaceWindowId = await findWindowIdForWorkspacePath(workspacePath);
  return workspaceWindowId === null ? null : BrowserWindow.fromId(workspaceWindowId);
}

/**
 * readCollabDoc — return the current text of a shared collaborative document.
 *
 * Served from the live editor when one is mounted, and from the room itself
 * otherwise. Filesystem Read does not work for collab:// URIs. A page in
 * another project of the team is read through the server when `project`
 * names it (`pageProjectReads.ts`), and so is one named by its link alone:
 * the renderer answers with the page's project and the read goes the same way.
 */
export async function handleReadCollabDoc(
  args: any,
  workspacePath?: string,
): Promise<McpToolResult> {
  return routePageRead("readCollabDoc", args, workspacePath, async (localArgs) => {
    const { otherProjectId, ...local } = await readCollabDocLocally(localArgs, workspacePath);
    if (!otherProjectId) return local;
    return routePageRead("readCollabDoc", { ...localArgs, project: otherProjectId }, workspacePath, async () => local);
  });
}

/** `otherProjectId`: the renderer found the page in another project of the team. */
async function readCollabDocLocally(
  args: any,
  workspacePath?: string,
): Promise<McpToolResult & { otherProjectId?: string }> {
  const targetFilePath = args?.filePath;
  if (!isAgentPageUri(targetFilePath)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: readCollabDoc requires a collab:// or personal:// URI. Got: ${targetFilePath ?? "(missing)"}.`,
        },
      ],
      isError: true,
    };
  }

  const targetWindow = await resolveCollabDocWindow(targetFilePath, workspacePath);
  if (!targetWindow) {
    return {
      content: [{ type: "text", text: `Error: No window available for ${targetFilePath}` }],
      isError: true,
    };
  }

  const outcome = await requestFromRenderer<{
    success: boolean;
    content?: string;
    title?: string;
    documentType?: string;
    decisionState?: unknown;
    error?: string;
    code?: string;
    projectId?: string | null;
  }>(
    targetWindow,
    "mcp:readCollabDoc",
    { targetFilePath, workspacePath, ...(args?.includeDecisionState === true ? { includeDecisionState: true } : {}) },
    // Generous enough to cover a cold headless acquisition, whose own
    // hydration budget is 10s, without hanging the tool call indefinitely.
    { timeoutMs: 15000 },
  );
  if (outcome.status === "timedOut") {
    return {
      content: [{ type: "text", text: "Timed out while reading collab document." }],
      isError: true,
    };
  }
  if (!outcome.response?.success) {
    return {
      content: [{ type: "text", text: `Failed to read collab doc: ${outcome.response?.error || "Unknown error"}` }],
      isError: true,
      ...(outcome.response?.code === "OTHER_PROJECT" && outcome.response.projectId
        ? { otherProjectId: outcome.response.projectId }
        : {}),
    };
  }
  const { content, title, documentType } = outcome.response;
  if (typeof content !== "string") {
    return {
      content: [{ type: "text", text: `Failed to read collab doc: the editor returned no content for ${targetFilePath}.` }],
      isError: true,
    };
  }
  return {
    content: [
      { type: "text", text: content.trim() ? content : emptyPageStatus(targetFilePath, title, documentType) },
      ...(args?.includeDecisionState === true && outcome.response.decisionState !== undefined
        ? [{ type: "text", text: `Read-only decision state (supplemental; do not write into document source). Agent recommendations are not human votes or quorum.\n${JSON.stringify(outcome.response.decisionState)}` }]
        : []),
    ],
    isError: false,
  };
}

/**
 * An empty body read verbatim is an empty tool result, which the agent sees as
 * "no output" and cannot tell from a failed read. Every failed read is an
 * error above, so this text means the page was loaded and holds no text.
 */
function emptyPageStatus(uri: string, title?: string, documentType?: string): string {
  const name = title ? `"${title}" (${[uri, documentType].filter(Boolean).join(", ")})` : uri;
  const where = uri.startsWith("personal://") ? "is loaded" : "is loaded and in sync with the server";
  return `(empty page) ${name} ${where}, and its body has no text.`;
}

/**
 * applyCollabDocEdit — collab-only alias for applyDiff.
 *
 * Validates that the target is a collab:// URI and then delegates to the
 * shared applyDiff handler. Exposed as a distinct MCP tool so transcripts
 * make it clear when the agent is editing the live shared document, and so
 * the system preamble can call out a single canonical name.
 */
export async function handleApplyCollabDocEdit(
  args: any,
  sessionId?: string,
  workspacePath?: string,
): Promise<McpToolResult> {
  const targetFilePath = args?.filePath;
  if (!isAgentPageUri(targetFilePath)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: applyCollabDocEdit requires a collab:// or personal:// URI. Got: ${targetFilePath ?? "(missing)"}. For filesystem files, use Edit instead.`,
        },
      ],
      isError: true,
    };
  }
  return handleApplyDiff(args, sessionId, workspacePath);
}

type CollabCommentOperation = "list" | "reply" | "createAnchored";

function normalizeStructuredCommentAnchor(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const anchor = value as Record<string, unknown>;
  if (
    (anchor.kind === undefined || anchor.kind === "text-quote") &&
    typeof anchor.exact === "string"
  ) {
    return {
      kind: "text-quote",
      exact: anchor.exact,
      ...(typeof anchor.prefix === "string" ? { prefix: anchor.prefix } : {}),
      ...(typeof anchor.suffix === "string" ? { suffix: anchor.suffix } : {}),
    };
  }
  if (
    anchor.kind === "entity" &&
    typeof anchor.entityType === "string" &&
    typeof anchor.entityId === "string"
  ) {
    return {
      kind: "entity",
      entityType: anchor.entityType,
      entityId: anchor.entityId,
      ...(typeof anchor.field === "string" ? { field: anchor.field } : {}),
      ...(typeof anchor.labelSnapshot === "string"
        ? { labelSnapshot: anchor.labelSnapshot }
        : {}),
    };
  }
  // Future anchor kinds remain readable. The renderer marks them unsupported;
  // normalization only strips non-JSON values before returning the payload.
  try {
    return JSON.parse(JSON.stringify(anchor));
  } catch {
    return undefined;
  }
}

function normalizeCollabCommentToolResult(
  operation: CollabCommentOperation,
  result: unknown,
  inputAnchor: unknown,
): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  if (operation === "list" && Array.isArray(record.threads)) {
    return {
      ...record,
      threads: record.threads.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return value;
        }
        const thread = value as Record<string, unknown>;
        const anchor = normalizeStructuredCommentAnchor(thread.anchor);
        return {
          ...thread,
          ...(anchor === undefined ? {} : { anchor }),
        };
      }),
    };
  }
  // Reply and create both report the anchor the thread is actually stored
  // with, so an agent gets the same structured target from every operation.
  // `inputAnchor` only backstops a controller that returned none.
  const anchor = normalizeStructuredCommentAnchor(
    record.anchor ?? (operation === "createAnchored" ? inputAnchor : undefined),
  );
  return {
    ...record,
    ...(anchor === undefined ? {} : { anchor }),
  };
}

export async function resolveAgentIdentity(
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

  const targetWindow = await resolveCollabDocWindow(targetFilePath, workspacePath);
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

  const channel = operation === "list"
    ? "mcp:readCollabDocComments"
    : operation === "reply"
      ? "mcp:replyToCollabDocComment"
      : "mcp:createCollabDocComment";

  const outcome = await requestFromRenderer<{
    success: boolean;
    result?: unknown;
    code?: string;
    error?: string;
  }>(
    targetWindow,
    channel,
    { targetFilePath, input: args, agent, workspacePath },
    { timeoutMs: 20000 },
  );
  if (outcome.status === "timedOut") {
    return {
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
    };
  }

  const result = outcome.response;
  const normalizedResult = result?.success
    ? normalizeCollabCommentToolResult(operation, result.result, args?.anchor)
    : undefined;
  return {
    content: [{
      type: "text",
      text: JSON.stringify(
        result?.success
          ? normalizedResult
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
  };
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

    const outcome = await requestFromRenderer<{ success?: boolean; error?: string }>(
      targetWindow,
      "mcp:streamContent",
      {
        streamId,
        content: typedArgs?.content,
        position: typedArgs?.position || "end",
        insertAfter: typedArgs?.insertAfter,
        targetFilePath,
      },
      { timeoutMs: 30000 },
    );
    if (outcome.status === "timedOut") {
      return {
        content: [{ type: "text", text: "Timed out while waiting for content to stream. The operation may still be in progress." }],
        isError: true,
      };
    }

    const success = outcome.response?.success ?? false;
    return {
      content: [
        {
          type: "text",
          text: success
            ? `Successfully streamed content to ${targetFilePath}`
            : `Failed to stream content: ${outcome.response?.error || "Unknown error"}`,
        },
      ],
      isError: !success,
    };
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
