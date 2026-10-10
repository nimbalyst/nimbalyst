import type { InteractivePromptPayload } from "@nimbalyst/runtime/ai/server/transcript/types";

/**
 * The prompts a session is blocked on, as voice can present and answer them.
 *
 * Providers record AskUserQuestion, tool permissions and commit proposals as
 * plain `tool_call` messages; the app card answers them by the call's
 * `providerToolCallId`. Only the legacy `interactive_prompt` shape carried a
 * payload directly, and matching that shape alone meant voice found no pending
 * question in a session the summary said was waiting on one.
 */
export function pendingVoicePrompts(messages: unknown[]): InteractivePromptPayload[] {
  const prompts = new Map<string, InteractivePromptPayload>();
  for (const message of messages as Array<any>) {
    if (message?.type === "interactive_prompt") {
      const prompt = message.interactivePrompt as InteractivePromptPayload | undefined;
      if (prompt?.status === "pending" && prompt.requestId) prompts.set(prompt.requestId, prompt);
      continue;
    }
    if (message?.type !== "tool_call") continue;
    const prompt = promptFromToolCall(message.toolCall);
    if (prompt && !prompts.has(prompt.requestId)) prompts.set(prompt.requestId, prompt);
  }
  return [...prompts.values()];
}

function promptFromToolCall(toolCall: any): InteractivePromptPayload | null {
  if (!toolCall || isSettled(toolCall)) return null;
  const id = typeof toolCall.providerToolCallId === "string" ? toolCall.providerToolCallId : "";
  const args = (toolCall.arguments ?? {}) as Record<string, any>;
  switch (bareToolName(toolCall.toolName)) {
    case "AskUserQuestion":
      if (!id || !Array.isArray(args.questions)) return null;
      return { promptType: "ask_user_question", requestId: id, status: "pending", questions: args.questions };
    case "ToolPermission": {
      const requestId = typeof args.requestId === "string" && args.requestId ? args.requestId : id;
      if (!requestId) return null;
      return {
        promptType: "permission_request",
        requestId,
        status: "pending",
        toolName: String(args.toolName ?? ""),
        rawCommand: String(args.rawCommand ?? ""),
        pattern: String(args.pattern ?? args.toolName ?? ""),
        patternDisplayName: String(args.patternDisplayName ?? ""),
        isDestructive: args.isDestructive === true,
        warnings: Array.isArray(args.warnings) ? args.warnings.map(String) : [],
      };
    }
    case "developer_git_commit_proposal":
      // Legacy Codex `item_N` ids need a renderer-minted lookup id; leave those to the card.
      if (!id || /^item_\d+$/.test(id)) return null;
      return {
        promptType: "git_commit_proposal",
        requestId: id,
        status: "pending",
        commitMessage: typeof args.commitMessage === "string" ? args.commitMessage : "",
        stagedFiles: stagedFilePaths(args.filesToStage),
      };
    default:
      return null;
  }
}

/** Same settled test the session summary applies to interactive tool calls. */
function isSettled(toolCall: any): boolean {
  return ["completed", "error", "resolved", "cancelled"].includes(toolCall.status)
    || (toolCall.result !== undefined && toolCall.result !== null && toolCall.result !== "");
}

function bareToolName(name: unknown): string {
  if (typeof name !== "string") return "";
  const parts = name.split("__");
  return parts[parts.length - 1] || name;
}

/** The model sometimes sends filesToStage as a JSON string or as {path} objects. */
function stagedFilePaths(value: unknown): string[] {
  let files = value;
  if (typeof files === "string") {
    try { files = JSON.parse(files); } catch { return []; }
  }
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => (typeof f === "string" ? f : typeof f?.path === "string" ? f.path : ""))
    .filter((f) => f.trim());
}
