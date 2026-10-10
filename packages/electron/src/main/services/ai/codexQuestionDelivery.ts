import { createHash } from "node:crypto";
import { AgentMessagesRepository } from "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository";
import { AISessionsRepository } from "@nimbalyst/runtime/storage/repositories/AISessionsRepository";
import {
  getCodexToolLookupAliases,
  parseCodexToolLookupId,
} from "@nimbalyst/runtime/ai/server/toolLookupIds";
import { getQueuedPromptsStore } from "../RepositoryManager";
import { buildInteractivePromptToolResultContent } from "../../mcp/tools/interactivePromptTranscript";
import { codexQuestionTurns, type QuestionAnswer } from "./codexQuestionTurns";
import type { DriveOutcome } from "./QueueDriveService";

interface DeliveryHost {
  drive(sessionId: string, workspacePath: string): Promise<DriveOutcome>;
  publish(sessionId: string): Promise<void>;
}
let host: DeliveryHost | undefined;
export function configureCodexQuestionDelivery(value: DeliveryHost): void {
  host = value;
}

const claims = new Map<
  string,
  Promise<{ success: true; delivery: "live" | "queued" | "already-answered" }>
>();
const recoveries = new Map<string, Promise<void>>();

function recoverOnce(id: string, action: () => Promise<void>): Promise<void> {
  const existing = recoveries.get(id);
  if (existing) return existing;
  const pending = action();
  recoveries.set(id, pending);
  void pending
    .finally(() => {
      if (recoveries.get(id) === pending) recoveries.delete(id);
    })
    .catch(() => {});
  return pending;
}
export const codexQuestionRecoveryId = (
  sessionId: string,
  questionId: string
) =>
  `question-${createHash("sha256")
    .update(JSON.stringify([sessionId, questionId]))
    .digest("hex")}`;

export async function hasAnswer(
  sessionId: string,
  questionId: string
): Promise<boolean> {
  const aliases = getCodexToolLookupAliases(questionId);
  // Read whole content values through the repository: JSON sub-extraction differs
  // between SQLite and PGLite. Page this session's indexed raw log, not the DB.
  for (let offset = 0; ; offset += 500) {
    const rows = await AgentMessagesRepository.list(sessionId, {
      offset,
      limit: 500,
    });
    for (const row of rows) {
      let value;
      try {
        value = JSON.parse(row.content);
      } catch {
        continue;
      }
      if (
        value?.type !== "nimbalyst_tool_result" ||
        typeof value.tool_use_id !== "string"
      )
        continue;
      // Two synthetic IDs can share a raw item ID across turns. Their full
      // timestamp/index identities must still match.
      if (
        questionId.startsWith("nimtc|") &&
        String(value.tool_use_id).startsWith("nimtc|")
      ) {
        if (value.tool_use_id !== questionId) continue;
      } else if (
        !getCodexToolLookupAliases(value.tool_use_id ?? "").some((id) =>
          aliases.includes(id)
        )
      )
        continue;
      let result = value.result;
      if (typeof result === "string") {
        try {
          result = JSON.parse(result);
        } catch {
          continue;
        }
      }
      const earliest = parseCodexToolLookupId(questionId)?.timestampMs;
      const respondedAt =
        result?.respondedAt ??
        (row.createdAt ? new Date(row.createdAt).getTime() : undefined);
      if (
        earliest !== undefined &&
        (!Number.isFinite(respondedAt) || respondedAt < earliest)
      )
        continue;
      if (
        result?.cancelled === true ||
        (result?.answers && Object.keys(result.answers).length > 0)
      )
        return true;
    }
    if (rows.length < 500) return false;
  }
}

/** All Codex question entry points share persistence, claims and FIFO recovery. */
export function deliverCodexQuestionAnswer(
  sessionId: string,
  questionId: string,
  answer: QuestionAnswer
) {
  if (
    !questionId ||
    !answer.answers ||
    typeof answer.answers !== "object" ||
    Array.isArray(answer.answers) ||
    Object.values(answer.answers).some((value) => typeof value !== "string")
  ) {
    return Promise.reject(
      new Error("A question ID and string-valued answers are required")
    );
  }
  questionId = codexQuestionTurns.identify(sessionId, questionId);
  const key = codexQuestionRecoveryId(sessionId, questionId);
  const pending = claims.get(key);
  if (pending) return pending;
  const claim = deliver(sessionId, questionId, answer, key);
  claims.set(key, claim);
  // Only serialize concurrent submissions. Durable results/queue IDs deduplicate
  // later submissions, including stale widgets after a process restart.
  void claim
    .finally(() => {
      if (claims.get(key) === claim) claims.delete(key);
    })
    .catch(() => {});
  return claim;
}

async function deliver(
  sessionId: string,
  questionId: string,
  answer: QuestionAnswer,
  queueId: string
): Promise<{
  success: true;
  delivery: "live" | "queued" | "already-answered";
}> {
  if (!host) throw new Error("Codex question delivery is not initialized");
  const deliveryHost = host;
  const session = await AISessionsRepository.get(sessionId);
  if (!session || session.provider !== "openai-codex" || !session.workspacePath)
    throw new Error("Codex question session is unavailable");
  const queue = getQueuedPromptsStore();
  const queued = await queue.get(queueId);
  const persistCompletion = async () => {
    // The CLI helper is deliberately best-effort. This delivery boundary must
    // propagate a failed write so the submitted answer remains retryable.
    await AgentMessagesRepository.create({
      sessionId,
      source: "openai-codex",
      direction: "output",
      hidden: false,
      createdAt: new Date(),
      content: buildInteractivePromptToolResultContent({
        toolUseId: questionId,
        result: { ...answer, respondedAt: Date.now() },
        isError: answer.cancelled === true,
      }),
    });
  };
  const recover = () =>
    recoverOnce(queueId, async () => {
      if (answer.cancelled) {
        await persistCompletion();
        return;
      }
      const receipt = await queue.get(queueId);
      if (receipt?.status === "failed")
        throw new Error(
          `Question answer continuation failed: ${
            receipt.errorMessage ?? queueId
          }. Retry the failed queued prompt.`
        );
      if (!receipt) {
        await queue.create({
          id: queueId,
          sessionId,
          prompt: `[Resuming after answering a question]\n\n${Object.entries(
            answer.answers
          )
            .map(([q, a]) => `${q}: ${a}`)
            .join("\n")}`,
          documentContext: { promptOrigin: "interactive-question" },
        });
      }
      if (!(await hasAnswer(sessionId, questionId))) await persistCompletion();
      if (receipt?.status === "executing" || receipt?.status === "completed")
        return;
      await deliveryHost.publish(sessionId);
      const outcome = await deliveryHost.drive(
        sessionId,
        session.workspacePath!
      );
      if (outcome.kind === "failed")
        throw new Error(
          `Question answer is saved in the queue but could not start: ${outcome.reason}`
        );
    });
  // A queue receipt precedes widget terminalization, so a failed terminal write
  // can retry without enqueueing another continuation.
  if (queued) {
    await recover();
    return { success: true, delivery: "queued" };
  }
  if (await hasAnswer(sessionId, questionId))
    return { success: true, delivery: "already-answered" };
  await AgentMessagesRepository.create({
    sessionId,
    source: "openai-codex",
    direction: "output",
    createdAt: new Date(),
    content: JSON.stringify({
      type: "ask_user_question_response",
      questionId,
      answers: answer.answers,
      cancelled: answer.cancelled === true,
      respondedBy: answer.respondedBy,
      respondedAt: Date.now(),
    }),
  });
  const result = codexQuestionTurns.claim(
    sessionId,
    questionId,
    answer,
    recover,
    persistCompletion
  );
  console.info(
    `[CodexQuestion] answer routed: sessionId=${sessionId}, questionId=${questionId}, generation=${
      codexQuestionTurns.current(sessionId)?.generation ?? "none"
    }, outcome=${result}`
  );
  if (result === "live") return { success: true, delivery: "live" };
  if (result === "duplicate")
    return { success: true, delivery: "already-answered" };
  if (answer.cancelled) {
    await persistCompletion();
    return { success: true, delivery: "already-answered" };
  }
  await recover();
  return { success: true, delivery: "queued" };
}
