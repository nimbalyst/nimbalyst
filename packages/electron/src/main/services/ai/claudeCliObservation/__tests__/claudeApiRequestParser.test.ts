/**
 * Tests for parsing observed `/v1/messages` request bodies (NIM-806, Phase 3).
 *
 * The user's prompt never reaches `ai_agent_messages` on its own — the input box
 * writes keystrokes straight to the PTY. But every request body carries the full
 * conversation, so the newest user turn is the trailing `role:'user'` message.
 * We extract its text (ignoring messages that are only `tool_result` blocks,
 * which are Slice E) so the rich transcript shows the prompt above each reply.
 */

import { describe, expect, it } from "vitest";
import { extractLatestUserText, extractToolResults } from "../claudeApiRequestParser";

describe("extractLatestUserText", () => {
  it("returns the trailing user message when content is a plain string", () => {
    const body = {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: "second prompt" },
      ],
    };
    expect(extractLatestUserText(body)).toBe("second prompt");
  });

  it("joins text blocks of the trailing user message", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] }],
    };
    expect(extractLatestUserText(body)).toBe("hello\nworld");
  });

  it("ignores a trailing user message that is only tool_result blocks (Slice E owns those)", () => {
    const body = {
      messages: [
        { role: "user", content: "real prompt" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
      ],
    };
    // The newest *textual* user turn is "real prompt"; the tool_result turn is skipped.
    expect(extractLatestUserText(body)).toBe("real prompt");
  });

  it("returns null when there is no user text", () => {
    expect(extractLatestUserText({ messages: [{ role: "assistant", content: "hi" }] })).toBeNull();
    expect(extractLatestUserText({})).toBeNull();
  });
});

describe("extractToolResults", () => {
  it("pulls tool_result blocks from the trailing user message", () => {
    const body = {
      messages: [
        { role: "user", content: "prompt" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "file body" },
            { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "more" }], is_error: true },
          ],
        },
      ],
    };
    const results = extractToolResults(body);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ toolUseId: "t1", content: "file body", isError: false });
    expect(results[1]).toEqual({ toolUseId: "t2", content: "more", isError: true });
  });

  it("returns [] when the trailing user message has no tool_result blocks", () => {
    expect(extractToolResults({ messages: [{ role: "user", content: "hi" }] })).toEqual([]);
  });
});
