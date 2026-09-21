import { createHash } from "node:crypto";
import type { InteractivePromptPayload } from "@nimbalyst/runtime/ai/server/transcript/types";
import type { PromptResponsePayload } from "../ai/MobileSessionControlHandler";

/** Whole utterances only: qualifiers/negation must never match an affirmative substring. */
export function explicitVoiceDecision(answer: string): boolean | null {
  const text = answer
    .toLowerCase()
    .trim()
    .replace(/[.!?,]+$/g, "");
  if (
    /^(yes|yes please|yes go ahead|approve|approved|approve (it|this commit|the commit)|go ahead|commit (it|this)|allow|confirm)$/.test(
      text
    )
  )
    return true;
  if (
    /^(no|no thanks|deny|cancel|cancel (it|the commit)|do not (approve|commit|run it)|don't (approve|commit|run it)|not yet|reject)$/.test(
      text
    )
  )
    return false;
  return null;
}

export function voicePromptReadout(
  prompt: InteractivePromptPayload,
  title: string
): string {
  let body: string;
  switch (prompt.promptType) {
    case "git_commit_proposal":
      if (
        !prompt.commitMessage?.trim() ||
        !prompt.stagedFiles?.length ||
        !prompt.stagedFiles.every((f) => typeof f === "string" && f.trim())
      )
        throw new Error("This commit proposal needs its app card.");
      body = `Commit message: ${
        prompt.commitMessage
      }. Files: ${prompt.stagedFiles.join(", ")}. Say approve or cancel.`;
      break;
    case "permission_request":
      if (!prompt.toolName || !prompt.rawCommand)
        throw new Error("This permission request needs its app card.");
      body = `Allow ${prompt.toolName} once: ${prompt.rawCommand}. ${(
        prompt.warnings ?? []
      ).join(". ")} Say yes or no.`;
      break;
    case "ask_user_question": {
      const question = prompt.questions[0];
      if (
        prompt.questions.length !== 1 ||
        !question?.question ||
        question.multiSelect
      )
        throw new Error("Answer this form using its app card.");
      body = `${question.question} ${(question.options ?? [])
        .map((o) => `${o.label}${o.description ? ": " + o.description : ""}`)
        .join(". ")}`;
      break;
    }
    default:
      throw new Error("Answer this prompt using its app card.");
  }
  const text = `Session ${title}. ${body}`;
  // Never truncate the parts of a proposal the user must hear before approving.
  if (text.length > 2400)
    throw new Error(
      "This proposal is too long to read safely. Review its app card."
    );
  return text;
}

export function voicePromptVersion(
  prompt: InteractivePromptPayload,
  taskId: string
): string {
  return createHash("sha256")
    .update(JSON.stringify([taskId, prompt]))
    .digest("hex");
}

export function exactVoiceResponse(
  prompt: InteractivePromptPayload,
  answer: string
): PromptResponsePayload {
  const promptId = prompt.requestId;
  if (prompt.status !== "pending" || !promptId)
    throw new Error("This exact prompt is no longer pending.");
  if (prompt.promptType === "ask_user_question") {
    const question = prompt.questions[0];
    if (
      prompt.questions.length !== 1 ||
      !question ||
      question.multiSelect ||
      !answer.trim()
    )
      throw new Error("Answer this form using its app card.");
    const options = question.options ?? [];
    const matches = options.filter(
      (o) => o.label.trim().toLowerCase() === answer.trim().toLowerCase()
    );
    if (options.length && matches.length !== 1)
      throw new Error("Say one complete option label, or use the app card.");
    return {
      promptId,
      promptType: "ask_user_question",
      response: {
        answers: {
          [question.header || "answer"]: matches[0]?.label ?? answer.trim(),
        },
      },
    };
  }
  const decision = explicitVoiceDecision(answer);
  if (decision === null)
    throw new Error(
      "The answer was ambiguous. Say approve or cancel, or use the app card."
    );
  if (prompt.promptType === "permission_request")
    return {
      promptId,
      promptType: "tool_permission",
      response: { decision: decision ? "allow" : "deny", scope: "once" },
    };
  if (prompt.promptType === "git_commit_proposal")
    return {
      promptId,
      promptType: "git_commit",
      response: decision
        ? {
            action: "committed",
            files: prompt.stagedFiles,
            message: prompt.commitMessage,
          }
        : { action: "cancelled" },
    };
  throw new Error("Unsupported voice answer.");
}
