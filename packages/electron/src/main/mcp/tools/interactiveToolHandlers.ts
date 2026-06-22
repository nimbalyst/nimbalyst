import { BrowserWindow, ipcMain } from "electron";
import {
  AgentMessagesRepository,
  AISessionsRepository,
} from "@nimbalyst/runtime";
import { getSessionStateManager } from "@nimbalyst/runtime/ai/server/SessionStateManager";
import { notificationService } from "../../services/NotificationService";
import { TrayManager } from "../../tray/TrayManager";
import { findWindowIdForWorkspacePath } from "../mcpWorkspaceResolver";
import { setSessionPendingPrompt } from "../../services/ai/pendingPromptPersistence";
import {
  resolveRequestUserInputPromptTargets,
  resolveToolUseIdFromMcpRequest,
} from "./codexToolCallResolver";
import {
  isClaudeCliSession,
  persistInteractivePromptToolUse,
  persistInteractivePromptToolResult,
} from "./interactivePromptTranscript";
import { applyInteractivePromptSettleTurnState } from "./interactivePromptSettleState";
import { markToolResultPersisted } from "../../services/ai/claudeCliToolResultSeen";
import {
  resolveClaudeCliToolPermission,
  normalizeToolPermissionAnswer,
  parseToolPermissionResponseRecord,
  type ToolPermissionAnswer,
} from "../../services/ai/claudeCliToolPermission";
import {
  isPatternApproved,
  markPatternApproved,
} from "../../services/ai/claudeCliPermissionCache";
import { broadcastMessageLogged } from "../../services/ai/claudeCliUserPromptLog";
import { ClaudeSettingsManager } from "../../services/ClaudeSettingsManager";
import { getPermissionService } from "../../services/PermissionService";

export function getInteractiveToolSchemas(sessionId: string | undefined) {
  if (!sessionId) return [];

  return [
    requestUserInputSchema(),
    {
      name: "AskUserQuestion",
      description:
        "Prompt the user with one or more multiple-choice questions and wait for their response before continuing. Use this when you need explicit confirmation or disambiguation.",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            description:
              "List of questions to ask the user. Each question should provide 2-3 options.",
            items: {
              type: "object",
              properties: {
                header: {
                  type: "string",
                  description:
                    "Short label shown above the question (12 chars or fewer)",
                },
                question: {
                  type: "string",
                  description: "The question to show the user",
                },
                options: {
                  type: "array",
                  minItems: 2,
                  items: {
                    type: "object",
                    properties: {
                      label: {
                        type: "string",
                        description: "User-facing option label",
                      },
                      description: {
                        type: "string",
                        description: "Short sentence describing this option",
                      },
                    },
                    required: ["label", "description"],
                  },
                },
                multiSelect: {
                  type: "boolean",
                  description:
                    "Whether multiple options can be selected for this question",
                },
              },
              required: ["header", "question", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
    {
      name: "developer_git_commit_proposal",
      description: `Propose files and commit message for a git commit.

IMPORTANT: Before calling this tool, you MUST:
1. Call get_session_edited_files to get ALL files edited in this session
2. Cross-reference with git status to find which session files have uncommitted changes
3. Include ALL session-edited files that have changes - do not cherry-pick a subset

This tool will present an interactive widget to the user where they can review
and adjust your proposal before committing.

The commit message should follow these guidelines:
- Start with type prefix: feat:, fix:, refactor:, docs:, test:, chore:
- Focus on IMPACT and WHY, not implementation details
- Title describes user-visible outcome or bug fixed
- Use bullet points (dash prefix) only for multiple distinct changes
- Keep lines under 72 characters
- No emojis
- Lead with problem solved or capability added, not technique used
- If the commit resolves a referenced issue or tracker item, include the
  appropriate tracker reference in the proposed message using the canonical
  closing syntax for that system (for example: Fixes #123, Closes ABC-123).
  If the correct closing syntax is unclear, include a neutral reference
  line instead of omitting the tracker entirely`,
      inputSchema: {
        type: "object",
        properties: {
          filesToStage: {
            type: "array",
            items: {
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    path: {
                      type: "string",
                      description: "File path relative to workspace root",
                    },
                    status: {
                      type: "string",
                      enum: ["added", "modified", "deleted"],
                      description: "Git status of the file",
                    },
                  },
                  required: ["path", "status"],
                },
              ],
            },
            description:
              "Array of file paths (strings) or file objects with path and status (added/modified/deleted)",
          },
          commitMessage: {
            type: "string",
            description:
              "Proposed commit message following the guidelines above",
          },
          reasoning: {
            type: "string",
            description:
              "Explanation of why these files were selected and why this commit message is appropriate",
          },
        },
        required: ["filesToStage", "commitMessage", "reasoning"],
      },
    },
  ];
}

type McpToolResult = {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
};

export async function handleAskUserQuestion(
  args: any,
  sessionId: string | undefined,
  request: any
): Promise<McpToolResult> {
  const typedArgs = args as
    | {
        questions?: Array<{
          header?: string;
          question?: string;
          options?: Array<{ label?: string; description?: string }>;
          multiSelect?: boolean;
        }>;
      }
    | undefined;

  const rawQuestions = Array.isArray(typedArgs?.questions)
    ? typedArgs.questions
    : [];

  if (rawQuestions.length === 0) {
    return {
      content: [
        { type: "text", text: "Error: questions is required and must be a non-empty array" },
      ],
      isError: true,
    };
  }

  const normalizedQuestions = rawQuestions
    .map((question) => {
      if (!question || typeof question !== "object") {
        return null;
      }

      const header = typeof question.header === "string" ? question.header : "";
      const prompt = typeof question.question === "string" ? question.question : "";
      const rawOptions = Array.isArray(question.options) ? question.options : [];
      if (!header || !prompt || rawOptions.length === 0) {
        return null;
      }

      const options = rawOptions
        .map((option) => {
          const label =
            option && typeof option.label === "string" ? option.label : "";
          const description =
            option && typeof option.description === "string"
              ? option.description
              : "";
          if (!label || !description) {
            return null;
          }
          return { label, description };
        })
        .filter(
          (option): option is { label: string; description: string } =>
            option !== null
        );

      if (options.length === 0) {
        return null;
      }

      return {
        header,
        question: prompt,
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter(
      (
        question
      ): question is {
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
        multiSelect: boolean;
      } => question !== null
    );

  if (normalizedQuestions.length === 0) {
    return {
      content: [
        { type: "text", text: "Error: No valid questions found in request" },
      ],
      isError: true,
    };
  }

  const questionId =
    await resolveToolUseIdFromMcpRequest(request, sessionId, "AskUserQuestion") ||
    `ask-${sessionId || "unknown"}-${Date.now()}`;
  const questionResponseChannel = `ask-user-question-response:${sessionId || "unknown"}:${questionId}`;
  const fallbackSessionChannel = `ask-user-question:${sessionId || "unknown"}`;

  console.log(`[MCP Server] AskUserQuestion waiting for response: questionId=${questionId}, sessionId=${sessionId}`);

  // Update session status so all windows show the pending indicator
  if (sessionId) {
    getSessionStateManager().updateActivity({
      sessionId,
      status: 'waiting_for_input',
    }).catch((err) => {
      console.error('[MCP Server] Failed to update session status to waiting_for_input:', err);
    });
  }

  // NIM-806: we deliberately do NOT persist a synthetic nimbalyst_tool_use row
  // here. The proxy observation bridge already persists the CLI's whole assistant
  // turn (source 'claude-code') INCLUDING this AskUserQuestion tool_use block, so
  // ClaudeCodeRawParser renders the answerable widget from it (keyed by the same
  // claudecode/toolUseId == questionId, so the answer still reaches our response
  // channel). Writing a second synthetic row caused an ordering inversion — it
  // lands at tool-call time, ~26ms BEFORE the proxy turn's explanatory text
  // (persisted at message_stop) — so the widget rendered ABOVE the text that
  // motivates it, plus a duplicate question card. The settle still writes the
  // synthetic tool_result (below) to flip the widget to answered. `isCliSession`
  // is still needed by the settle path (CLI defers turn-state to the PID watcher).
  const isCliSession = await isClaudeCliSession(sessionId);

  // NIM-850: drive the pending-interactive-prompt flag from the explicit prompt
  // lifecycle (mirrors PromptForUserInput's ai:requestUserInput and the SDK path),
  // NOT from the coarse pid-`waiting` status. The renderer's session:waiting
  // handler no longer sets the flag for claude-code-cli, because that pid signal
  // also fires for routine tool/MCP waits and — with no symmetric clear — left
  // "Thinking…" suppressed for the rest of the turn. Broadcasting ai:askUserQuestion
  // here sets the flag (and feeds voice mode) exactly while the question is pending;
  // the settle below broadcasts ai:askUserQuestionAnswered to clear it. Sent to all
  // windows (the renderer handler keys by sessionId); handleAskUserQuestion only
  // runs for the MCP-routed CLI path, so SDK sessions are unaffected.
  if (isCliSession && sessionId) {
    void setSessionPendingPrompt(sessionId, true);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send("ai:askUserQuestion", {
          sessionId,
          questionId,
          questions: normalizedQuestions,
        });
      }
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const settle = (result: {
      answers?: Record<string, string>;
      cancelled?: boolean;
      respondedBy?: "desktop" | "mobile";
    }, source: string = 'unknown') => {
      if (settled) return;
      settled = true;

      console.log(`[MCP Server] AskUserQuestion settled via ${source}: questionId=${questionId}, cancelled=${result?.cancelled}`);

      // Restore the running indicator as the turn resumes. CLI sessions defer to
      // the PID-state watcher (NIM-806 Defect A — forcing 'running' here would
      // race the watcher's turn-ending 'idle' and stick the indicator on).
      if (sessionId) {
        void applyInteractivePromptSettleTurnState({
          sessionId,
          isCliSession,
          stateManager: getSessionStateManager(),
        }).catch(() => {});
      }

      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      ipcMain.removeListener(questionResponseChannel, onQuestionIdResponse);
      ipcMain.removeListener(fallbackSessionChannel, onSessionFallbackResponse);

      const cancelled = result?.cancelled === true;
      const answers =
        result?.answers && typeof result.answers === "object"
          ? result.answers
          : {};
      const respondedBy = result?.respondedBy || "desktop";

      // NIM-806: mirror the start write — the external CLI never emits a
      // tool_result block, so persist a synthetic one to flip the widget out of
      // its pending state (ClaudeCliPromptSurface drops answered prompts).
      if (isCliSession && sessionId) {
        void persistInteractivePromptToolResult({
          sessionId,
          toolUseId: questionId,
          result: {
            answers: cancelled ? {} : answers,
            cancelled,
            respondedBy,
            respondedAt: Date.now(),
          },
          isError: cancelled,
        });

        // NIM-850: clear the pending-interactive-prompt flag the moment the prompt
        // settles (answered or cancelled). For claude-code-cli the renderer otherwise
        // never clears it mid-turn — session:streaming intentionally doesn't, and
        // there was no resolved broadcast — so "Thinking…" stayed suppressed until
        // the turn ended. Mirrors PromptForUserInput's ai:requestUserInputResolved.
        void setSessionPendingPrompt(sessionId, false);
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) {
            w.webContents.send("ai:askUserQuestionAnswered", {
              sessionId,
              questionId,
            });
          }
        }
      }

      if (cancelled) {
        resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                cancelled: true,
                respondedBy,
                respondedAt: Date.now(),
              }),
            },
          ],
          isError: true,
        });
        return;
      }

      resolve({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answers,
              respondedBy,
              respondedAt: Date.now(),
            }),
          },
        ],
        isError: false,
      });
    };

    const onQuestionIdResponse = (
      _event: unknown,
      result: {
        answers?: Record<string, string>;
        cancelled?: boolean;
        respondedBy?: "desktop" | "mobile";
      }
    ) => settle(result, 'ipc-specific');

    const onSessionFallbackResponse = (
      _event: unknown,
      result: {
        questionId?: string;
        answers?: Record<string, string>;
        cancelled?: boolean;
        respondedBy?: "desktop" | "mobile";
      }
    ) => {
      settle(result, 'ipc-fallback');
    };

    ipcMain.once(questionResponseChannel, onQuestionIdResponse);
    ipcMain.once(fallbackSessionChannel, onSessionFallbackResponse);

    // Database polling fallback: if the IPC path fails (e.g., transport issues),
    // poll for a response message written by the AIService answer handler.
    if (sessionId) {
      const POLL_INTERVAL = 1000;
      const MAX_POLL_TIME = 10 * 60 * 1000;
      const pollStart = Date.now();

      pollTimer = setInterval(async () => {
        if (settled || Date.now() - pollStart > MAX_POLL_TIME) {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          return;
        }

        try {
          const messages = await AgentMessagesRepository.list(sessionId, { limit: 20 });
          for (const msg of messages) {
            try {
              const content = JSON.parse(msg.content);
              if (content.type === 'ask_user_question_response' && content.questionId === questionId) {
                if (content.cancelled) {
                  settle({ cancelled: true, respondedBy: content.respondedBy }, 'db-poll');
                } else {
                  settle({ answers: content.answers, respondedBy: content.respondedBy }, 'db-poll');
                }
                return;
              }
            } catch {
              // Not valid JSON, skip
            }
          }
        } catch {
          // Database error, continue polling
        }
      }, POLL_INTERVAL);
    }
  });
}

/** IPC channel the renderer's ToolPermission answer is routed onto (per request). */
export function getToolPermissionResponseChannel(
  sessionId: string | undefined,
  requestId: string,
): string {
  return `tool-permission-response:${sessionId || "unknown"}:${requestId}`;
}

/**
 * Block until the ToolPermission widget answer arrives over IPC (desktop fast
 * path). A long max-wait fails CLOSED (deny) so a forgotten prompt can't wedge
 * the CLI forever. Mobile responses arrive by sync and are persisted as
 * permission_response rows, so poll the DB as the durable fallback.
 */
function waitForToolPermissionAnswer(
  sessionId: string,
  requestId: string,
): Promise<ToolPermissionAnswer> {
  const channel = getToolPermissionResponseChannel(sessionId, requestId);
  console.log(
    `[MCP Server] ToolPermission waiting for response: requestId=${requestId}, sessionId=${sessionId}`,
  );
  return new Promise<ToolPermissionAnswer>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const settle = (answer: ToolPermissionAnswer, source: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      ipcMain.removeListener(channel, onResponse);
      console.log(
        `[MCP Server] ToolPermission settled via ${source}: requestId=${requestId}, decision=${answer.decision}`,
      );
      resolve(answer);
    };

    const onResponse = (_event: unknown, payload: any) => {
      settle(normalizeToolPermissionAnswer(payload), "ipc");
    };

    ipcMain.once(channel, onResponse);

    const POLL_INTERVAL = 1000;
    pollTimer = setInterval(async () => {
      if (settled) return;
      try {
        const messages = await AgentMessagesRepository.list(sessionId, { limit: 50 });
        for (const msg of messages) {
          const answer = parseToolPermissionResponseRecord(msg.content, requestId);
          if (answer) {
            settle(answer, "db-poll");
            return;
          }
        }
      } catch {
        // Database fallback is best-effort; the timeout still fail-closes.
      }
    }, POLL_INTERVAL);

    const MAX_WAIT = 10 * 60 * 1000;
    timer = setTimeout(() => {
      console.warn(
        `[MCP Server] ToolPermission timed out (deny): requestId=${requestId}`,
      );
      settle({ decision: "deny", scope: "once", cancelled: true }, "timeout");
    }, MAX_WAIT);
  });
}

/**
 * NIM-806 Phase 4 (Direction A): render a Nimbalyst ToolPermission widget for a
 * genuine claude-code-cli tool that needs approval, and return the decision.
 *
 * The CLI reaches this via its `PreToolUse` permission hook → Nimbalyst's local
 * `/permission` endpoint (httpServer) → here. (We originally targeted
 * `--permission-prompt-tool`, but that flag is silently ignored by the
 * interactive CLI; the PreToolUse hook is the mechanism that works interactively.)
 *
 * We render the real ToolPermission widget inline (synthetic
 * `nimbalyst_tool_use`/`tool_result` rows — the external CLI never writes to
 * ai_agent_messages) and return `{behavior:'allow'|'deny'}` in the MCP-result
 * shape; the endpoint maps that to the hook's permissionDecision. All Electron/IPC
 * I/O is supplied here; the decision logic lives in the pure, unit-tested
 * `resolveClaudeCliToolPermission`.
 */
export async function handleToolPermission(
  args: any,
  sessionId: string | undefined,
  workspacePath: string | undefined,
  _request: any,
): Promise<McpToolResult> {
  if (!sessionId) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ behavior: "deny", message: "No session for permission request" }),
        },
      ],
      isError: false,
    };
  }

  const isCliSession = await isClaudeCliSession(sessionId);

  let sessionTitle = "AI Session";
  try {
    const session = await AISessionsRepository.get(sessionId);
    if (session?.title) sessionTitle = session.title;
  } catch {
    // default title
  }

  return resolveClaudeCliToolPermission(
    { args, sessionId, workspacePath },
    {
      isPatternApproved,
      markPatternApproved,
      // Workspace mode (allow-all / bypass-all) auto-approves without a widget,
      // mirroring the SDK path — the hook bypasses the CLI's own mode handling.
      getPermissionMode: (wp) => (wp ? getPermissionService().getPermissionMode(wp) : null),
      // Honor patterns saved via "Always" (and explicit denies) across sessions.
      getAllowDenyLists: async (wp) => {
        if (!wp) return { allow: [], deny: [] };
        try {
          const eff = await ClaudeSettingsManager.getInstance().getEffectiveSettings(wp);
          return { allow: eff.permissions.allow ?? [], deny: eff.permissions.deny ?? [] };
        } catch {
          return { allow: [], deny: [] };
        }
      },
      makeRequestId: () =>
        `tool-perm-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      persistToolUse: async ({ sessionId: sid, toolUseId, input }) => {
        await persistInteractivePromptToolUse({
          sessionId: sid,
          toolUseId,
          toolName: "ToolPermission",
          input,
        });
        // The permission-prompt call is the CLI's own mechanism — it is NOT in
        // the model's streamed tool_use, so the proxy never broadcasts a reload
        // for it. Broadcast ourselves so the widget renders promptly.
        broadcastMessageLogged(sid, workspacePath ?? "");
      },
      persistToolResult: async ({ sessionId: sid, toolUseId, result, isError }) => {
        await persistInteractivePromptToolResult({ sessionId: sid, toolUseId, result, isError });
        broadcastMessageLogged(sid, workspacePath ?? "");
      },
      waitForAnswer: ({ sessionId: sid, requestId }) => waitForToolPermissionAnswer(sid, requestId),
      setWaitingStatus: (sid) => {
        getSessionStateManager()
          .updateActivity({ sessionId: sid, status: "waiting_for_input" })
          .catch((err) => {
            console.error("[MCP Server] Failed to set waiting_for_input for tool permission:", err);
          });
      },
      applySettle: (sid) => {
        void applyInteractivePromptSettleTurnState({
          sessionId: sid,
          isCliSession,
          stateManager: getSessionStateManager(),
        }).catch(() => {});
      },
      savePattern: async (wp, pattern) => {
        await ClaudeSettingsManager.getInstance().addAllowedTool(wp, pattern);
      },
      notifyBlocked: ({ sessionId: sid, workspacePath: wp }) => {
        notificationService.showBlockedNotification(sid, sessionTitle, "permission", wp ?? "");
        TrayManager.getInstance().onPromptCreated(sid);
      },
      log: (m) => console.log(`[MCP Server] ${m}`),
    },
  );
}

export async function handleGitCommitProposal(
  args: any,
  sessionId: string | undefined,
  workspacePath: string | undefined,
  request: any
): Promise<McpToolResult> {
  type FileToStage =
    | string
    | { path: string; status: "added" | "modified" | "deleted" };

  const rawProposalArgs = args as
    | {
        filesToStage?: FileToStage[] | string;
        commitMessage?: string;
        reasoning?: string;
      }
    | undefined;

  // The model sometimes sends filesToStage as a JSON-encoded string instead of an array
  let parsedFilesToStage = rawProposalArgs?.filesToStage;
  if (typeof parsedFilesToStage === "string") {
    console.warn(
      "[MCP Server] developer_git_commit_proposal: filesToStage received as string instead of array, parsing JSON"
    );
    try {
      parsedFilesToStage = JSON.parse(parsedFilesToStage);
    } catch (e) {
      console.error(
        "[MCP Server] developer_git_commit_proposal: Failed to parse filesToStage string as JSON:",
        e
      );
      parsedFilesToStage = undefined;
    }
  }
  if (parsedFilesToStage && !Array.isArray(parsedFilesToStage)) {
    console.error(
      "[MCP Server] developer_git_commit_proposal: filesToStage is not an array after parsing, got:",
      typeof parsedFilesToStage
    );
    parsedFilesToStage = undefined;
  }
  const proposalArgs = rawProposalArgs
    ? {
        ...rawProposalArgs,
        filesToStage: Array.isArray(parsedFilesToStage)
          ? parsedFilesToStage
          : undefined,
      }
    : undefined;

  if (!proposalArgs?.filesToStage || !proposalArgs?.commitMessage) {
    return {
      content: [{ type: "text", text: "Error: filesToStage and commitMessage are required" }],
      isError: true,
    };
  }

  if (!workspacePath) {
    return {
      content: [{ type: "text", text: "Error: workspacePath is required for git commit proposal" }],
      isError: true,
    };
  }

  // Find the target window (resolves worktree paths to parent project)
  const commitWindowId = await findWindowIdForWorkspacePath(workspacePath);
  if (!commitWindowId) {
    return {
      content: [{ type: "text", text: `Error: No window found for workspace: ${workspacePath}` }],
      isError: true,
    };
  }

  const commitWindow = BrowserWindow.fromId(commitWindowId);
  if (!commitWindow || commitWindow.isDestroyed()) {
    return {
      content: [{ type: "text", text: "Error: Window no longer exists" }],
      isError: true,
    };
  }

  // Use provider tool-call ID as the proposal ID when available
  const toolUseId = await resolveToolUseIdFromMcpRequest(
    request,
    sessionId,
    "developer_git_commit_proposal",
  );
  const proposalId =
    toolUseId ||
    `git-commit-proposal-${Date.now()}-${Math.random()
      .toString(36)
      .substring(7)}`;

  const targetSessionId = sessionId || "unknown";

  // Persist the proposal to database for durability
  try {
    const now = new Date();

    // Synthesize a nimbalyst_tool_use row so the transcript parser can produce
    // a tool_call_started canonical event for the widget before the SDK's
    // own assistant chunk (which carries the same tool_use block) clears
    // the AgentMessageWriteQueue. The queue holds non-blocking chunk writes
    // for up to 200ms of idle, and once the SDK pauses here waiting for the
    // user response no further chunks arrive to drive a flush -- so without
    // this synthetic write the widget would not appear until the next
    // explicit `flushPendingWrites()` (turn end, abort, etc.).
    //
    // Same shape AskUserQuestion uses. Keyed by the SDK's toolUseId; the
    // parser's existing cross-batch dedup (findByProviderToolCallId) keeps
    // the later SDK chunk from creating a duplicate canonical event.
    if (toolUseId) {
      try {
        await AgentMessagesRepository.create({
          sessionId: targetSessionId,
          source: "claude-code",
          direction: "output",
          content: JSON.stringify({
            type: "nimbalyst_tool_use",
            id: toolUseId,
            name: "developer_git_commit_proposal",
            input: {
              filesToStage: proposalArgs.filesToStage,
              commitMessage: proposalArgs.commitMessage,
              reasoning: proposalArgs.reasoning,
            },
          }),
          hidden: false,
          createdAt: now,
        });
      } catch (err) {
        console.warn(
          "[MCP Server] Failed to persist synthetic developer_git_commit_proposal tool_use:",
          err
        );
      }
    }

    await AgentMessagesRepository.create({
      sessionId: targetSessionId,
      source: "mcp",
      direction: "output",
      content: JSON.stringify({
        type: "git_commit_proposal",
        proposalId,
        toolUseId,
        filesToStage: proposalArgs.filesToStage,
        commitMessage: proposalArgs.commitMessage,
        reasoning: proposalArgs.reasoning,
        workspacePath,
        timestamp: now.getTime(),
        status: "pending",
      }),
      hidden: false,
      createdAt: now,
    });
    // console.log(
    //   `[MCP Server] Persisted git commit proposal: ${proposalId}, notifying renderer for session: ${targetSessionId}`
    // );
    if (commitWindow) {
      // Include proposal data in the IPC so renderer-side consumers (the
      // GitCommit widget AND the voice forwarding path) can display the
      // commit message and act on the file list without needing a separate
      // round-trip to load the persisted proposal from the database.
      commitWindow.webContents.send("ai:gitCommitProposal", {
        sessionId: targetSessionId,
        proposalId,
        commitMessage: proposalArgs.commitMessage,
        filesToStage: proposalArgs.filesToStage,
        workspacePath,
      });
    } else {
      console.warn("[MCP Server] No commitWindow found to send IPC event");
    }

    // Notify tray of pending prompt
    TrayManager.getInstance().onPromptCreated(targetSessionId);
    // Persist pending-prompt bit + push to mobile
    void setSessionPendingPrompt(targetSessionId, true);
  } catch (error) {
    console.error("[MCP Server] Failed to persist git commit proposal:", error);
    // Continue anyway - worst case is no durability
  }

  // Check if auto-commit is enabled
  let isAutoCommit = false;
  try {
    const Store = (await import("electron-store")).default;
    const aiSettingsStore = new Store({ name: "ai-settings" });
    isAutoCommit = aiSettingsStore.get("autoCommitEnabled", false) as boolean;
  } catch {
    // If we can't read settings, fall through to manual mode
  }

  if (isAutoCommit) {
    console.log(
      `[MCP Server] Auto-commit enabled, executing commit directly for proposal: ${proposalId}`
    );

    const getFilePath = (f: FileToStage) =>
      typeof f === "string" ? f : f.path;
    const filePaths = proposalArgs.filesToStage!.map(getFilePath);
    const commitMessage = proposalArgs.commitMessage!;

    const {
      createGitCommitProposalResponse,
      executeGitCommit,
    } = await import("../../services/GitCommitService");

    let commitResult: {
      success: boolean;
      commitHash?: string;
      commitDate?: string;
      error?: string;
    };
    try {
      commitResult = await executeGitCommit(
        workspacePath,
        commitMessage,
        filePaths,
        { logContext: "[git:auto-commit]" }
      );
    } catch (error) {
      console.error("[MCP Server] Auto-commit failed:", error);
      commitResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const response = createGitCommitProposalResponse(
      commitResult,
      filePaths,
      commitMessage
    );

    // Persist the response to DB
    const { database } = await import(
      "../../database/PGLiteDatabaseWorker"
    );
    const timestamp = Date.now();
    const responseContent = {
      type: "git_commit_proposal_response",
      proposalId,
      ...response,
      respondedAt: timestamp,
      respondedBy: "auto_commit",
    };
    await database.query(
      `INSERT INTO ai_agent_messages (session_id, source, direction, content, created_at, hidden)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        targetSessionId,
        "nimbalyst",
        "output",
        JSON.stringify(responseContent),
        new Date(timestamp),
        false,
      ]
    );

    // Notify renderer to clear the pending interactive prompt indicator
    if (commitWindow && !commitWindow.isDestroyed()) {
      commitWindow.webContents.send("ai:gitCommitProposalResolved", {
        sessionId: targetSessionId,
        proposalId,
        workspacePath,
      });
      commitWindow.webContents.send("mcp:gitCommitProposal", {
        proposalId,
        workspacePath,
        sessionId: targetSessionId,
        filesToStage: proposalArgs.filesToStage,
        commitMessage: proposalArgs.commitMessage,
        reasoning: proposalArgs.reasoning,
      });
    }
    // Persist resolved state + push to mobile
    void setSessionPendingPrompt(targetSessionId, false);

    if (commitResult.success) {
      console.log(
        `[MCP Server] Auto-commit completed: ${commitResult.commitHash}`
      );
    } else {
      console.warn(
        `[MCP Server] Auto-commit did not commit: ${commitResult.error || "unknown error"}`
      );
    }

    if (response.action === "committed" && response.commitHash) {
      // Link commit to tracker items via session (fire-and-forget)
      import("../../services/CommitTrackerLinker").then(({ commitTrackerLinker }) => {
        commitTrackerLinker.linkBySession(
          response.commitHash!,
          commitMessage,
          targetSessionId,
          workspacePath,
        ).catch((err) => console.error("[MCP Server] Commit-tracker linking failed:", err));
      }).catch(() => { /* CommitTrackerLinker not available */ });

      return {
        content: [
          {
            type: "text" as const,
            text: `Auto-committed ${filePaths.length} file(s).\nCommit hash: ${
              response.commitHash
            }${
              response.commitDate
                ? `\nCommit date: ${response.commitDate}`
                : ""
            }\nCommit message: ${commitMessage}`,
          },
        ],
        isError: false,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Auto-commit failed: ${
            response.error || "No changes were committed"
          }`,
        },
      ],
      isError: true,
    };
  }

  // Show OS notification if app is backgrounded
  let sessionTitle = "AI Session";
  try {
    const session = await AISessionsRepository.get(targetSessionId);
    if (session?.title) {
      sessionTitle = session.title;
    }
  } catch {
    // Ignore - use default title
  }
  notificationService.showBlockedNotification(
    targetSessionId,
    sessionTitle,
    "git_commit",
    workspacePath
  );

  // Wait for user confirmation with DB polling fallback.
  // The IPC listener is the fast path; DB polling catches responses when the
  // transport drops (the bug that caused this tool to hang indefinitely).
  return new Promise((resolve) => {
    const getFilePath = (f: FileToStage) =>
      typeof f === "string" ? f : f.path;

    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    type CommitResult = {
      action: "committed" | "cancelled" | "error";
      commitHash?: string;
      commitDate?: string;
      error?: string;
      filesCommitted?: string[];
      commitMessage?: string;
    };

    const settle = (result: CommitResult, source: string) => {
      if (settled) return;
      settled = true;

      console.log(
        `[MCP Server] Git commit proposal settled via ${source}: action=${result.action}, hash=${result.commitHash || "none"}`
      );

      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      ipcMain.removeListener(responseChannel, onResponse);

      if (result.action === "committed" && result.commitHash) {
        // Link commit to tracker items via session (fire-and-forget)
        if (targetSessionId && targetSessionId !== "unknown") {
          import("../../services/CommitTrackerLinker").then(({ commitTrackerLinker }) => {
            commitTrackerLinker.linkBySession(
              result.commitHash!,
              result.commitMessage || proposalArgs.commitMessage || "",
              targetSessionId,
              workspacePath,
            ).catch((err) => console.error("[MCP Server] Commit-tracker linking failed:", err));
          }).catch(() => { /* CommitTrackerLinker not available */ });
        }

        const filesCount =
          result.filesCommitted?.length ||
          proposalArgs.filesToStage!.map(getFilePath).length;
        resolve({
          content: [
            {
              type: "text",
              text: `User confirmed and committed ${filesCount} file(s).\nCommit hash: ${
                result.commitHash
              }${
                result.commitDate
                  ? `\nCommit date: ${result.commitDate}`
                  : ""
              }\nCommit message: ${
                result.commitMessage || proposalArgs.commitMessage
              }`,
            },
          ],
          isError: false,
        });
      } else if (result.action === "committed" && !result.commitHash) {
        resolve({
          content: [
            {
              type: "text",
              text: `Commit failed: No commit hash returned. The files may not have been staged correctly.`,
            },
          ],
          isError: true,
        });
      } else {
        resolve({
          content: [
            {
              type: "text",
              text: result.error
                ? `Commit failed: ${result.error}`
                : "User cancelled the commit proposal.",
            },
          ],
          isError: result.error ? true : false,
        });
      }
    };

    const onResponse = (_event: unknown, result: CommitResult) =>
      settle(result, "ipc");

    const responseChannel = `git-commit-proposal-response:${sessionId || "unknown"}:${proposalId}`;
    // console.log(
    //   `[MCP Server] Registering git commit proposal listener on channel: ${responseChannel}`
    // );
    ipcMain.on(responseChannel, onResponse);

    // Database polling fallback: if the IPC path fails (e.g., transport drop),
    // poll for a response message written by the durable prompt handler.
    if (targetSessionId && targetSessionId !== "unknown") {
      const POLL_INTERVAL = 1000;
      const MAX_POLL_TIME = 10 * 60 * 1000;
      const pollStart = Date.now();

      pollTimer = setInterval(async () => {
        if (settled || Date.now() - pollStart > MAX_POLL_TIME) {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          return;
        }

        try {
          const messages = await AgentMessagesRepository.list(
            targetSessionId,
            { limit: 20 }
          );
          for (const msg of messages) {
            try {
              const content = JSON.parse(msg.content);
              if (
                content.type === "git_commit_proposal_response" &&
                content.proposalId === proposalId
              ) {
                settle(
                  {
                    action: content.action || "cancelled",
                    commitHash: content.commitHash,
                    commitDate: content.commitDate,
                    error: content.error,
                    filesCommitted: content.filesCommitted,
                    commitMessage: content.commitMessage,
                  },
                  "db-poll"
                );
                return;
              }
            } catch {
              // Not valid JSON, skip
            }
          }
        } catch {
          // Database error, continue polling
        }
      }, POLL_INTERVAL);
    }

    // Send the proposal to the renderer
    commitWindow.webContents.send("mcp:gitCommitProposal", {
      proposalId,
      workspacePath,
      sessionId: sessionId || "unknown",
      filesToStage: proposalArgs.filesToStage,
      commitMessage: proposalArgs.commitMessage,
      reasoning: proposalArgs.reasoning,
    });
  });
}

// ============================================================
// RequestUserInput
// ============================================================
//
// Generic structured-input prompt with typed fields. The widget renders the
// fields and collects answers. Response delivery follows the durable-prompts
// pattern: IPC fast-path on `request-user-input-response:<sessionId>:<promptId>`,
// and a DB polling fallback that watches for a `request_user_input_response`
// message in `ai_agent_messages`.

// IMPORTANT: This is a flat union schema, not `oneOf` over discriminated
// sub-schemas. OpenAI's function-calling schema converter (used by Codex when
// translating MCP tool schemas) does not handle `oneOf` cleanly and collapses
// it to a generic type -- in practice the agent saw `fields: string[]` and had
// to guess the real shape. A single object with a `type` enum and all
// properties optional is less strict but Codex/OpenAI consume it correctly.
//
// Per-type validation happens in the runtime widget and tool handler, not the
// schema. Field-type-specific required properties are documented in the
// description text so the agent gets it right.
const REQUEST_USER_INPUT_FIELD_SCHEMA = {
  type: "object",
  description:
    "One field in a structured prompt. The `type` discriminator determines which other properties apply. Required-by-type:\n" +
    "  - multiSelect: items[]; optional minSelected, maxSelected\n" +
    "  - singleSelect: options[]; optional allowOther\n" +
    "  - reorder: items[]; optional minItems\n" +
    "  - editText: initialText; optional format ('markdown'|'plain'), placeholder, minLength, maxLength\n" +
    "  - confirm: optional defaultValue (boolean)",
  properties: {
    type: {
      type: "string",
      enum: ["multiSelect", "singleSelect", "reorder", "editText", "confirm"],
      description: "Field type discriminator.",
    },
    id: {
      type: "string",
      description: "Stable key the agent uses to find this field's answer in the response payload.",
    },
    label: { type: "string", description: "Short label shown above the control." },
    description: { type: "string", description: "Optional longer explanation." },

    // multiSelect / reorder share `items`. multiSelect items use defaultChecked
    // and badge; reorder items use removable. Extra properties on the wrong
    // field type are ignored.
    items: {
      type: "array",
      description:
        "For multiSelect and reorder fields. multiSelect items: { id, title, subtitle?, badge?, defaultChecked? }. reorder items: { id, title, subtitle?, removable? }.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          subtitle: { type: "string" },
          badge: { type: "string", description: "multiSelect only: short label like '3 unread' or 'abandoned'." },
          defaultChecked: { type: "boolean", description: "multiSelect only: pre-check this item." },
          removable: { type: "boolean", description: "reorder only: show a delete affordance for this item." },
        },
        required: ["id", "title"],
      },
    },

    // multiSelect bounds.
    minSelected: { type: "integer", minimum: 0, description: "multiSelect: floor on selections (default 0)." },
    maxSelected: { type: "integer", minimum: 0, description: "multiSelect: ceiling (default = items.length)." },

    // reorder bound.
    minItems: { type: "integer", minimum: 0, description: "reorder: floor when items have removable: true (default 0)." },

    // singleSelect.
    options: {
      type: "array",
      description: "For singleSelect: array of { id, label, description? }.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
        },
        required: ["id", "label"],
      },
    },
    allowOther: { type: "boolean", description: "singleSelect: show an 'Other' textarea fallback." },

    // editText.
    initialText: { type: "string", description: "editText: the seed text the user will edit." },
    format: {
      type: "string",
      enum: ["markdown", "plain"],
      description: "editText: how to interpret initialText and serialize the answer (default 'markdown').",
    },
    placeholder: { type: "string", description: "editText: placeholder text when empty." },
    minLength: { type: "integer", minimum: 0, description: "editText: minimum length to allow submit." },
    maxLength: { type: "integer", minimum: 1, description: "editText: maximum length." },

    // confirm.
    defaultValue: { type: "boolean", description: "confirm: initial state (default false)." },
  },
  required: ["type", "id", "label"],
};

function requestUserInputSchema() {
  return {
    // NOTE: Do NOT rename to anything that snake_cases to `request_user_input` --
    // that collides with a Codex CLI built-in tool gated to Plan mode and the
    // agent gets refused with "request_user_input is unavailable in Default mode".
    name: "PromptForUserInput",
    description: `Ask the user for structured input via a composable widget. One prompt can carry multiple typed fields, all rendered together; the agent receives one answer payload keyed by field id.

Each field is an object with { type, id, label, description?, ... }. The "fields" argument is an ARRAY OF OBJECTS, never an array of strings.

Field types and per-type required properties:
- multiSelect — checkbox list with rich rows. Required: items: [{ id, title, subtitle?, badge?, defaultChecked? }, ...]. Optional: minSelected, maxSelected. Use for "pick a subset".
- singleSelect — radio group. Required: options: [{ id, label, description? }, ...]. Optional: allowOther: true to show an "Other" textarea. Use for branching choices.
- reorder — drag-to-reorder list with optional per-item delete. Required: items: [{ id, title, subtitle?, removable? }, ...]. Optional: minItems (floor when items are removable). Use when the user expresses a permutation.
- editText — inline rich-text editor seeded with a draft. Required: initialText. Optional: format ("markdown" | "plain", default "markdown"), placeholder, minLength, maxLength. Use when you have a draft the user should edit before send.
- confirm — yes/no toggle. Optional: defaultValue. Use for binary confirmations.

Example call:
  PromptForUserInput({
    title: "Cleanup sessions",
    intro: "Found 3 stale sessions.",
    fields: [
      {
        type: "multiSelect",
        id: "sessionsToArchive",
        label: "Sessions",
        items: [
          { id: "s1", title: "Refactor settings", subtitle: "47d ago", defaultChecked: true },
          { id: "s2", title: "Sync warning", subtitle: "33d ago" }
        ]
      }
    ]
  })

Prefer this tool over AskUserQuestion when input is richer than a flat list of options (order, removal, freeform edits, items with subtitles/badges, or multi-field composition).`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Overall prompt title" },
        intro: { type: "string", description: "1-2 sentences of context above the fields" },
        fields: {
          type: "array",
          minItems: 1,
          items: REQUEST_USER_INPUT_FIELD_SCHEMA,
        },
        submitLabel: { type: "string", description: 'Submit button label (default "Confirm")' },
        cancelLabel: { type: "string", description: 'Cancel button label (default "Cancel")' },
      },
      required: ["fields"],
    },
  };
}

export function getRequestUserInputResponseChannel(
  sessionId: string,
  promptId: string,
): string {
  return `request-user-input-response:${sessionId || "unknown"}:${promptId}`;
}

export function getRequestUserInputFallbackResponseChannel(
  sessionId: string,
): string {
  return `request-user-input-response:${sessionId || "unknown"}:__fallback__`;
}

export async function handleRequestUserInput(
  args: any,
  sessionId: string | undefined,
  workspacePath: string | undefined,
  request: any,
): Promise<McpToolResult> {
  const fields = Array.isArray(args?.fields) ? args.fields : [];
  if (fields.length === 0) {
    return {
      content: [
        { type: "text", text: "Error: at least one field is required in RequestUserInput" },
      ],
      isError: true,
    };
  }

  // Per-type required-shape validation. The MCP input schema is intentionally
  // flat (all per-type properties optional, only type/id/label required) because
  // OpenAI's function-calling schema converter mangles `oneOf` unions and the
  // agent ends up guessing -- see the comment above REQUEST_USER_INPUT_FIELD_SCHEMA.
  // That permissiveness means the agent occasionally emits a field like
  // `{ type: "singleSelect", id, label }` with no `options` array, and the
  // widget then throws "Cannot read properties of undefined (reading 'map')"
  // when it tries to seed/render the field. Catch it here and return a precise
  // error so the agent can retry with the right shape.
  const fieldShapeErrors: string[] = [];
  for (const field of fields) {
    if (!field || typeof field !== "object") {
      fieldShapeErrors.push("each field must be an object");
      continue;
    }
    const fieldId = typeof field.id === "string" ? field.id : "<missing id>";
    switch (field.type) {
      case "multiSelect":
        if (!Array.isArray(field.items) || field.items.length === 0) {
          fieldShapeErrors.push(
            `multiSelect field '${fieldId}' requires a non-empty items[] array of { id, title }`,
          );
        }
        break;
      case "singleSelect":
        if (!Array.isArray(field.options) || field.options.length === 0) {
          fieldShapeErrors.push(
            `singleSelect field '${fieldId}' requires a non-empty options[] array of { id, label }`,
          );
        }
        break;
      case "reorder":
        if (!Array.isArray(field.items) || field.items.length === 0) {
          fieldShapeErrors.push(
            `reorder field '${fieldId}' requires a non-empty items[] array of { id, title }`,
          );
        }
        break;
      case "editText":
        if (typeof field.initialText !== "string") {
          fieldShapeErrors.push(
            `editText field '${fieldId}' requires an initialText string (may be empty)`,
          );
        }
        break;
      case "confirm":
        // No required-by-type properties beyond the base { type, id, label }.
        break;
      default:
        fieldShapeErrors.push(
          `field '${fieldId}' has unknown or missing type '${String(field.type)}' (expected one of multiSelect, singleSelect, reorder, editText, confirm)`,
        );
    }
  }
  if (fieldShapeErrors.length > 0) {
    return {
      content: [
        {
          type: "text",
          text:
            "Error: PromptForUserInput received malformed field(s). Fix and retry:\n  - "
            + fieldShapeErrors.join("\n  - "),
        },
      ],
      isError: true,
    };
  }

  const promptId =
    await resolveToolUseIdFromMcpRequest(request, sessionId, "PromptForUserInput") ||
    `rui-${sessionId || "unknown"}-${Date.now()}`;
  const { waiterPromptIds: promptIdAliases } = resolveRequestUserInputPromptTargets(promptId);
  const promptIdAliasSet = new Set(promptIdAliases);
  const responseChannel = getRequestUserInputResponseChannel(sessionId || "unknown", promptId);
  const fallbackResponseChannel = getRequestUserInputFallbackResponseChannel(sessionId || "unknown");

  console.log(
    `[MCP Server] RequestUserInput waiting for response: promptId=${promptId}, sessionId=${sessionId}`,
  );

  // Update session status so all windows show the pending indicator.
  if (sessionId) {
    getSessionStateManager().updateActivity({
      sessionId,
      status: "waiting_for_input",
    }).catch((err) => {
      console.error("[MCP Server] Failed to update session status:", err);
    });
    // Persist pending-prompt bit + push to mobile so the sidebar indicator
    // survives renderer reloads and reaches other devices.
    void setSessionPendingPrompt(sessionId, true);
  }

  // NIM-806: do NOT persist a synthetic nimbalyst_tool_use here (same reasoning
  // as handleAskUserQuestion). The proxy observation bridge already persists the
  // CLI's assistant turn containing this PromptForUserInput tool_use block (full
  // name mcp__nimbalyst__PromptForUserInput, which CustomToolWidgets maps to
  // RequestUserInputWidget), keyed by the same promptId. A second synthetic row
  // landed ~before the proxy turn's text → widget rendered above its motivating
  // text + a duplicate card. Settle still writes the synthetic tool_result.
  // `isCliSession` is still needed by the settle path.
  const isCliSession = sessionId ? await isClaudeCliSession(sessionId) : false;

  // Notify renderer so the widget can pick up the prompt data immediately
  // (used for voice forwarding -- the widget itself reads from the tool call).
  try {
    if (workspacePath) {
      const targetWindowId = await findWindowIdForWorkspacePath(workspacePath);
      if (targetWindowId) {
        const targetWindow = BrowserWindow.fromId(targetWindowId);
        if (targetWindow && !targetWindow.isDestroyed()) {
          targetWindow.webContents.send("ai:requestUserInput", {
            sessionId,
            promptId,
            args,
          });
        }
      }
    }
  } catch (err) {
    console.warn("[MCP Server] RequestUserInput: failed to notify renderer:", err);
  }

  // Show OS notification if the app is backgrounded.
  let sessionTitle = "AI Session";
  if (sessionId) {
    try {
      const session = await AISessionsRepository.get(sessionId);
      if (session?.title) sessionTitle = session.title;
    } catch {
      // Ignore - use default title.
    }
    notificationService.showBlockedNotification(
      sessionId,
      sessionTitle,
      "question",
      workspacePath ?? "",
    );
    TrayManager.getInstance().onPromptCreated(sessionId);
  }

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const settle = async (
      result: { answers?: Record<string, unknown>; cancelled?: boolean; respondedBy?: "desktop" | "mobile" },
      source: string,
    ) => {
      if (settled) return;
      settled = true;

      console.log(
        `[MCP Server] RequestUserInput settled via ${source}: promptId=${promptId}, cancelled=${result?.cancelled}`,
      );

      if (sessionId) {
        // Restore the running indicator; CLI sessions defer to the PID watcher
        // (NIM-806 Defect A).
        void applyInteractivePromptSettleTurnState({
          sessionId,
          isCliSession,
          stateManager: getSessionStateManager(),
        }).catch(() => {});
        TrayManager.getInstance().onPromptResolved(sessionId);
        // Persist resolved state + push to mobile.
        void setSessionPendingPrompt(sessionId, false);
        // Notify renderer to clear the pending indicator and remove from atom.
        try {
          BrowserWindow.getAllWindows().forEach((w) => {
            if (!w.isDestroyed()) {
              w.webContents.send("ai:requestUserInputResolved", {
                sessionId,
                promptId,
              });
            }
          });
        } catch {
          // Non-fatal.
        }
      }

      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      ipcMain.removeListener(responseChannel, onResponse);
      ipcMain.removeListener(fallbackResponseChannel, onFallbackResponse);

      const cancelled = result?.cancelled === true;
      const answers = result?.answers && typeof result.answers === "object"
        ? result.answers
        : {};
      const respondedBy = result?.respondedBy || "desktop";
      const respondedAt = Date.now();

      // Persist a synthetic tool_result keyed by the same providerToolCallId
      // (`promptId`) so the canonical transcript event for this tool call gets
      // its `result` populated immediately. Without this, the widget relies on
      // the SDK subprocess to emit its own tool_result block; if the subprocess
      // exits between resolving the MCP call and flushing that chunk (e.g. the
      // turn was cancelled, the session was stopped, the pipe broke), the
      // tool_use canonical event stays "pending" forever and the widget shows
      // the input mode again on remount. The SDK's later real tool_result is
      // an idempotent re-update on the same row, so duplicates are harmless.
      if (sessionId) {
        // Mark before the write so the CLI proxy's continuation-body scrape skips
        // this same tool_use_id (NIM-806 Defect B).
        markToolResultPersisted(sessionId, promptId);
        try {
          await AgentMessagesRepository.create({
            sessionId,
            source: "claude-code",
            direction: "output",
            createdAt: new Date(respondedAt),
            content: JSON.stringify({
              type: "nimbalyst_tool_result",
              tool_use_id: promptId,
              result: JSON.stringify({
                cancelled,
                answers: cancelled ? {} : answers,
                respondedBy,
                respondedAt,
              }),
              is_error: cancelled,
            }),
          });
        } catch (err) {
          console.warn("[MCP Server] Failed to persist synthetic RequestUserInput tool_result:", err);
        }
      }

      if (cancelled) {
        resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                cancelled: true,
                respondedBy,
                respondedAt,
              }),
            },
          ],
          isError: true,
        });
        return;
      }

      resolve({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answers,
              respondedBy,
              respondedAt,
            }),
          },
        ],
        isError: false,
      });
    };

    const onResponse = (
      _event: unknown,
      result: {
        answers?: Record<string, unknown>;
        cancelled?: boolean;
        respondedBy?: "desktop" | "mobile";
      },
    ) => settle(result, "ipc");

    const onFallbackResponse = (
      _event: unknown,
      result: {
        promptId?: string;
        rawPromptId?: string;
        answers?: Record<string, unknown>;
        cancelled?: boolean;
        respondedBy?: "desktop" | "mobile";
      },
    ) => {
      const responsePromptIds = [
        typeof result.promptId === "string" ? result.promptId : null,
        typeof result.rawPromptId === "string" ? result.rawPromptId : null,
      ].filter((value): value is string => typeof value === "string" && value.length > 0);

      const isSyntheticFallbackPrompt = promptId.startsWith("rui-");
      if (
        !isSyntheticFallbackPrompt
        && responsePromptIds.length > 0
        && !responsePromptIds.some((id) => promptIdAliasSet.has(id))
      ) {
        return;
      }
      settle(result, "ipc-fallback");
    };

    ipcMain.on(responseChannel, onResponse);
    ipcMain.on(fallbackResponseChannel, onFallbackResponse);

    // Database polling fallback for resilience to IPC drops.
    if (sessionId) {
      const POLL_INTERVAL = 1000;
      const MAX_POLL_TIME = 10 * 60 * 1000;
      const pollStart = Date.now();

      pollTimer = setInterval(async () => {
        if (settled || Date.now() - pollStart > MAX_POLL_TIME) {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          return;
        }

        try {
          const messages = await AgentMessagesRepository.list(sessionId, { limit: 20 });
          for (const msg of messages) {
            try {
              const content = JSON.parse(msg.content);
              const responsePromptIds = [
                typeof content.promptId === "string" ? content.promptId : null,
                typeof content.rawPromptId === "string" ? content.rawPromptId : null,
              ].filter((value): value is string => typeof value === "string" && value.length > 0);

              if (
                content.type === "request_user_input_response"
                && responsePromptIds.some((id) => promptIdAliasSet.has(id))
              ) {
                if (content.cancelled) {
                  settle({ cancelled: true, respondedBy: content.respondedBy }, "db-poll");
                } else {
                  settle({ answers: content.answers, respondedBy: content.respondedBy }, "db-poll");
                }
                return;
              }
            } catch {
              // Not valid JSON, skip.
            }
          }
        } catch {
          // Database error, keep polling.
        }
      }, POLL_INTERVAL);
    }
  });
}
