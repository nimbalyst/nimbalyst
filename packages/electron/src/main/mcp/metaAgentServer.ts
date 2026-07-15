/**
 * Meta-agent (child-session orchestration) tool surface — `create_session`,
 * `spawn_session`, `send_prompt`, `list_queued_prompts`, `respond_to_prompt`,
 * `get_session_status`, `get_session_result`, `list_spawned_sessions`,
 * `list_worktrees`.
 *
 * MCP consolidation: these tools are served by the unified internal MCP HTTP
 * server's `/mcp/host` endpoint (`nimbalyst-host`). This module exports the tool
 * defs + an endpoint-agnostic dispatch fn (shared with the extension-agent
 * `toolExecutor` broker); the standalone HTTP server it used to run was retired
 * in Phase 7. `MetaAgentService` still injects the tool fns via
 * `setMetaAgentToolFns`.
 */

import { resolveProjectPath } from "../utils/workspaceDetection";

type CreateSessionArgs = {
  title?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  useWorktree?: boolean;
  worktreeId?: string;
  toolScope?: string;
};

type SpawnSessionArgs = {
  title?: string;
  prompt: string;
  useWorktree?: boolean;
  model?: string;
  notifyOnComplete?: boolean;
  /**
   * When true, the new session is created at the top level — no parent,
   * no workstream container, no shared files-edited or tabs with the
   * caller. Use for fix-and-commit-separately work that should not pollute
   * the caller's workstream. When false (the default), the new session is
   * spawned as a sibling under the caller's workstream.
   */
  isolated?: boolean;
};

type RespondToPromptArgs = {
  sessionId: string;
  promptId: string;
  promptType:
    | "permission_request"
    | "ask_user_question_request"
    | "exit_plan_mode_request";
  response: Record<string, unknown>;
};

type GetSessionResultArgs = {
  sessionId: string;
  /**
   * Include the full last-agent-turn text (capped at 50,000 chars). Defaults
   * to true for backward compatibility. Pass false for a compact response
   * (status/prompts/recentMessages/editedFiles only) when the caller doesn't
   * need the full turn text -- e.g. a supervising session polling many
   * children, where the full text would otherwise be reinjected into its
   * context on every poll.
   */
  includeFullResponse?: boolean;
};

type ListQueuedPromptsArgs = {
  sessionId: string;
  /**
   * Include completed and failed queue rows in addition to pending/executing
   * rows. Defaults to false so the default view answers "what is still stuck?"
   */
  includeCompleted?: boolean;
  /**
   * Include full prompt text. Defaults to false; the response always includes a
   * bounded preview so callers can identify rows without dumping huge prompts.
   */
  includePromptText?: boolean;
};

interface MetaAgentToolFns {
  listWorktrees: (
    metaSessionId: string,
    workspaceId: string
  ) => Promise<string>;
  createSession: (
    metaSessionId: string,
    workspaceId: string,
    args: CreateSessionArgs
  ) => Promise<string>;
  spawnSession: (
    callerSessionId: string,
    workspaceId: string,
    args: SpawnSessionArgs
  ) => Promise<string>;
  getSessionStatus: (
    metaSessionId: string,
    workspaceId: string,
    targetSessionId: string
  ) => Promise<string>;
  getSessionResult: (
    metaSessionId: string,
    workspaceId: string,
    targetSessionId: string,
    options?: Pick<GetSessionResultArgs, "includeFullResponse">
  ) => Promise<string>;
  listQueuedPrompts: (
    metaSessionId: string,
    workspaceId: string,
    targetSessionId: string,
    options?: Pick<ListQueuedPromptsArgs, "includeCompleted" | "includePromptText">
  ) => Promise<string>;
  sendPrompt: (
    metaSessionId: string,
    workspaceId: string,
    targetSessionId: string,
    prompt: string
  ) => Promise<string>;
  respondToPrompt: (
    metaSessionId: string,
    workspaceId: string,
    args: RespondToPromptArgs
  ) => Promise<string>;
  listSpawnedSessions: (
    metaSessionId: string,
    workspaceId: string
  ) => Promise<string>;
}

let toolFns: MetaAgentToolFns | null = null;

export function setMetaAgentToolFns(fns: MetaAgentToolFns): void {
  toolFns = fns;
}

/**
 * OpenAI-shaped tool definition. Mirrors the chat-completions function-calling
 * format that extension-agent tool loops (e.g. the gemini-antigravity
 * ToolLoopProtocol) consume. Built-in providers ignore this — they discover the
 * same tools over the SSE MCP server instead.
 */
export interface MetaAgentOpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * The single source-of-truth list of meta-agent tools, in MCP
 * `{ name, description, inputSchema }` shape. Both the SSE MCP server's
 * ListTools handler (built-in providers) and `getMetaAgentOpenAITools`
 * (extension-agent providers) read from this so the two presentation paths
 * never drift.
 */
export const META_AGENT_TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}> = [
  {
    name: "list_worktrees",
    description:
      "List the available git worktrees for this workspace so you can attach a child session to an existing branch or decide whether to create a fresh worktree.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "create_session",
    description:
      "Spawn a new child session for a focused task. Can optionally create a dedicated worktree or attach the session to an existing worktree, then seed it with an initial prompt. Pass toolScope to control the child's capabilities: use \"read\" or \"write\" for analyze/research tasks so the child cannot run builds or claim to have run them; \"full\" (default) grants run_command.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Optional title for the child session.",
        },
        provider: {
          type: "string",
          description:
            "Optional. OMIT to inherit the calling session provider and model (recommended: a Gemini meta-agent then spawns Gemini children). Set this only to deliberately run the child on a different provider, and if you set it, also pass a matching model (e.g. provider claude-code with model claude-code:opus). Do NOT set claude-code with a non-claude-code model.",
        },
        model: {
          type: "string",
          description: "Optional explicit model identifier.",
        },
        prompt: {
          type: "string",
          description: "Optional initial prompt to queue for the child session immediately after creation.",
        },
        useWorktree: {
          type: "boolean",
          description:
            "Ignored. Child sessions always run in the SHARED workspace so you (the parent) can read the files they write and synthesize them. A fresh worktree would isolate the child's deliverable where you cannot reach it. Tell the child to save deliverables to the workspace root.",
        },
        worktreeId: {
          type: "string",
          description: "Ignored. Children run in the shared workspace (see useWorktree).",
        },
        toolScope: {
          type: "string",
          enum: ["read", "write", "full"],
          description:
            "Capability scope for the child. \"read\" = read_file/list_files/search_files only (pure investigation). \"write\" = those plus write_file but NO run_command, so the child can save a file deliverable (e.g. a report) yet cannot build/test/run anything. \"full\" (default) = all tools including run_command. Use read or write for analyze/research tasks so the child physically cannot run a build, and reserve full for tasks that must build/test.",
        },
      },
    },
  },
  {
    name: "spawn_session",
    description:
      "Spawn a new session from the calling session. By default the new session runs as a sibling under the same workstream as the caller (sharing files-edited, tabs, and get_workstream_overview); if the caller is not yet part of a workstream, a workstream container is created and the caller is reparented under it. The new session also inherits the caller's working directory: if the caller is running in a worktree, the spawned session runs in that same worktree (so its edits land where the user is looking). Pass isolated=true to instead create a top-level session with no parent and no workstream — use this when the new session should fix-and-commit work independently without polluting the caller's workstream. Pass useWorktree=true to give the spawned session its OWN new worktree instead of inheriting the caller's. Fire-and-forget by default — the calling session is not notified when the spawned session completes; pass notifyOnComplete=true to opt in. Use this for the /launch-new-session flow.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "REQUIRED. Self-contained handoff brief for the new session. Should describe the task, relevant file paths, decisions already made, and a pointer back to the current session id (the new session can call get_session_summary to read more).",
        },
        title: {
          type: "string",
          description: "Optional short title for the new session.",
        },
        isolated: {
          type: "boolean",
          description:
            "Default false. When true, the new session is created at the top level — no parent, no workstream container, no shared files-edited or tabs with the caller. Use for fix-and-commit-separately work that should not pollute the caller's workstream.",
        },
        useWorktree: {
          type: "boolean",
          description:
            "Default false. By default the spawned session inherits the caller's working directory: if the caller is in a worktree, the new session runs in that same worktree; if the caller is in the main checkout, the new session runs there too. Set true only when the user explicitly asks for the new session to get its OWN new worktree (separate branch and working directory) — this creates a fresh worktree rather than inheriting the caller's.",
        },
        model: {
          type: "string",
          description:
            "Optional explicit model identifier (e.g. 'claude-code:opus'). When omitted, the new session uses the global default model unless inheritModel=true. Wins over inheritModel when both are set.",
        },
        inheritModel: {
          type: "boolean",
          description:
            "Default false. When true and `model` is not set, the spawned session uses the caller's model so it stays on the same provider/model (e.g. opus stays on opus). Ignored when `model` is provided explicitly.",
        },
        notifyOnComplete: {
          type: "boolean",
          description:
            "Default false. When false (the default), the calling session receives no follow-up prompt when the spawned session completes/errors/waits — fire and forget. Set true only when the caller specifically wants to be told the result and continue working with it.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "get_session_status",
    description:
      "Get the current status of a child session including last activity time and whether it is waiting for input.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The session ID to inspect.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_session_result",
    description:
      "Get the current or final result of a session including prompts, recent responses, edited files, and pending interactive prompts.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The session ID to inspect.",
        },
        includeFullResponse: {
          type: "boolean",
          description:
            "Optional. Include the full last-agent-turn text (capped at 50,000 chars). Defaults to true. Set to false for a compact response when polling many sessions or when only status/prompts/editedFiles are needed.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "list_queued_prompts",
    description:
      "Inspect queued prompts for a session. By default returns only pending/executing rows with bounded prompt previews; set includeCompleted to audit recently consumed rows.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The target session ID.",
        },
        includeCompleted: {
          type: "boolean",
          description:
            "Optional. If true, include completed and failed queue rows. Defaults to false.",
        },
        includePromptText: {
          type: "boolean",
          description:
            "Optional. If true, include full prompt text. Defaults to false; promptPreview is always included.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "send_prompt",
    description:
      "Queue a follow-up prompt for a child session. If the session is idle, prompt processing starts immediately.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The target child session ID.",
        },
        prompt: {
          type: "string",
          description: "The follow-up prompt to send.",
        },
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    name: "respond_to_prompt",
    description:
      "Answer a child session's interactive prompt such as AskUserQuestion, ExitPlanMode, or ToolPermission.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The child session waiting for input.",
        },
        promptId: {
          type: "string",
          description: "The interactive prompt ID.",
        },
        promptType: {
          type: "string",
          enum: [
            "permission_request",
            "ask_user_question_request",
            "exit_plan_mode_request",
          ],
          description: "The kind of prompt being answered.",
        },
        response: {
          type: "object",
          description: "Prompt-specific response payload.",
        },
      },
      required: ["sessionId", "promptId", "promptType", "response"],
    },
  },
  {
    name: "list_spawned_sessions",
    description:
      "List all child sessions created by this meta-agent session, including current status and a short summary.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

/**
 * Return the meta-agent tools in OpenAI function-calling shape so an
 * extension-agent backend (which renders tools as JSON in its system prompt)
 * can present them. Built-in providers do NOT use this — they connect to the
 * SSE MCP server and discover the tools via ListTools. The two paths share
 * `META_AGENT_TOOL_DEFS` so descriptions stay in sync.
 */
// Extension-agent meta-agents (e.g. gemini-antigravity) receive their meta-agent
// tools through this OpenAI-shaped list. Built-in providers (claude-code,
// openai-codex) instead discover tools over the SSE MCP server and are gated by
// BaseAgentProvider.META_AGENT_ALLOWED_TOOLS, which deliberately OMITS
// spawn_session. spawn_session creates a workstream container (the
// launch-new-session flow) and reparents the child under it, which pulls the
// child out of the META AGENT group and breaks clean meta-agent nesting. To make
// extension-agent meta-agents behave identically to the built-ins, mirror that
// allowlist here so spawn_session is never offered (the meta-agent system prompt
// only references create_session). Keep in sync with the meta-agent subset of
// BaseAgentProvider.META_AGENT_ALLOWED_TOOLS.
const EXTENSION_META_AGENT_ALLOWED_TOOLS = new Set<string>([
  "list_worktrees",
  "create_session",
  "get_session_status",
  "get_session_result",
  "list_queued_prompts",
  "send_prompt",
  "respond_to_prompt",
  "list_spawned_sessions",
]);

export function getMetaAgentOpenAITools(): MetaAgentOpenAITool[] {
  return META_AGENT_TOOL_DEFS
    .filter((t) => EXTENSION_META_AGENT_ALLOWED_TOOLS.has(t.name))
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));
}

/**
 * Dispatch a parsed meta-agent tool call to the registered tool fns and return
 * its text result. Shared by the SSE MCP server's CallTool handler (built-in
 * providers) and the PrivilegedExtensionHost `toolExecutor` broker
 * (extension-agent providers) so the dispatch logic lives in exactly one place.
 *
 * `name` may carry the `mcp__nimbalyst-host__` prefix; it is stripped.
 * `workspaceId` is normalized to its canonical repo path via resolveProjectPath
 * so worktree-rooted callers still resolve to the parent repo.
 *
 * Throws if the tool fns are not yet registered or the tool name is unknown.
 */
export async function dispatchMetaAgentTool(
  name: string,
  aiSessionId: string,
  workspaceId: string,
  args: Record<string, unknown> | undefined
): Promise<string> {
  if (!toolFns) {
    throw new Error("Meta-agent service not initialized");
  }
  const toolName = name.replace(/^mcp__nimbalyst-[a-z-]+__/, "");
  // Normalize the workspaceId to its canonical repo path (worktree callers
  // pass the worktree dir; sessions compare by exact parent-repo path).
  const effectiveWorkspaceId = resolveProjectPath(workspaceId);

  switch (toolName) {
    case "list_worktrees":
      return toolFns.listWorktrees(aiSessionId, effectiveWorkspaceId);
    case "create_session":
      return toolFns.createSession(aiSessionId, effectiveWorkspaceId, (args ?? {}) as CreateSessionArgs);
    case "spawn_session":
      return toolFns.spawnSession(aiSessionId, effectiveWorkspaceId, (args ?? {}) as SpawnSessionArgs);
    case "get_session_status":
      return toolFns.getSessionStatus(
        aiSessionId,
        effectiveWorkspaceId,
        (args?.sessionId as string) ?? ""
      );
    case "get_session_result":
      return toolFns.getSessionResult(
        aiSessionId,
        effectiveWorkspaceId,
        (args?.sessionId as string) ?? "",
        { includeFullResponse: args?.includeFullResponse !== false }
      );
    case "list_queued_prompts":
      return toolFns.listQueuedPrompts(
        aiSessionId,
        effectiveWorkspaceId,
        (args?.sessionId as string) ?? "",
        {
          includeCompleted: args?.includeCompleted === true,
          includePromptText: args?.includePromptText === true,
        }
      );
    case "send_prompt":
      return toolFns.sendPrompt(
        aiSessionId,
        effectiveWorkspaceId,
        (args?.sessionId as string) ?? "",
        (args?.prompt as string) ?? ""
      );
    case "respond_to_prompt":
      return toolFns.respondToPrompt(aiSessionId, effectiveWorkspaceId, (args ?? {}) as RespondToPromptArgs);
    case "list_spawned_sessions":
      return toolFns.listSpawnedSessions(aiSessionId, effectiveWorkspaceId);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
