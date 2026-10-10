import { codexQuestionTurns } from "../../services/ai/codexQuestionTurns";
import { BrowserWindow, ipcMain } from "electron";
import { AgentMessagesRepository } from "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository";
import { AISessionsRepository } from "@nimbalyst/runtime/storage/repositories/AISessionsRepository";
import { getSessionStateManager } from "@nimbalyst/runtime/ai/server/SessionStateManager";
import { setSessionPendingPrompt } from "../../services/ai/pendingPromptPersistence";
import { resolveToolUseIdFromMcpRequest } from "./codexToolCallResolver";
import {
  isClaudeCliSession,
  persistInteractivePromptToolResult,
} from "./interactivePromptTranscript";
import { applyInteractivePromptSettleTurnState } from "./interactivePromptSettleState";
import {
  clearLiveInteractivePrompt,
  noteLiveInteractivePrompt,
  hasLiveInteractivePrompt,
} from "./interactivePromptLiveness";
import {
  attachInteractivePromptCall,
  type InteractivePromptCallExtra,
} from "./interactivePromptKeepalive";
import {
  settleReasonFromResponse,
  shouldTerminalizePrompt,
  type InteractivePromptSettleReason,
} from "./interactivePromptAbandonment";
import { findFreshInteractiveResponse } from "./interactiveResponsePolling";

type McpToolResult = {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
};

export async function handleAskUserQuestion(
  args: any,
  sessionId: string | undefined,
  request: any,
  extra?: InteractivePromptCallExtra
): Promise<McpToolResult> {
  const questionTurn = codexQuestionTurns.current(sessionId);
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
        {
          type: "text",
          text: "Error: questions is required and must be a non-empty array",
        },
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
      const prompt =
        typeof question.question === "string" ? question.question : "";
      const rawOptions = Array.isArray(question.options)
        ? question.options
        : [];
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
    (await resolveToolUseIdFromMcpRequest(
      request,
      sessionId,
      "AskUserQuestion"
    )) || `ask-${sessionId || "unknown"}-${Date.now()}`;
  const questionIdAliasSet = new Set([questionId]);
  const responseNotBefore = Date.now();
  const questionResponseChannel = `ask-user-question-response:${
    sessionId || "unknown"
  }:${questionId}`;
  const fallbackSessionChannel = `ask-user-question:${sessionId || "unknown"}`;

  console.log(
    `[MCP Server] AskUserQuestion waiting for response: questionId=${questionId}, sessionId=${sessionId}`
  );

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
  const isCodex = sessionId
    ? (await AISessionsRepository.get(sessionId))?.provider === "openai-codex"
    : false;
  if (isCodex && !questionTurn?.active) {
    return {
      content: [
        {
          type: "text",
          text: "The owning turn ended before the question could wait for an answer.",
        },
      ],
      isError: true,
    };
  }

  // Update session status so all windows show the pending indicator
  if (sessionId) {
    getSessionStateManager()
      .updateActivity({
        sessionId,
        status: "waiting_for_input",
      })
      .catch((err) => {
        console.error(
          "[MCP Server] Failed to update session status to waiting_for_input:",
          err
        );
      });
  }

  // NIM-850: drive the pending-interactive-prompt flag from the explicit prompt
  // lifecycle (mirrors PromptForUserInput's ai:requestUserInput and the SDK path),
  // NOT from the coarse pid-`waiting` status. The renderer's session:waiting
  // handler no longer sets the flag for claude-code-cli, because that pid signal
  // also fires for routine tool/MCP waits and — with no symmetric clear — left
  // "Thinking…" suppressed for the rest of the turn. Broadcasting ai:askUserQuestion
  // here sets the flag (and feeds voice mode) exactly while the question is pending;
  // the settle below broadcasts ai:askUserQuestionAnswered to clear it. Sent to all
  // windows (the renderer handler keys by sessionId).
  //
  // The broadcast stays CLI-only for the reason above. The pending bit does NOT:
  // this handler serves the MCP AskUserQuestion tool for every provider, and an
  // SDK session waiting on this question is exactly as blocked as a CLI one.
  // Guarding it meant neither the sidebar nor the menu bar knew, and the tray
  // panel filed those sessions under "Running".
  if (sessionId) {
    void setSessionPendingPrompt(sessionId, true, "decision");
  }
  if (isCliSession && sessionId) {
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

  // NIM-2208: registered immediately before the wait and cleared in settle, so
  // the stale-prompt reconcile can never clear the "awaiting input" bit while
  // this handler is genuinely blocked.
  if (sessionId) noteLiveInteractivePrompt(sessionId);

  return new Promise((resolve) => {
    let settled = false;
    let unregisterTurn: (() => void) | undefined;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let detachCall: (() => void) | null = null;

    const settle = (
      result: {
        answers?: Record<string, string>;
        cancelled?: boolean;
        respondedBy?: "desktop" | "mobile";
      },
      source: string = "unknown",
      reason: InteractivePromptSettleReason = "user-responded"
    ) => {
      if (settled) return;
      settled = true;
      detachCall?.();
      unregisterTurn?.();
      if (sessionId) clearLiveInteractivePrompt(sessionId);

      // The client walking away does not answer the question. Tear the waiter
      // down (below) but leave the widget answerable -- a later answer finds no
      // live waiter and resumes the session with it as a new turn (#1116).
      const terminalize = shouldTerminalizePrompt({
        kind: "ask_user_question",
        reason,
      });

      console.log(
        `[MCP Server] AskUserQuestion settled via ${source}: questionId=${questionId}, cancelled=${result?.cancelled}`
      );

      // Restore the running indicator as the turn resumes. CLI sessions defer to
      // the PID-state watcher (NIM-806 Defect A — forcing 'running' here would
      // race the watcher's turn-ending 'idle' and stick the indicator on).
      if (
        sessionId &&
        reason === "user-responded" &&
        (!isCodex ||
          (questionTurn?.active && !hasLiveInteractivePrompt(sessionId)))
      ) {
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
      // Symmetric with the set above: clear for every provider, so an answered
      // question cannot leave a session stuck showing "awaiting input".
      if (sessionId && !hasLiveInteractivePrompt(sessionId)) {
        void setSessionPendingPrompt(sessionId, false);
      }
      if (isCliSession && sessionId) {
        // Only a real response closes the widget out. An abandoned call leaves
        // the tool call pending on purpose, so the question can still be
        // answered (and resume the session) later.
        if (terminalize) {
          void persistInteractivePromptToolResult({
            sessionId,
            toolUseId: questionId,
            result: {
              answers: cancelled ? {} : answers,
              cancelled,
              ...(reason === "superseded" ? { reason } : {}),
              respondedBy,
              respondedAt: Date.now(),
            },
            isError: cancelled,
          });
        }

        // NIM-850: the resolved broadcast. For claude-code-cli the renderer
        // otherwise never clears the flag mid-turn — session:streaming
        // intentionally doesn't, and there was no resolved broadcast — so
        // "Thinking…" stayed suppressed until the turn ended. Mirrors
        // PromptForUserInput's ai:requestUserInputResolved. Sent on abandonment
        // too: nothing is blocked on this session any more, whether or not the
        // question still stands.
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
                ...(reason === "superseded" ? { reason } : {}),
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
        reason?: string;
      }
    ) => settle(result, "ipc-specific", settleReasonFromResponse(result));

    const onSessionFallbackResponse = (
      _event: unknown,
      result: {
        questionId?: string;
        answers?: Record<string, string>;
        cancelled?: boolean;
        respondedBy?: "desktop" | "mobile";
        reason?: string;
      }
    ) => {
      settle(result, "ipc-fallback", settleReasonFromResponse(result));
    };

    if (isCodex) {
      unregisterTurn = codexQuestionTurns.register(
        questionTurn,
        questionId,
        args,
        {
          answer: (result) => settle(result, "turn-owned"),
          abandon: () =>
            settle({ cancelled: true }, "turn-ended", "client-abandoned"),
        }
      );
      if (settled) return;
    } else {
      ipcMain.once(questionResponseChannel, onQuestionIdResponse);
      ipcMain.once(fallbackSessionChannel, onSessionFallbackResponse);
    }

    // #1341: keep the call off the client's idle watchdog while the question is
    // on screen, and settle as cancelled if the client gives up on it anyway --
    // an abandoned question must not keep offering buttons whose answer has
    // nowhere to go (NIM-2607).
    detachCall = attachInteractivePromptCall({
      request,
      extra,
      toolName: "AskUserQuestion",
      onAbort: () =>
        settle({ cancelled: true }, "client-abort", "client-abandoned"),
    });

    // Database polling fallback: if the IPC path fails (e.g., transport issues),
    // poll for a response message written by the AIService answer handler.
    if (sessionId && !isCodex) {
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
          const messages = await AgentMessagesRepository.listTail(
            sessionId,
            50
          );
          const content = findFreshInteractiveResponse(messages, {
            expectedType: "ask_user_question_response",
            idFields: ["questionId", "rawQuestionId"],
            acceptedIds: questionIdAliasSet,
            notBefore: responseNotBefore,
          });
          if (!content) return;
          if (content.cancelled) {
            settle(
              {
                cancelled: true,
                respondedBy: content.respondedBy as
                  | "desktop"
                  | "mobile"
                  | undefined,
              },
              "db-poll"
            );
          } else {
            settle(
              {
                answers: content.answers as Record<string, string> | undefined,
                respondedBy: content.respondedBy as
                  | "desktop"
                  | "mobile"
                  | undefined,
              },
              "db-poll"
            );
          }
        } catch {
          // Database error, continue polling
        }
      }, POLL_INTERVAL);
    }
  });
}
