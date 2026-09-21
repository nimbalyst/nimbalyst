import { reservePromptAnswer } from "../PromptAnswerReservation";
import { ipcMain } from "electron";
import { AISessionsRepository } from "@nimbalyst/runtime/storage/repositories/AISessionsRepository";
import {
  ProviderFactory,
  isAskUserQuestionProvider,
} from "@nimbalyst/runtime/ai/server";
import type { AIProviderType } from "@nimbalyst/runtime/ai/server/types";
import { safeHandle } from "../../../utils/ipcRegistry";
import { logger } from "../../../utils/logger";
import {
  hasTerminalizedAskUserQuestion,
  persistAskUserQuestionTerminalResult,
} from "../askUserQuestionFallbackResolution";
import { deliverCodexQuestionAnswer } from "../codexQuestionDelivery";
import type { AIServiceContext } from "./AIServiceContext";

export function registerAskUserQuestionAnswerHandler(
  ctx: AIServiceContext
): void {
  // Handle AskUserQuestion answer response from renderer
  // Used when Claude's AskUserQuestion tool needs user input
  safeHandle(
    "claude-code:answer-question",
    async (
      event,
      {
        questionId,
        answers,
        sessionId,
      }: {
        questionId: string;
        answers: Record<string, string>;
        sessionId?: string;
      }
    ) => {
      logger.main.info(
        `[AIService] AskUserQuestion answer received: questionId=${questionId}, sessionId=${sessionId}`
      );

      // sessionId can be passed directly or extracted from legacy questionId format (ask-{sessionId}-{timestamp})
      let resolvedSessionId = sessionId;
      if (!resolvedSessionId) {
        const sessionIdMatch = questionId.match(/^ask-(.+)-\d+$/);
        if (sessionIdMatch && sessionIdMatch[1] !== "unknown") {
          resolvedSessionId = sessionIdMatch[1];
        }
      }

      if (!resolvedSessionId) {
        logger.main.warn(
          `[AIService] No sessionId for AskUserQuestion: ${questionId}`
        );
        return { success: false, error: "Session ID required" };
      }

      // Use repository directly - we just need session metadata (provider type),
      // not the full session load with messages
      const session = await AISessionsRepository.get(resolvedSessionId);
      if (!session) {
        logger.main.warn(
          `[AIService] Session not found for AskUserQuestion: ${resolvedSessionId}`
        );
        return { success: false, error: "Session not found" };
      }

      if (session.provider === "openai-codex") {
        return deliverCodexQuestionAnswer(resolvedSessionId, questionId, {
          answers,
          respondedBy: "desktop",
        });
      }

      if (!reservePromptAnswer(resolvedSessionId, "question", questionId, { answers })) return { success: false, error: "Question already answered or delivery is unknown." };

      // External/agentless providers (e.g. claude-code-cli) have NO in-process
      // provider instance holding the pending question — the MCP server handler is
      // blocked on the IPC response channel instead (see interactiveToolHandlers
      // handleAskUserQuestion). So a missing provider is NOT fatal: skip the
      // provider-level resolve and fall through to the MCP-channel emit / DB
      // fallback / auto-resume below. (Previously this returned early, so a CLI
      // session's answered widget never reached the waiting MCP handler — NIM-806.)
      const provider = ProviderFactory.getProvider(
        session.provider as AIProviderType,
        resolvedSessionId
      );
      if (!provider) {
        logger.main.info(
          `[AIService] No in-process provider for AskUserQuestion (${session.provider}); routing via MCP/IPC channel: ${resolvedSessionId}`
        );
      }

      const providerResolved =
        provider && isAskUserQuestionProvider(provider)
          ? provider.resolveAskUserQuestion(
              questionId,
              answers,
              resolvedSessionId,
              "desktop"
            )
          : false;

      // MCP interactive tools (Codex path) wait on a session-scoped channel.
      // Emit best-effort so pending MCP calls can resolve even if provider-level pending map
      // is unavailable (e.g., after restart/recovery).
      const mcpQuestionResponseChannel = `ask-user-question-response:${
        resolvedSessionId || "unknown"
      }:${questionId}`;
      const hasMcpWaiter =
        ipcMain.listenerCount(mcpQuestionResponseChannel) > 0;
      if (hasMcpWaiter) {
        logger.main.info(
          `[AIService] AskUserQuestion emitting on MCP channel: ${mcpQuestionResponseChannel}`
        );
        ipcMain.emit(mcpQuestionResponseChannel, event, {
          questionId,
          answers,
          cancelled: false,
          respondedBy: "desktop",
          sessionId: resolvedSessionId,
        });
      }

      const sessionFallbackChannel = `ask-user-question:${resolvedSessionId}`;
      const hasSessionFallbackWaiter =
        ipcMain.listenerCount(sessionFallbackChannel) > 0;
      if (hasSessionFallbackWaiter) {
        logger.main.info(
          `[AIService] AskUserQuestion emitting on session fallback channel: ${sessionFallbackChannel}`
        );
        ipcMain.emit(sessionFallbackChannel, event, {
          questionId,
          answers,
          cancelled: false,
          respondedBy: "desktop",
          sessionId: resolvedSessionId,
        });
      }

      // When AskUserQuestion comes through the MCP server path (not the provider's canUseTool path),
      // the provider's pendingAskUserQuestions map won't have the entry. In that case, also write
      // the response to the database as a fallback so the MCP server's database polling can find it.
      if (!providerResolved && resolvedSessionId) {
        const { AgentMessagesRepository } = await import(
          "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository"
        );
        AgentMessagesRepository.create({
          sessionId: resolvedSessionId,
          source: "claude-code",
          direction: "output" as const,
          createdAt: new Date(),
          content: JSON.stringify({
            type: "ask_user_question_response",
            questionId,
            answers,
            cancelled: false,
            respondedBy: "desktop",
            respondedAt: Date.now(),
          }),
        }).catch((err) => {
          logger.main.warn(
            `[AIService] Failed to persist AskUserQuestion response to database: ${err}`
          );
        });
      }

      logger.main.info(
        `[AIService] AskUserQuestion resolution: providerResolved=${providerResolved}, hasMcpWaiter=${hasMcpWaiter}, hasSessionFallbackWaiter=${hasSessionFallbackWaiter}`
      );

      if (providerResolved || hasMcpWaiter || hasSessionFallbackWaiter) {
        return { success: true };
      }

      // No live handler exists -- the SDK subprocess is dead (e.g., app restarted
      // while session was waiting for input). Auto-resume the session by sending
      // a new message that includes the user's answer. The Claude Code SDK will
      // resume using the stored providerSessionId, picking up conversation history.
      if (resolvedSessionId && ctx.sendMessageHandler && session) {
        // Issue #773: without a terminal tool_result the widget stayed pending, so
        // every re-click auto-resumed again. Refuse a repeat answer for a question
        // this process already terminalized.
        if (hasTerminalizedAskUserQuestion(resolvedSessionId, questionId)) {
          logger.main.info(
            `[AIService] AskUserQuestion already answered without a live handler; ignoring repeat: ${questionId}`
          );
          return { success: false, error: "Question already answered" };
        }

        // Issue #1116: terminalize the tool call BEFORE resuming. The live paths
        // (provider resolve / MCP settle / abort) each write this row; the fallback
        // did not, so the widget never completed and came back on every remount.
        await persistAskUserQuestionTerminalResult({
          sessionId: resolvedSessionId,
          questionId,
          answers,
          cancelled: false,
        });

        // The auto-resume is an in-process recovery: it re-enters the provider
        // with the answer so the SDK resumes from its stored providerSessionId.
        // `claude-code-cli` has nothing of the sort to resume -- sendMessageHandler
        // submits into a live CLI composer, so this would type "[Resuming after
        // answering a question]" into whatever that terminal is doing now, as if
        // the user had written it. The answer is already durable: the response row
        // above settles the waiting MCP handler through its DB poll (see
        // interactiveToolHandlers), and the tool_result just persisted completes
        // the widget.
        if (session.provider === "claude-code-cli") {
          logger.main.info(
            `[AIService] No live handler for AskUserQuestion on ${session.provider}; leaving the answer for the MCP handler rather than auto-resuming: ${resolvedSessionId}`
          );
          return { success: true };
        }

        const answerText = Object.entries(answers)
          .map(([question, answer]) => `${question}: ${answer}`)
          .join("\n");
        const resumeMessage = `[Resuming after answering a question]\n\n${answerText}`;

        logger.main.info(
          `[AIService] No live handler for AskUserQuestion, auto-resuming session: ${resolvedSessionId}`
        );

        // Fire-and-forget: resume the session in the background
        const workspacePath = session.workspacePath;
        setImmediate(async () => {
          try {
            await ctx.sendMessageHandler!(
              event,
              resumeMessage,
              undefined,
              resolvedSessionId,
              workspacePath
            );
          } catch (err) {
            logger.main.error(
              `[AIService] Failed to auto-resume session after AskUserQuestion: ${err}`
            );
          }
        });

        return { success: true };
      }

      logger.main.warn(
        `[AIService] Question not found for provider/session: ${resolvedSessionId}`
      );
      return { success: false, error: "Question not found" };
    }
  );
}
