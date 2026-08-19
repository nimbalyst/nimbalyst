/**
 * The genuine `claude` CLI issues side requests on the same API connection that
 * are not part of the conversation. The proxy observation backend must skip
 * them, or their replies land in the rich transcript as assistant turns nobody
 * wrote — while never dropping a real turn, since a dropped turn goes missing
 * from the transcript silently.
 */

import { describe, expect, it } from "vitest";
import { shouldObserveMessagesRequest } from "../messageRequestFilter";

/** The instruction the prompt-suggestion fork appends (CLI 2.1.233, abridged). */
const SUGGESTION_PROMPT =
  "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\n\n" +
  "FIRST: Look at the user's recent messages and original request.\n\n" +
  "Reply with ONLY the suggestion, no quotes or explanation.";

describe("shouldObserveMessagesRequest", () => {
  it("observes an ordinary conversational turn", () => {
    expect(
      shouldObserveMessagesRequest({
        model: "claude-sonnet-5",
        messages: [
          { role: "user", content: "What is 17 * 23?" },
          { role: "assistant", content: [{ type: "text", text: "391" }] },
          {
            role: "user",
            content: [{ type: "text", text: "Now add 41.", cache_control: { type: "ephemeral" } }],
          },
        ],
      }),
    ).toBe(true);
  });

  it("skips the session-title side request", () => {
    expect(
      shouldObserveMessagesRequest({
        system: 'Generate a concise, sentence-case title. Return JSON with a single "title" field.',
        messages: [{ role: "user", content: "…transcript…" }],
        output_config: {
          format: { type: "json_schema", schema: { properties: { title: { type: "string" } }, required: ["title"] } },
        },
      }),
    ).toBe(false);
  });

  it("skips the prompt-suggestion fork, whose only tell is the trailing user message", () => {
    // Everything else on this request — headers, model, sampling params, the
    // whole conversation prefix — is identical to the real turn above.
    expect(
      shouldObserveMessagesRequest({
        model: "claude-sonnet-5",
        messages: [
          { role: "user", content: "What is 17 * 23?" },
          { role: "assistant", content: [{ type: "text", text: "391" }] },
          { role: "user", content: SUGGESTION_PROMPT },
        ],
      }),
    ).toBe(false);
  });

  it("skips it when the marker arrives as a text block rather than a bare string", () => {
    expect(
      shouldObserveMessagesRequest({
        messages: [{ role: "user", content: [{ type: "text", text: SUGGESTION_PROMPT }] }],
      }),
    ).toBe(false);
  });

  it("still observes a turn that merely quotes the marker", () => {
    // This file, and the filter it tests, get read by agents working in this
    // repo; the marker then rides along in a tool_result. A body-wide scan would
    // drop every subsequent turn of that session from the transcript.
    expect(
      shouldObserveMessagesRequest({
        messages: [
          { role: "user", content: `Why is "${SUGGESTION_PROMPT}" filtered out?` },
          { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu_1", content: SUGGESTION_PROMPT }],
          },
        ],
      }),
    ).toBe(true);
  });

  it("observes the assistant reply to a suggestion-shaped message the user actually sent", () => {
    // The fork's request always ENDS on its instruction. Once a real turn follows,
    // the conversation is the user's again.
    expect(
      shouldObserveMessagesRequest({
        messages: [
          { role: "user", content: SUGGESTION_PROMPT },
          { role: "assistant", content: [{ type: "text", text: "run the tests" }] },
          { role: "user", content: "why did you say that?" },
        ],
      }),
    ).toBe(true);
  });

  it("observes a body with no usable messages rather than guessing", () => {
    expect(shouldObserveMessagesRequest({})).toBe(true);
    expect(shouldObserveMessagesRequest({ messages: [] })).toBe(true);
    expect(shouldObserveMessagesRequest({ messages: [{ role: "assistant", content: "hi" }] })).toBe(true);
  });
});
