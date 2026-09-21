import * as fs from "fs/promises";
import * as path from "path";
import type { ClaudeCodeEntry } from "../ClaudeCodeSessionScanner";
import { slimClaudeCodeChunkForStorage } from "@nimbalyst/runtime/ai/server/providers/claudeCode/toolChunkUtils";
import { logger } from "../../utils/logger";

const log = logger.aiSession;

/**
 * Claude Code 2.1.x stashes large tool results in
 * `<sessionId>/tool-results/<id>.txt` and inlines a `<persisted-output>`
 * marker into the JSONL with a path back to the file. If we don't load the
 * external file the imported transcript shows only the 2KB preview.
 *
 * This walks every `tool_result` block on the entry, detects the marker,
 * and rewrites the block's content with the full file contents.
 */
export async function inlinePersistedOutputs(
  entry: ClaudeCodeEntry
): Promise<void> {
  return inlinePersistedOutputsUsing(entry, loadPersistedOutput);
}

export async function inlinePersistedOutputsUsing(
  entry: ClaudeCodeEntry,
  load: (text: string) => Promise<string | null>
): Promise<void> {
  const message = entry.message;
  if (!message) return;
  const content = message.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!block || block.type !== "tool_result") continue;

    if (typeof block.content === "string") {
      const replacement = await load(block.content);
      if (replacement !== null) block.content = replacement;
    } else if (Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (inner && inner.type === "text" && typeof inner.text === "string") {
          const replacement = await load(inner.text);
          if (replacement !== null) inner.text = replacement;
        }
      }
    }
  }
}

export const PERSISTED_OUTPUT_PATTERN =
  /<persisted-output>[\s\S]*?Full output saved to:\s*(.+?)\s*\n[\s\S]*?<\/persisted-output>/;

async function loadPersistedOutput(text: string): Promise<string | null> {
  const match = text.match(PERSISTED_OUTPUT_PATTERN);
  if (!match) return null;
  const externalPath = match[1].trim();
  if (!externalPath || !path.isAbsolute(externalPath)) return null;
  try {
    const data = await fs.readFile(externalPath, "utf-8");
    return data;
  } catch (error: any) {
    log.warn(
      `Failed to inline persisted-output from ${externalPath}: ${
        error?.message ?? error
      }`
    );
    return null;
  }
}

/**
 * Map a Claude Code session's per-turn model id to a claude-code variant.
 *
 * Claude Code JSONL records the model on each assistant entry (e.g.
 * "claude-opus-4-7", new in 2.1.x). Imports previously stored no model at all,
 * so the renderer fell back to a hardcoded `claude-code:sonnet` and every
 * imported session showed Sonnet regardless of the model actually used (#394).
 * Walk the entries newest-first and return the most recent recognisable model
 * as a `claude-code:<variant>` string; undefined when none carry a model.
 */
export function importedClaudeCodeModel(
  entries: ClaudeCodeEntry[]
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const raw = entries[i]?.message?.model;
    if (typeof raw !== "string" || raw.length === 0) continue;
    const id = raw.toLowerCase();
    if (id.includes("opus")) return "claude-code:opus";
    if (id.includes("sonnet")) return "claude-code:sonnet";
    if (id.includes("haiku")) return "claude-code:haiku";
  }
  return undefined;
}

/**
 * Convert Claude Code JSONL entry to Nimbalyst message format
 *
 * IMPORTANT: This must produce the SAME format as ClaudeCodeProvider.logAgentMessage()
 * so that the canonical transcript system can parse it correctly.
 *
 * Live session format examples:
 * - Input: { prompt: "...", options: {...} }
 * - Output (text): { type: "text", content: "..." }
 * - Output (assistant): { type: "assistant", message: { content: [...], ... } }
 * - Output (user/tool result): { type: "user", message: { role: "user", content: [...] }, ... }
 * - Output (attachment): { type: "attachment", attachment: {...}, uuid, session_id }
 */
export function entryToMessage(
  entry: ClaudeCodeEntry
): {
  direction: "input" | "output";
  content: string;
  metadata: any;
  timestamp: string;
} | null {
  // Named branches for non-conversational entry types. Each is handled
  // explicitly so future format changes are easy to spot.
  switch (entry.type) {
    case "queue-operation":
      // Internal SDK enqueue/dequeue bookkeeping. No transcript value.
      return null;
    case "last-prompt":
      // Rolling bookmark of the most recent user prompt. Already covered by
      // the actual user-message entry; importing it would duplicate.
      return null;
    case "file-history-snapshot":
      // AI file-edit snapshot. Belongs to the file-history pipeline, not the
      // chat transcript.
      return null;
    case "summary":
      // LLM-generated session summary. Used as a title source by the scanner;
      // not surfaced as a transcript message.
      return null;
    case "attachment":
      return attachmentToMessage(entry);
    case "system":
      // Standalone system messages from the CLI -- preserved as raw output
      // so the canonical parser can render them as system_message events.
      return systemEntryToMessage(entry);
    case "user":
    case "assistant":
      break; // fall through to conversational handling below
    default:
      return null;
  }

  // Skip meta messages (command outputs, caveats, etc.) - these clutter the transcript
  if (entry.isMeta) {
    return null;
  }

  const timestamp = entry.timestamp ?? new Date().toISOString();

  // Identify a "real" user prompt by content shape, not by parentUuid.
  // Claude Code 2.1.x links every entry to its predecessor via parentUuid,
  // so prompts after the first turn carry one too. A user entry is a prompt
  // when its content is text-only (string or text-only array, no
  // tool_result blocks) AND it doesn't look like CLI bookkeeping
  // (command name/output/caveat/system-reminder wrappers).
  const isUserPromptInput =
    entry.type === "user" &&
    !!entry.message?.content &&
    isPlainTextContent(entry.message.content) &&
    !isCliBookkeepingText(extractTextContent(entry.message.content));

  if (isUserPromptInput) {
    // This is a user INPUT message - format like ClaudeCodeProvider does for input
    // Extract the prompt text
    let promptText = "";
    if (typeof entry.message?.content === "string") {
      promptText = entry.message.content;
    } else if (Array.isArray(entry.message?.content)) {
      const textParts = entry.message.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text);
      promptText = textParts.join("\n");
    }

    // Skip empty messages
    if (!promptText.trim()) {
      return null;
    }

    // Format as ClaudeCodeProvider does: { prompt: "...", options: {...} }
    return {
      direction: "input",
      content: JSON.stringify({
        prompt: promptText,
        options: {
          cwd: entry.cwd,
        },
      }),
      timestamp,
      metadata: null,
    };
  }

  if (entry.type === "user") {
    // This is a user message in an OUTPUT context (tool result or system message)
    // Format like ClaudeCodeProvider does: { type: "user", message: {...}, ... }

    // Check if this is a tool result message
    const hasToolResults =
      Array.isArray(entry.message?.content) &&
      entry.message.content.some((p: any) => p.type === "tool_result");

    if (hasToolResults) {
      // Tool result - store in the standard agent message format. Slim the
      // tool_use_result sidecar (originalFile / patch / redundant old/new strings)
      // the same way the live persistence path does -- nothing reads it and it's
      // the bulk of claude-code raw-log bloat.
      return {
        direction: "output",
        content: JSON.stringify(
          slimClaudeCodeChunkForStorage({
            type: "user",
            message: entry.message,
            session_id: entry.sessionId,
            uuid: entry.uuid,
            tool_use_result: (entry as any).toolUseResult,
          })
        ),
        timestamp,
        metadata: null,
      };
    }

    // Other user message in output context (e.g., local command stdout)
    return {
      direction: "output",
      content: JSON.stringify({
        type: "user",
        message: entry.message,
        session_id: entry.sessionId,
        uuid: entry.uuid,
      }),
      timestamp,
      metadata: null,
    };
  }

  if (entry.type === "assistant") {
    // Assistant message - store in the standard agent message format
    // Format: { type: "assistant", message: {...}, session_id: "...", uuid: "..." }

    // Skip if no message content
    if (!entry.message) {
      return null;
    }

    return {
      direction: "output",
      content: JSON.stringify({
        type: "assistant",
        message: entry.message,
        parent_tool_use_id: (entry as any).parentToolUseId || null,
        session_id: entry.sessionId,
        uuid: entry.uuid,
      }),
      timestamp,
      metadata: null,
    };
  }

  return null;
}

/**
 * A user entry is a real prompt when its content is text-only -- either a
 * plain string or an array whose blocks are all text. Anything carrying a
 * `tool_result` block is a tool response, not a prompt.
 */
function isPlainTextContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    if (content.length === 0) return false;
    if (content.some((b: any) => b?.type === "tool_result")) return false;
    return content.every((b: any) => b?.type === "text");
  }
  return false;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

/**
 * Detect CLI bookkeeping wrapped inside user-role messages: slash commands
 * (`<command-name>`, `<command-message>`), local command stdout, caveats,
 * and system reminders. These look like user input but are CLI-generated
 * metadata, so we route them through the system_message canonical path
 * instead of the prompt path.
 */
function isCliBookkeepingText(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("<command-name>") ||
    lower.includes("<command-message>") ||
    lower.includes("<local-command-stdout>") ||
    lower.includes("<local-command-caveat>") ||
    lower.includes("<system-reminder>") ||
    lower.includes("<nimbalyst_system_message>") ||
    lower.includes("caveat: the messages below were generated")
  );
}

/**
 * Translate an `attachment` entry (mid-session context delta) into a raw
 * output message. The canonical parser turns these into `system_message`
 * events with a deterministic summary -- see ClaudeCodeRawParser.
 */
function attachmentToMessage(
  entry: ClaudeCodeEntry
): {
  direction: "output";
  content: string;
  metadata: any;
  timestamp: string;
} | null {
  if (!entry.attachment) return null;
  return {
    direction: "output",
    content: JSON.stringify({
      type: "attachment",
      attachment: entry.attachment,
      session_id: entry.sessionId,
      uuid: entry.uuid,
    }),
    timestamp: entry.timestamp ?? new Date().toISOString(),
    metadata: null,
  };
}

/**
 * Translate a top-level `system` entry into a raw output message that the
 * canonical parser renders as a system_message.
 */
function systemEntryToMessage(
  entry: ClaudeCodeEntry
): {
  direction: "output";
  content: string;
  metadata: any;
  timestamp: string;
} | null {
  if (!entry.message) return null;
  const content = entry.message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
      ? content
          .filter(
            (part: any) =>
              part?.type === "text" && typeof part.text === "string"
          )
          .map((part: any) => part.text)
          .join("\n")
      : "";
  if (!text.trim()) return null;
  return {
    direction: "output",
    content: JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
      session_id: entry.sessionId,
      uuid: entry.uuid,
    }),
    timestamp: entry.timestamp ?? new Date().toISOString(),
    metadata: null,
  };
}
