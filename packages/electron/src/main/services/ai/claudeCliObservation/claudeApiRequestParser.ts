/**
 * Pure parsers for observed Claude `/v1/messages` request bodies (NIM-806,
 * Phase 3). The tee'd SSE response only carries ASSISTANT output; the user's
 * prompt and every `tool_result` ride in the REQUEST body's trailing user
 * message instead. These helpers extract both so the bridge can persist them.
 *
 * Anthropic Messages request shape:
 *   { model, system, messages: [ { role, content: string | ContentBlock[] }, … ] }
 * where the trailing `role:'user'` message is the newest turn — either the
 * user's text prompt, or a synthetic user message carrying `tool_result` blocks
 * answering the previous assistant turn's tool calls (never both in practice).
 */

interface ContentBlock {
  type?: string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface MessageLike {
  role?: string;
  content?: string | ContentBlock[];
}

function messages(body: Record<string, unknown>): MessageLike[] {
  const m = body.messages;
  return Array.isArray(m) ? (m as MessageLike[]) : [];
}

/** The trailing `role:'user'` message, or null. */
function lastUserMessage(body: Record<string, unknown>): MessageLike | null {
  const msgs = messages(body);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") return msgs[i];
  }
  return null;
}

/** Flatten a tool_result `content` (string | text-block array) into one string. */
function flattenBlockContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as ContentBlock).text === "string" ? (b as ContentBlock).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Newest USER prompt text, ignoring messages whose content is only tool_result
 * blocks (those are answers to tool calls, surfaced by `extractToolResults`).
 * Returns null when the trailing user turn carries no text.
 */
export function extractLatestUserText(body: Record<string, unknown>): string | null {
  const msgs = messages(body);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg?.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") {
      return content.trim().length > 0 ? content : null;
    }
    if (Array.isArray(content)) {
      const text = content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
      if (text.trim().length > 0) return text;
      // Trailing user turn is tool_result-only — keep scanning for an earlier
      // textual user turn (the prompt that started this exchange).
    }
  }
  return null;
}

export interface ObservedToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

/** tool_result blocks from the trailing user message (Slice E). */
export function extractToolResults(body: Record<string, unknown>): ObservedToolResult[] {
  const msg = lastUserMessage(body);
  if (!msg || !Array.isArray(msg.content)) return [];
  const results: ObservedToolResult[] = [];
  for (const block of msg.content) {
    if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
      results.push({
        toolUseId: block.tool_use_id,
        content: flattenBlockContent(block.content),
        isError: block.is_error === true,
      });
    }
  }
  return results;
}
