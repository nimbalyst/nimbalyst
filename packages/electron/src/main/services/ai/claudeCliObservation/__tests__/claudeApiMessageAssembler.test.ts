import { describe, it, expect } from "vitest";
import {
  ClaudeApiMessageAssembler,
  type AssembledAssistantMessage,
} from "../claudeApiMessageAssembler";
import type { SSEEvent } from "../sseExtractor";

/** Build a parsed SSE event the way extractSSEEvents would. */
function sse(obj: Record<string, unknown>, event?: string): SSEEvent {
  return { event, data: JSON.stringify(obj), parsed: obj };
}

function collect(events: SSEEvent[]): AssembledAssistantMessage[] {
  const out: AssembledAssistantMessage[] = [];
  const asm = new ClaudeApiMessageAssembler((m) => out.push(m));
  events.forEach((e) => asm.processSSE(e));
  return out;
}

describe("ClaudeApiMessageAssembler", () => {
  it("assembles a text turn into one whole assistant message on message_stop", () => {
    const msgs = collect([
      sse({ type: "message_start", message: { id: "msg_1", model: "claude-opus-4-8", usage: { input_tokens: 12 } } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      sse({ type: "message_stop" }),
    ]);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      id: "msg_1",
      role: "assistant",
      model: "claude-opus-4-8",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Hello world" }],
    });
    expect(msgs[0].usage.inputTokens).toBe(12);
    expect(msgs[0].usage.outputTokens).toBe(5);
  });

  it("assembles a tool_use turn with input reassembled from input_json_delta", () => {
    const msgs = collect([
      sse({ type: "message_start", message: { id: "msg_2", model: "m", usage: {} } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_9", name: "Bash" } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"ls -la"}' } }),
      sse({ type: "content_block_stop", index: 1 }),
      sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }),
      sse({ type: "message_stop" }),
    ]);

    expect(msgs).toHaveLength(1);
    const m = msgs[0];
    expect(m.stopReason).toBe("tool_use");
    expect(m.content).toHaveLength(2);
    expect(m.content[0]).toEqual({ type: "text", text: "Let me check." });
    expect(m.content[1]).toEqual({ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "ls -la" } });
  });

  it("assembles a thinking block", () => {
    const msgs = collect([
      sse({ type: "message_start", message: { id: "msg_3", model: "m" } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm..." } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_stop" }),
    ]);
    expect(msgs[0].content[0]).toEqual({ type: "thinking", thinking: "Hmm..." });
  });

  it("captures a thinking signature from signature_delta", () => {
    const msgs = collect([
      sse({ type: "message_start", message: { id: "msg_sig", model: "m" } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_stop" }),
    ]);
    expect(msgs[0].content[0]).toEqual({ type: "thinking", thinking: "reasoning", signature: "sig-abc" });
  });

  it("preserves a redacted_thinking block (delivered whole)", () => {
    const msgs = collect([
      sse({ type: "message_start", message: { id: "msg_rt", model: "m" } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "ENCRYPTED==" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_stop" }),
    ]);
    expect(msgs[0].content[0]).toEqual({ type: "redacted_thinking", data: "ENCRYPTED==" });
  });

  it("assembles a server_tool_use (web_search) call and its result block", () => {
    const msgs = collect([
      sse({ type: "message_start", message: { id: "msg_ws", model: "m" } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtool_1", name: "web_search" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":' } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"claude"}' } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({
        type: "content_block_start",
        index: 1,
        content_block: { type: "web_search_tool_result", tool_use_id: "srvtool_1", content: [{ title: "r" }] },
      }),
      sse({ type: "content_block_stop", index: 1 }),
      sse({ type: "message_stop" }),
    ]);
    expect(msgs[0].content[0]).toEqual({ type: "server_tool_use", id: "srvtool_1", name: "web_search", input: { query: "claude" } });
    expect(msgs[0].content[1]).toEqual({ type: "web_search_tool_result", toolUseId: "srvtool_1", content: [{ title: "r" }] });
  });

  it("emits nothing until message_stop and handles two sequential turns", () => {
    const out: AssembledAssistantMessage[] = [];
    const asm = new ClaudeApiMessageAssembler((m) => out.push(m));
    asm.processSSE(sse({ type: "message_start", message: { id: "a", model: "m" } }));
    asm.processSSE(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    asm.processSSE(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "one" } }));
    expect(out).toHaveLength(0); // no message_stop yet
    asm.processSSE(sse({ type: "content_block_stop", index: 0 }));
    asm.processSSE(sse({ type: "message_stop" }));
    asm.processSSE(sse({ type: "message_start", message: { id: "b", model: "m" } }));
    asm.processSSE(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    asm.processSSE(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "two" } }));
    asm.processSSE(sse({ type: "content_block_stop", index: 0 }));
    asm.processSSE(sse({ type: "message_stop" }));

    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
    expect(out.map((m) => (m.content[0] as any).text)).toEqual(["one", "two"]);
  });

  it("ignores deltas with no active message (defensive)", () => {
    const out: AssembledAssistantMessage[] = [];
    const asm = new ClaudeApiMessageAssembler((m) => out.push(m));
    asm.processSSE(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "orphan" } }));
    asm.processSSE(sse({ type: "message_stop" }));
    expect(out).toHaveLength(0);
  });

  it("keeps interleaved concurrent streams isolated by requestId (CLI Task sub-agents)", () => {
    // The genuine CLI runs Task sub-agents in-process, so their /v1/messages SSE
    // interleaves with the parent's through the same proxy. Without per-request
    // isolation, parent text + sub-agent tool input cross-pollinate. requestId
    // 'p' = parent, 's' = sub-agent; deltas are deliberately interleaved.
    const out: AssembledAssistantMessage[] = [];
    const asm = new ClaudeApiMessageAssembler((m) => out.push(m));

    asm.processSSE(sse({ type: "message_start", message: { id: "parent", model: "m" } }), "p");
    asm.processSSE(sse({ type: "message_start", message: { id: "sub", model: "m" } }), "s");
    asm.processSSE(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), "p");
    asm.processSSE(sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash" } }), "s");
    asm.processSSE(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "parent says hi" } }), "p");
    asm.processSSE(sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }), "s");
    asm.processSSE(sse({ type: "content_block_stop", index: 0 }), "s");
    asm.processSSE(sse({ type: "content_block_stop", index: 0 }), "p");
    asm.processSSE(sse({ type: "message_delta", delta: { stop_reason: "tool_use" } }), "s");
    asm.processSSE(sse({ type: "message_stop" }), "s");
    asm.processSSE(sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }), "p");
    asm.processSSE(sse({ type: "message_stop" }), "p");

    // Sub-agent emits first (its message_stop came first), then parent — each clean.
    expect(out.map((m) => m.id)).toEqual(["sub", "parent"]);
    const sub = out[0];
    const parent = out[1];
    expect(sub.content).toEqual([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]);
    expect(parent.content).toEqual([{ type: "text", text: "parent says hi" }]);
  });
});
