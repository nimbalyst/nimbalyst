/**
 * Loopback SSE-tee proxy for the Claude CLI proxy observation backend
 * (NIM-806, Phase 3 / B3, Slice B).
 *
 * We point the genuine `claude` CLI at this proxy via `ANTHROPIC_BASE_URL`. It
 * forwards `/v1/messages` to `api.anthropic.com` BYTE-FOR-BYTE (the CLI's OAuth
 * token rides along in the headers; we never read or store it) and tees the
 * streaming SSE response into `onSSEEvent` so `ClaudeApiMessageAssembler` can
 * reassemble whole assistant turns for the rich transcript. The request body is
 * parsed for `onRequestBody` (Slice E reads `tool_result` blocks from the next
 * request's last user message).
 *
 * Two transforms on the forwarded request are load-bearing:
 *   - `accept-encoding` is STRIPPED so upstream returns uncompressed,
 *     line-parseable SSE (otherwise we'd have to gunzip before `extractSSEEvents`).
 *   - `host` is rewritten to the upstream host; `connection` is dropped.
 *
 * chunk-safe `extractSSEEvents` (sseExtractor.ts) rather than re-implementing it,
 * and treats the upstream URL as injectable so it can be tested against a fake
 * local upstream with no real Anthropic traffic.
 */

import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import { extractSSEEvents, type SSEEvent } from "./sseExtractor";
import { shouldObserveMessagesRequest } from "./messageRequestFilter";

export interface ProxyRequestInfo {
  requestId: string;
  /** False when the request was classified as non-conversational (e.g. title gen). */
  observe: boolean;
}

export interface ClaudeApiProxyCallbacks {
  /** Each teed SSE event from an observed `/v1/messages` response. */
  onSSEEvent: (event: SSEEvent, info: ProxyRequestInfo) => void;
  /** Parsed JSON body of an observed `/v1/messages` request (tool_result lives here). */
  onRequestBody?: (body: Record<string, unknown>, info: ProxyRequestInfo) => void;
  /** Proxy / upstream transport errors (never thrown — reported here). */
  onProxyError?: (error: Error) => void;
  /** Upstream rate-limit (429) / overloaded (529). */
  onRateLimit?: (info: { statusCode: number; retryAfter?: string }) => void;
  /**
   * Any non-2xx upstream response (>= 400), with a bounded slice of the error
   * body for classification. Lets the observation layer surface a failed turn in
   * the rich transcript instead of leaving a silent hang.
   */
  onUpstreamError?: (info: { statusCode: number; body?: string; retryAfter?: string }) => void;
}

/** Cap on the captured upstream error body — Anthropic error envelopes are tiny. */
const MAX_ERROR_BODY_BYTES = 16_384;

export interface ClaudeApiProxyOptions {
  /** Upstream API origin. Defaults to the real Anthropic API; injectable for tests. */
  upstreamUrl?: string;
  /** Destroy in-flight upstream work after this long. */
  upstreamTimeoutMs?: number;
}

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
/** Headers we never forward upstream (see file header for why accept-encoding matters). */
const STRIPPED_REQUEST_HEADERS = new Set(["host", "connection", "accept-encoding"]);

/**
 * Reuse upstream connections. The genuine CLI normally holds a warm keep-alive
 * connection to api.anthropic.com; without a keep-alive agent every proxied
 * request opens a fresh TLS connection, and the resulting cold-connection burst
 * at session start reliably trips a transient 429 (observed: every fresh session's
 * first request 429s, then recovers). A shared keep-alive agent restores the
 * warm-connection behavior the CLI expects.
 */
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });

let nextProxyRequestId = 0;

/**
 * Create (but do not start) the loopback proxy server. Use `startClaudeApiProxy`
 * to bind it to a random port.
 */
export function createClaudeApiProxy(
  callbacks: ClaudeApiProxyCallbacks,
  options: ClaudeApiProxyOptions = {},
): http.Server {
  const upstreamOrigin = options.upstreamUrl ?? DEFAULT_UPSTREAM;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const transport = upstreamOrigin.startsWith("https:") ? https : http;
  const onError = callbacks.onProxyError ?? (() => {});

  return http.createServer((clientReq, clientRes) => {
    const reqPath = clientReq.url || "/";
    const method = clientReq.method || "GET";
    const requestId = String(++nextProxyRequestId);

    const upstream = new URL(reqPath, upstreamOrigin);
    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(clientReq.headers)) {
      if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
      if (value !== undefined) {
        forwardHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
      }
    }
    forwardHeaders["host"] = upstream.host;

    const bodyChunks: Buffer[] = [];
    clientReq.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
    clientReq.on("end", () => {
      const body = Buffer.concat(bodyChunks);
      const isMessages = reqPath.startsWith("/v1/messages");
      let observe = isMessages;
      const info: ProxyRequestInfo = { requestId, observe };

      if (isMessages && body.length > 0) {
        try {
          const parsedBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
          observe = shouldObserveMessagesRequest(parsedBody);
          info.observe = observe;
          if (observe) callbacks.onRequestBody?.(parsedBody, info);
        } catch {
          // Non-JSON body — forward it untouched; just don't observe.
        }
      }

      let upstreamDone = false;
      const upstreamReq = transport.request(
        {
          hostname: upstream.hostname,
          port: upstream.port || (transport === https ? 443 : 80),
          path: upstream.pathname + upstream.search,
          method,
          headers: forwardHeaders,
          agent: transport === https ? keepAliveHttpsAgent : keepAliveHttpAgent,
        },
        (upstreamRes) => {
          const statusCode = upstreamRes.statusCode || 502;
          const retryAfter = upstreamRes.headers["retry-after"] as string | undefined;
          if (statusCode === 429 || statusCode === 529) {
            callbacks.onRateLimit?.({ statusCode, retryAfter });
          }

          clientRes.writeHead(statusCode, upstreamRes.headers);

          const contentType = (upstreamRes.headers["content-type"] as string) || "";
          const isSSE = contentType.includes("text/event-stream");

          if (statusCode >= 400 && callbacks.onUpstreamError) {
            // Forward the error body to the client byte-for-byte while capturing a
            // bounded slice so the observation layer can classify the failure and
            // render it in the rich transcript.
            let errBuf = "";
            upstreamRes.on("data", (chunk: Buffer) => {
              clientRes.write(chunk);
              if (errBuf.length < MAX_ERROR_BODY_BYTES) {
                errBuf += chunk.toString("utf8");
              }
            });
            upstreamRes.on("end", () => {
              upstreamDone = true;
              clientRes.end();
              callbacks.onUpstreamError?.({
                statusCode,
                body: errBuf.length > 0 ? errBuf : undefined,
                retryAfter,
              });
            });
          } else if (isMessages && observe && isSSE && statusCode === 200) {
            let sseBuf = "";
            upstreamRes.on("data", (chunk: Buffer) => {
              clientRes.write(chunk);
              sseBuf += chunk.toString("utf8");
              const { complete, remainder } = extractSSEEvents(sseBuf);
              sseBuf = remainder;
              for (const evt of complete) callbacks.onSSEEvent(evt, info);
            });
            upstreamRes.on("end", () => {
              upstreamDone = true;
              if (sseBuf.trim().length > 0) {
                const { complete } = extractSSEEvents(sseBuf + "\n\n");
                for (const evt of complete) callbacks.onSSEEvent(evt, info);
              }
              clientRes.end();
            });
          } else {
            upstreamRes.on("end", () => {
              upstreamDone = true;
            });
            upstreamRes.pipe(clientRes);
          }
        },
      );

      const destroyUpstream = (reason: Error): void => {
        if (!upstreamDone && !upstreamReq.destroyed) {
          upstreamReq.destroy(reason);
        }
      };

      // Don't pin sockets indefinitely if the caller disconnects or Anthropic stalls.
      upstreamReq.setTimeout(upstreamTimeoutMs, () => {
        destroyUpstream(new Error(`Upstream request timed out after ${upstreamTimeoutMs}ms`));
      });
      clientReq.on("aborted", () => destroyUpstream(new Error("Client request aborted")));
      clientRes.on("close", () => {
        if (!clientRes.writableEnded) {
          destroyUpstream(new Error("Client response closed before upstream completed"));
        }
      });

      upstreamReq.on("error", (err) => {
        upstreamDone = true;
        onError(err);
        if (clientRes.destroyed) return;
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "Content-Type": "application/json" });
        }
        clientRes.end(
          JSON.stringify({ error: { type: "proxy_error", message: err.message } }),
        );
      });

      if (body.length > 0) upstreamReq.write(body);
      upstreamReq.end();
    });
  });
}

/** Start the loopback proxy on a random 127.0.0.1 port. */
export function startClaudeApiProxy(
  callbacks: ClaudeApiProxyCallbacks,
  options: ClaudeApiProxyOptions = {},
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createClaudeApiProxy(callbacks, options);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        return reject(new Error("Failed to get proxy address"));
      }
      resolve({ server, port: addr.port });
    });
  });
}
