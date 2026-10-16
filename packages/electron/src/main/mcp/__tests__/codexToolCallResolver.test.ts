// @vitest-environment node
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

import { buildCodexToolLookupId } from "@nimbalyst/runtime/ai/server/toolLookupIds";
import { resolveGitCommitProposalPromptIdFromRows } from "../../services/ai/gitCommitProposalPromptUtils";

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

  it("correlates a nested Codex commit proposal with its exact transcript widget", async () => {
    const request = {
      id: 7,
      params: { _meta: {
        itemId: "ctc_commit",
        callId: "exec_outer",
        "x-codex-turn-metadata": { turn_id: "turn-1" },
      } },
    };
    const id = await resolveToolUseIdFromMcpRequest(request, "session-1", "developer_git_commit_proposal");
    expect(id).toBe("ctc_commit");
    const rows = [{
      content: JSON.stringify({ type: "git_commit_proposal", proposalId: id, toolUseId: id }),
      created_at: new Date(),
    }];
    const widgetId = buildCodexToolLookupId("ctc_commit", 100, 0);
    const unrelatedId = buildCodexToolLookupId("ctc_other", 100, 0);
    expect(resolveGitCommitProposalPromptIdFromRows(widgetId, rows, [], false)).toBe(id);
    expect(resolveGitCommitProposalPromptIdFromRows(unrelatedId, rows, [], false)).toBeNull();
    expect(resolveGitCommitProposalPromptIdFromRows(widgetId, [rows[0], rows[0]], [], false)).toBeNull();
  });

  it("preserves provider ID precedence and rejects malformed item IDs", () => {
    expect(extractToolUseIdFromMcpRequest({
      id: 7,
      params: { _meta: { "claudecode/toolUseId": "toolu_1", itemId: "ctc_1" } },
    })).toBe("toolu_1");
    for (const itemId of [undefined, null, "", 123, {}]) {
      expect(extractToolUseIdFromMcpRequest({ id: 7, params: { _meta: { itemId } } })).toBe("7");
    }
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
