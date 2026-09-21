import { reservePromptAnswer } from '../services/ai/PromptAnswerReservation';
import { cancelCommitProposalOnce, acceptsCommitProposalResponse } from '../services/ai/CommitProposalExecution';
import { hasLiveInteractivePrompt } from "../mcp/tools/interactivePromptLiveness";
import { SessionCommitService } from "../services/SessionCommitService";
import { TranscriptMigrationRepository } from "@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository";
import { AISessionsRepository } from "@nimbalyst/runtime/storage/repositories/AISessionsRepository";
import { parseCodexToolLookupId } from "@nimbalyst/runtime/ai/server/toolLookupIds";
import { safeHandle } from "../utils/ipcRegistry";
import { TrayManager } from "../tray/TrayManager";
import { resolveRequestUserInputPromptTargets } from "../mcp/tools/codexToolCallResolver";
import {
  getGitCommitProposalResponseChannel,
  resolveGitCommitProposalPromptId,
} from "../services/ai/gitCommitProposalPromptUtils";
import { setSessionPendingPrompt } from "../services/ai/pendingPromptPersistence";
import { deliverCodexQuestionAnswer } from "../services/ai/codexQuestionDelivery";

export function registerSessionPromptResponseHandler(): void {
  /**
   * Respond to an interactive prompt.
   * Creates a response message and optionally updates the request status.
   */
  safeHandle(
    "messages:respond-to-prompt",
    async (
      event,
      params: {
        sessionId: string;
        promptId: string;
        promptType:
          | "permission_request"
          | "ask_user_question_request"
          | "exit_plan_mode_request"
          | "git_commit_proposal_request"
          | "request_user_input_request";
        response: any;
        respondedBy: "desktop" | "mobile";
      }
    ) => {
      try {
        const { sessionId, promptId, promptType, response, respondedBy } =
          params;
        if (
          promptType === "ask_user_question_request" &&
          (await AISessionsRepository.get(sessionId))?.provider ===
            "openai-codex"
        ) {
          const result = await deliverCodexQuestionAnswer(sessionId, promptId, {
            answers: response.answers ?? response,
            cancelled: response.cancelled === true,
            respondedBy,
          });
          if (!hasLiveInteractivePrompt(sessionId)) {
            event.sender.send("ai:askUserQuestionAnswered", {
              sessionId,
              questionId: promptId,
            });
          }
          return result;
        }
        const { database } = await import("../database/PGLiteDatabaseWorker");
        const timestamp = Date.now();
        const requestUserInputTargets =
          promptType === "request_user_input_request"
            ? resolveRequestUserInputPromptTargets(promptId)
            : null;
        const canonicalPromptId =
          promptType === "git_commit_proposal_request"
            ? await resolveGitCommitProposalPromptId(sessionId, promptId, false)
            : promptId;

        if (promptType === 'git_commit_proposal_request' && response.action === 'cancelled' && !await cancelCommitProposalOnce(sessionId, canonicalPromptId)) {
          return { success: false, error: 'This proposal was already handled.' };
        }
        if (promptType === 'git_commit_proposal_request' && !acceptsCommitProposalResponse(sessionId, canonicalPromptId, response)) {
          return { success: false, error: 'This response does not match the existing commit outcome.' };
        }

        if (promptType === 'permission_request' || promptType === 'ask_user_question_request') {
          const answer = promptType === 'permission_request' ? response : { answers: response.answers ?? response, cancelled: response.cancelled === true };
          if (!reservePromptAnswer(sessionId, promptType === 'permission_request' ? 'permission' : 'question', canonicalPromptId, answer, 'record')) return { success: false, error: 'This prompt was already answered differently.' };
        }

        // Determine response type and content
        let responseContent: any;
        if (promptType === "permission_request") {
          responseContent = {
            type: "permission_response",
            requestId: canonicalPromptId,
            decision: response.decision,
            scope: response.scope,
            respondedAt: timestamp,
            respondedBy,
          };
        } else if (promptType === "ask_user_question_request") {
          responseContent = {
            type: "ask_user_question_response",
            questionId: canonicalPromptId,
            answers: response.answers || response,
            cancelled: response.cancelled || false,
            respondedAt: timestamp,
            respondedBy,
          };
        } else if (promptType === "exit_plan_mode_request") {
          responseContent = {
            type: "exit_plan_mode_response",
            requestId: canonicalPromptId,
            approved: response.approved,
            clearContext: response.clearContext,
            feedback: response.feedback,
            respondedAt: timestamp,
            respondedBy,
          };
        } else if (promptType === "git_commit_proposal_request") {
          responseContent = {
            type: "git_commit_proposal_response",
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
          // Record the sha -> session link for the Git Log panel. The MCP
          // settle path records it too; the insert is idempotent, and this
          // one still fires if the tool already timed out or the app
          // restarted while the proposal was open.
          if (response.action === "committed" && response.commitHash) {
            void SessionCommitService.getInstance().recordCommit({
              commitSha: response.commitHash,
              sessionId,
              committedAt: new Date(timestamp),
            });
          }
        } else if (promptType === "request_user_input_request") {
          responseContent = {
            type: "request_user_input_response",
            promptId: canonicalPromptId,
            ...(requestUserInputTargets?.rawPromptId
              ? { rawPromptId: requestUserInputTargets.rawPromptId }
              : {}),
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
            "nimbalyst",
            "output",
            JSON.stringify(responseContent),
            new Date(timestamp),
            false,
          ]
        );

        // Drive the canonical transformer forward immediately so the
        // associated tool_call event (e.g. developer_git_commit_proposal)
        // flips from running -> completed before the renderer next reads
        // the transcript. Without this we depend on the next SDK chunk's
        // scheduleTranscriptProcessing to pick up the row, which has
        // race-with-write-coalescing failure modes that leave the widget
        // stuck on "pending" after a successful commit (session
        // cb82f2eb-941c-4fb5-b552-adbae567df61 / 68a60f57). Best-effort:
        // if the service isn't ready, the next chunk catches up.
        if (TranscriptMigrationRepository.hasService()) {
          try {
            const session = await AISessionsRepository.get(sessionId);
            const provider = session?.provider ?? "claude-code";
            await TranscriptMigrationRepository.getService().processNewMessages(
              sessionId,
              provider
            );
          } catch (err) {
            console.warn(
              "[SessionHandlers] processNewMessages after prompt response failed:",
              err
            );
          }
        }

        // Codex currently may not emit a follow-up item.completed event for
        // long-blocking MCP tools after interactive approval. Persist a
        // synthetic completion event so transcript replay shows committed state.
        if (promptType === "git_commit_proposal_request") {
          const codexLookupId = parseCodexToolLookupId(promptId);
          if (codexLookupId) {
            try {
              const session = await AISessionsRepository.get(sessionId);
              if (session?.provider === "openai-codex") {
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
                  const hasError =
                    !!response.error ||
                    response.action !== "committed" ||
                    !response.commitHash;
                  const rawCompletionEvent = {
                    type: "item.completed",
                    item: {
                      id: codexLookupId.itemId,
                      type: "mcp_tool_call",
                      // git_commit_proposal is served by the core `nimbalyst` endpoint.
                      server: "nimbalyst",
                      tool: "developer_git_commit_proposal",
                      result: {
                        action: response.action,
                        commitHash: response.commitHash,
                        commitDate: response.commitDate,
                        filesCommitted: response.filesCommitted,
                        commitMessage: response.commitMessage,
                        ...(response.error ? { error: response.error } : {}),
                      },
                      error: hasError
                        ? response.error || "Commit proposal cancelled"
                        : null,
                      status: hasError ? "failed" : "completed",
                    },
                  };

                  await database.query(
                    `INSERT INTO ai_agent_messages (session_id, source, direction, content, metadata, created_at, hidden)
                                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                      sessionId,
                      "openai-codex",
                      "output",
                      JSON.stringify(rawCompletionEvent),
                      JSON.stringify({
                        eventType: "item.completed",
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
              console.warn(
                "[SessionHandlers] Failed to persist synthetic Codex commit completion event:",
                error
              );
            }
          }
        }

        // For request_user_input, emit to the session-scoped MCP waiter channel
        // so the MCP handler resolves immediately. (The DB row above is the
        // durable fallback for cases where the MCP transport drops.)
        if (promptType === "request_user_input_request") {
          const { ipcMain } = await import("electron");
          const {
            getRequestUserInputResponseChannel,
            getRequestUserInputFallbackResponseChannel,
          } = await import("../mcp/tools/interactiveToolHandlers");
          const waiterPromptIds = requestUserInputTargets?.waiterPromptIds ?? [
            canonicalPromptId,
          ];
          let notifiedWaiter = false;

          for (const waiterPromptId of waiterPromptIds) {
            const channel = getRequestUserInputResponseChannel(
              sessionId,
              waiterPromptId
            );
            if (ipcMain.listenerCount(channel) > 0) {
              notifiedWaiter = true;
              ipcMain.emit(channel, null, {
                answers: response.answers,
                cancelled: response.cancelled === true,
                respondedBy,
              });
            }
          }

          const fallbackChannel =
            getRequestUserInputFallbackResponseChannel(sessionId);
          if (!notifiedWaiter && ipcMain.listenerCount(fallbackChannel) > 0) {
            notifiedWaiter = true;
            ipcMain.emit(fallbackChannel, null, {
              promptId: canonicalPromptId,
              ...(requestUserInputTargets?.rawPromptId
                ? { rawPromptId: requestUserInputTargets.rawPromptId }
                : {}),
              answers: response.answers,
              cancelled: response.cancelled === true,
              respondedBy,
            });
          }

          if (!notifiedWaiter) {
            console.warn(
              `[SessionHandlers] No MCP waiter for RequestUserInput on channels: ${waiterPromptIds.join(
                ", "
              )}. ` +
                `Response was persisted to DB; the handler may have already resolved or the subprocess exited.`
            );
          }
          event.sender.send("ai:requestUserInputResolved", {
            sessionId,
            promptId: canonicalPromptId,
          });
          TrayManager.getInstance().onPromptResolved(sessionId);
        }

        // For git_commit_proposal, emit to the session-scoped MCP waiter channel
        // and notify renderer to clear the pending interactive prompt indicator
        if (promptType === "git_commit_proposal_request") {
          const { ipcMain } = await import("electron");
          const responseChannel = getGitCommitProposalResponseChannel(
            sessionId,
            canonicalPromptId
          );
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
              const { getSessionStateManager } = await import(
                "@nimbalyst/runtime/ai/server/SessionStateManager"
              );
              const stateManager = getSessionStateManager();
              await stateManager.endSession(sessionId);
            } catch (cleanupErr) {
              console.warn(
                "[SessionHandlers] Failed to mark orphaned session as idle:",
                cleanupErr
              );
            }
          }
          event.sender.send("ai:gitCommitProposalResolved", {
            sessionId,
            proposalId: canonicalPromptId,
          });
          TrayManager.getInstance().onPromptResolved(sessionId);
        }

        // Authoritative clear for the persisted "pending prompt" bit.
        // Covers all prompt types resolved via this handler so the next
        // session-list refresh on this or any other device sees the
        // session as idle. The runtime atom clear paths in
        // sessionStateListeners are still in place; this is the durable
        // backstop that survives renderer reloads and reaches mobile.
        void setSessionPendingPrompt(sessionId, false);

        return { success: true, responseContent };
      } catch (error) {
        console.error("[SessionHandlers] Failed to respond to prompt:", error);
        return { success: false, error: String(error) };
      }
    }
  );
}
