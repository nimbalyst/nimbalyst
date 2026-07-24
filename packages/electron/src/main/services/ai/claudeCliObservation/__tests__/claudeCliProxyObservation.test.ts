/**
 * Tests for the per-session proxy observation session (NIM-806, Phase 3 / B3,
 * Slice B/C glue). Drives a fake upstream that streams one whole assistant turn
 * and asserts:
 *   - the SSE stream is reassembled and emitted once via `onAssistantMessage`
 *   - a re-delivered turn with the same Anthropic message id is NOT re-emitted
 *     (idempotency — the proxy can replay on CLI retries)
 */

import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCliProxyObservation } from "../claudeCliProxyObservation";
import type { AssembledAssistantMessage } from "../claudeApiMessageAssembler";

function startTurnUpstream(messageId: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: message_start\ndata: {"type":"message_start","message":{"id":"${messageId}","model":"claude-x","usage":{"input_tokens":5,"output_tokens":0}}}\n\n` +
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi there"}}\n\n' +
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        );
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no upstream addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function post(port: number, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }));
    req.end();
  });
}

describe("ClaudeCliProxyObservation", () => {
  let upstream: { url: string; close: () => Promise<void> } | null = null;
  let obs: ClaudeCliProxyObservation | null = null;

  afterEach(async () => {
    if (obs) obs.stop();
    if (upstream) await upstream.close();
    obs = null;
    upstream = null;
  });

  it("reassembles a streamed turn into one assistant message and dedups re-delivery by message id", async () => {
    upstream = await startTurnUpstream("msg_dedup");

    const seen: AssembledAssistantMessage[] = [];
    obs = new ClaudeCliProxyObservation({
      sessionId: "sess-1",
      onAssistantMessage: (m) => seen.push(m),
      upstreamUrl: upstream.url,
    });
    const { baseUrl } = await obs.start();
    const port = Number(new URL(baseUrl).port);

    await post(port, "/v1/messages");
    await post(port, "/v1/messages"); // re-delivery of the same message id

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe("msg_dedup");
    expect(seen[0].content).toEqual([{ type: "text", text: "Hi there" }]);
    expect(seen[0].stopReason).toBe("end_turn");
  });
});
