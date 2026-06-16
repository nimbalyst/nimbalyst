/**
 * Tests for the loopback SSE-tee proxy (NIM-806, Phase 3 / B3, Slice B).
 *
 * Drives the proxy against a FAKE upstream `http.Server` (so no real Anthropic
 * traffic / no subscription billing) and asserts:
 *   - the response is forwarded back to the client byte-for-byte (passthrough)
 *   - SSE events are teed to `onSSEEvent`, parsed, even when split across writes
 *   - the request body is parsed and handed to `onRequestBody`
 *   - the `accept-encoding` header is stripped (so upstream sends uncompressed,
 *     parseable SSE) while `host` is rewritten to the upstream host
 */

import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startClaudeApiProxy } from "../claudeApiProxy";
import type { SSEEvent } from "../sseExtractor";

interface FakeUpstream {
  url: string;
  close: () => Promise<void>;
  lastHeaders: () => http.IncomingHttpHeaders;
  connectionCount: () => number;
}

/**
 * A fake Anthropic upstream that streams a fixed set of SSE blocks back,
 * deliberately splitting one event across two writes to exercise chunk-safety.
 */
function startFakeUpstream(): Promise<FakeUpstream> {
  let lastHeaders: http.IncomingHttpHeaders = {};
  let connections = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      lastHeaders = req.headers;
      // Drain the body so the socket completes.
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // message_start + a text block in one write...
        res.write(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","model":"claude-x","usage":{"input_tokens":10,"output_tokens":0}}}\n\n' +
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        );
        // ...then split a single SSE block across two writes.
        res.write("event: message_stop\nda");
        res.write('ta: {"type":"message_stop"}\n\n');
        res.end();
      });
    });
    server.on("connection", () => {
      connections += 1;
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no upstream addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        lastHeaders: () => lastHeaders,
        connectionCount: () => connections,
      });
    });
  });
}

/** A fake upstream that replies with a fixed non-2xx status + JSON error body. */
function startFakeErrorUpstream(
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<FakeUpstream> {
  let lastHeaders: http.IncomingHttpHeaders = {};
  let connections = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      lastHeaders = req.headers;
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(statusCode, { "content-type": "application/json", ...headers });
        res.end(body);
      });
    });
    server.on("connection", () => {
      connections += 1;
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no upstream addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        lastHeaders: () => lastHeaders,
        connectionCount: () => connections,
      });
    });
  });
}

function postToProxy(
  port: number,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: buf }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("claudeApiProxy", () => {
  let upstream: FakeUpstream | null = null;
  let proxy: { server: http.Server; port: number } | null = null;

  afterEach(async () => {
    if (proxy) await new Promise<void>((r) => proxy!.server.close(() => r()));
    if (upstream) await upstream.close();
    proxy = null;
    upstream = null;
  });

  it("forwards SSE byte-for-byte, tees parsed events, strips accept-encoding, and parses the request body", async () => {
    upstream = await startFakeUpstream();

    const sseEvents: SSEEvent[] = [];
    let observedBody: Record<string, unknown> | null = null;

    proxy = await startClaudeApiProxy(
      {
        onSSEEvent: (event) => sseEvents.push(event),
        onRequestBody: (body) => {
          observedBody = body;
        },
        onProxyError: (err) => {
          throw err;
        },
      },
      { upstreamUrl: upstream.url },
    );

    const reqBody = JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hi" }] });
    const res = await postToProxy(proxy.port, reqBody, { "accept-encoding": "gzip, br" });

    expect(res.status).toBe(200);
    // Passthrough: the raw SSE stream reaches the client intact.
    expect(res.body).toContain('"type":"message_start"');
    expect(res.body).toContain('"type":"message_stop"');

    // Teed + parsed, including the event split across two writes.
    const types = sseEvents.map((e) => (e.parsed as { type?: string } | undefined)?.type);
    expect(types).toContain("message_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("message_stop");

    // Request body parsed for the onRequestBody hook (tool_result lives here in Slice E).
    expect(observedBody).not.toBeNull();
    expect((observedBody as unknown as { model?: string }).model).toBe("claude-x");

    // accept-encoding stripped so upstream returns uncompressed, parseable SSE;
    // host rewritten to the upstream host.
    const upstreamHeaders = upstream.lastHeaders();
    expect(upstreamHeaders["accept-encoding"]).toBeUndefined();
    expect(upstreamHeaders["host"]).toContain("127.0.0.1");
  });

  it("reuses one upstream connection across sequential requests (keep-alive)", async () => {
    // The genuine CLI holds a warm keep-alive connection; without a keep-alive
    // agent every proxied request opened a fresh TLS connection, and the
    // cold-connection burst at session start reliably tripped a transient 429.
    upstream = await startFakeUpstream();

    proxy = await startClaudeApiProxy(
      { onSSEEvent: () => {}, onProxyError: (err) => { throw err; } },
      { upstreamUrl: upstream.url },
    );

    const reqBody = JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hi" }] });
    await postToProxy(proxy.port, reqBody, {});
    await postToProxy(proxy.port, reqBody, {});

    // Both upstream requests rode the same pooled socket.
    expect(upstream.connectionCount()).toBe(1);
  });

  it("fires onUpstreamError with the status, body, and retry-after for a non-2xx response, and still forwards the body", async () => {
    const errorBody = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limited" } });
    upstream = await startFakeErrorUpstream(429, errorBody, { "retry-after": "42" });

    const errors: Array<{ statusCode: number; body?: string; retryAfter?: string }> = [];
    proxy = await startClaudeApiProxy(
      {
        onSSEEvent: () => {},
        onUpstreamError: (info) => errors.push(info),
        onProxyError: (err) => { throw err; },
      },
      { upstreamUrl: upstream.url },
    );

    const res = await postToProxy(
      proxy.port,
      JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }),
      {},
    );

    // The error status + body still reach the client (so the CLI can retry).
    expect(res.status).toBe(429);
    expect(res.body).toContain("rate_limit_error");

    // ...and the observation layer is told, with the body + retry-after captured.
    expect(errors).toHaveLength(1);
    expect(errors[0].statusCode).toBe(429);
    expect(errors[0].retryAfter).toBe("42");
    expect(errors[0].body).toContain("rate_limit_error");
  });
});
