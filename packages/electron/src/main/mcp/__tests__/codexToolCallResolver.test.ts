import { AgentMessagesRepository } from "@nimbalyst/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractCodexTurnMetadataFromRequest,
  extractToolUseIdFromMcpRequest,
  findCodexAppServerToolCallId,
  resolveAskUserQuestionPromptTargets,
  resolvePromptTargets,
  resolveRequestUserInputPromptTargets,
  resolveToolUseIdFromMcpRequest,
} from "../tools/codexToolCallResolver";

describe("codexToolCallResolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts Codex turn metadata from MCP request _meta", () => {
    expect(extractCodexTurnMetadataFromRequest({
      params: {
        _meta: {
          "x-codex-turn-metadata": {
            session_id: "session-1",
            thread_id: "thread-1",
            turn_id: "turn-1",
          },
        },
      },
    })).toEqual({
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("extracts a direct tool-use id from provider metadata", () => {
    expect(extractToolUseIdFromMcpRequest({
      params: {
        _meta: {
          "openai/toolCallId": "call_direct",
        },
      },
    })).toBe("call_direct");
  });

  it("finds the raw call id for the matching turn and tool", () => {
    const contents = [
      JSON.stringify({
        method: "item/started",
        params: {
          turnId: "turn-0",
          item: { type: "mcpToolCall", tool: "PromptForUserInput", id: "call_old" },
        },
      }),
      JSON.stringify({
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: { type: "mcpToolCall", tool: "PromptForUserInput", id: "call_match" },
        },
      }),
    ];

    expect(findCodexAppServerToolCallId(contents, "turn-1", "PromptForUserInput")).toBe("call_match");
    expect(findCodexAppServerToolCallId(contents, "turn-1", "AskUserQuestion")).toBeNull();
  });

  it("resolves the tool-use id from recent Codex app-server messages when direct metadata is missing", async () => {
    vi.spyOn(AgentMessagesRepository, "list").mockResolvedValue([
      {
        content: JSON.stringify({
          method: "item/started",
          params: {
            turnId: "turn-1",
            item: { type: "mcpToolCall", tool: "PromptForUserInput", id: "call_recovered" },
          },
        }),
      },
    ] as any);

    await expect(resolveToolUseIdFromMcpRequest({
      params: {
        _meta: {
          "x-codex-turn-metadata": {
            turn_id: "turn-1",
          },
        },
      },
    }, "session-1", "PromptForUserInput")).resolves.toBe("call_recovered");
  });

  it("resolves generic prompt targets, expanding synthetic ids", () => {
    expect(resolvePromptTargets("nimtc|call_generic|1779232811883|74")).toEqual({
      canonicalId: "nimtc|call_generic|1779232811883|74",
      rawId: "call_generic",
      waiterIds: ["nimtc|call_generic|1779232811883|74", "call_generic"],
    });
    expect(resolvePromptTargets("call_generic")).toEqual({
      canonicalId: "call_generic",
      waiterIds: ["call_generic"],
    });
  });

  it("expands synthetic prompt ids into waiter aliases", () => {
    expect(resolveRequestUserInputPromptTargets("nimtc|call_test|1779232811883|72")).toEqual({
      promptId: "nimtc|call_test|1779232811883|72",
      rawPromptId: "call_test",
      waiterPromptIds: ["nimtc|call_test|1779232811883|72", "call_test"],
    });
  });

  it("expands synthetic AskUserQuestion ids into waiter aliases", () => {
    expect(resolveAskUserQuestionPromptTargets("nimtc|call_question|1779232811883|73")).toEqual({
      questionId: "nimtc|call_question|1779232811883|73",
      rawQuestionId: "call_question",
      waiterQuestionIds: ["nimtc|call_question|1779232811883|73", "call_question"],
    });
  });

  it("keeps raw AskUserQuestion ids unchanged", () => {
    expect(resolveAskUserQuestionPromptTargets("call_question")).toEqual({
      questionId: "call_question",
      waiterQuestionIds: ["call_question"],
    });
  });
});
