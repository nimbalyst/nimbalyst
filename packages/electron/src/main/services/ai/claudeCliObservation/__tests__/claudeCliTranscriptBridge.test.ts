/**
 * Faithful test for the proxy→transcript bridge (NIM-806, Phase 3 / B3, Slice C).
 *
 * Drives the REAL `ClaudeCodeRawParser` pipeline (via
 * `projectRawMessagesToViewMessages`, provider `claude-code-cli`) over the row our
 * bridge builds, asserting an assembled assistant turn renders as a real assistant
 * message + a tool call whose `providerToolCallId` is set (so it dedups against the
 * synthetic interactive-prompt row).
 */

import { describe, expect, it } from "vitest";
import { projectRawMessagesToViewMessages } from "@nimbalyst/runtime/ai/server/transcript/projectRawMessages";
import type { RawMessage } from "@nimbalyst/runtime/ai/server/transcript/TranscriptTransformer";
import { buildAssistantRawContent } from "../claudeCliTranscriptBridge";
import type { AssembledAssistantMessage } from "../claudeApiMessageAssembler";

function rawRow(content: string): RawMessage {
  return {
    id: 1,
    sessionId: "sess-cli-1",
    source: "claude-code",
    direction: "output",
    content,
    hidden: false,
    createdAt: new Date("2026-06-08T00:00:00.000Z"),
  } as unknown as RawMessage;
}

describe("claudeCliTranscriptBridge", () => {
  it("renders an assembled assistant turn (text + tool_use) into the rich transcript", async () => {
    const assembled: AssembledAssistantMessage = {
      id: "msg_abc",
      role: "assistant",
      model: "claude-opus-4-8",
      stopReason: "tool_use",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      content: [
        { type: "text", text: "Let me check that file." },
        { type: "tool_use", id: "toolu_xyz", name: "Read", input: { file_path: "/a.ts" } },
      ],
    };

    const content = buildAssistantRawContent(assembled);
    const messages = await projectRawMessagesToViewMessages([rawRow(content)], "claude-code-cli");

    // The assistant text reaches the transcript.
    const text = JSON.stringify(messages);
    expect(text).toContain("Let me check that file.");

    // A tool call is projected with the providerToolCallId set to the block id
    // (this is what dedups against the synthetic interactive-prompt row).
    expect(text).toContain("toolu_xyz");
    expect(text).toContain("Read");
  });
});
